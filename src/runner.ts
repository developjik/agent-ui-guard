import type { Page } from '@playwright/test';
import type { ActionDefinition } from './actions.js';
import { readTraceFile, writeArtifacts, type ArtifactPaths } from './artifacts.js';
import { formatMs } from './analyze.js';
import { Guard } from './guard.js';
import { normalizeCheckResult } from './invariants.js';
import type { NormalizedCheck } from './invariants.js';
import { createRng } from './rng.js';
import { errorMessage, stepsToPlan, TraceRecorder } from './trace.js';
import type {
  GuardContract,
  GuardLedgerSnapshot,
  Invariant,
  InvariantContext,
  TraceFile,
  TraceStep,
  ViolationRecord,
} from './types.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** One recorded action, used to replay a run exactly. */
export interface StepPlan {
  action: string;
  params?: Record<string, unknown>;
}

export interface StepInfo {
  index: number;
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  error?: string;
  durationMs: number;
}

export interface RunOptions {
  webSocket?: import('./guard.js').GuardOptions['webSocket'];
  page: Page;
  /** Where the app under test lives. */
  url: string;
  /** Everything a user can do; picked by weight unless `plan` is given. */
  actions: ActionDefinition[];
  /** Properties that must hold. An empty list still records a trace. */
  invariants?: Invariant[];
  /** Seed for the action driver. Recorded in the trace. Default: random. */
  seed?: number;
  /** Number of steps. Default: `plan.length`, else 30. */
  steps?: number;
  /**
   * A fixed sequence of actions (usually from a `trace.json`). When given, the
   * fuzzer does not pick actions itself.
   */
  plan?: StepPlan[];
  /** Stop starting new steps after this long. */
  timeBudgetMs?: number;
  /** How long the UI may stay busy after an action. Default 5000ms. */
  settleTimeoutMs?: number;
  /** How long to wait for the first sign of activity after an action. Default 250ms. */
  activityGraceMs?: number;
  /** Poll interval for `eventually` invariants. Default 100ms. */
  pollIntervalMs?: number;
  /** Parent folder for artifacts. Default `.agent-ui-guard`. */
  outputDir?: string;
  /** Write `trace.json` / `report.md` / `repro.spec.ts`. Default true. */
  writeArtifacts?: boolean;
  /** Capture `failure.png` on violation. Default true. */
  screenshotOnFailure?: boolean;
  /** Rethrow action errors instead of recording them as no-ops. Default false. */
  strictActions?: boolean;
  /** Throw instead of returning a result with `ok: false`. Default false. */
  throwOnViolation?: boolean;
  /** Override parts of the DOM contract. */
  contract?: Partial<GuardContract>;
  /** Console error patterns to ignore. */
  ignoreErrors?: Array<string | RegExp>;
  gotoOptions?: Parameters<Page['goto']>[1];
  onStep?: (info: StepInfo) => void;
  onViolation?: (violation: ViolationRecord) => void;
}

export interface RunResult {
  ok: boolean;
  seed: number;
  steps: TraceStep[];
  violation: ViolationRecord | null;
  /** Final observations, when the page was still reachable. */
  ledger: GuardLedgerSnapshot | null;
  artifacts?: ArtifactPaths;
  durationMs: number;
}

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function pickAction(
  actions: ActionDefinition[],
  rng: ReturnType<typeof createRng>,
): ActionDefinition {
  return rng.weighted(actions, (action) => action.weight ?? 1);
}

/**
 * Drives a streaming agent UI with weighted random (or recorded) actions and
 * fails as soon as one invariant breaks.
 *
 * ```ts
 * const result = await runExploration({
 *   page,
 *   url: 'http://localhost:3000',
 *   actions: demoActions,
 *   invariants: builtinInvariants(),
 *   seed: 1337,
 *   steps: 40,
 * });
 * expect(result.violation).toBeNull();
 * ```
 */
export async function runExploration(options: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const seed = options.seed ?? randomSeed();
  const rng = createRng(seed);
  const plan = options.plan;
  const stepCount = options.steps ?? plan?.length ?? 30;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const outputDir = options.outputDir ?? '.agent-ui-guard';
  const { page } = options;

  const actionsByName = new Map<string, ActionDefinition>();
  for (const action of options.actions) actionsByName.set(action.name, action);
  if (plan) {
    for (const planned of plan) {
      if (!actionsByName.has(planned.action)) {
        throw new Error(
          `Plan refers to unknown action "${planned.action}". Known actions: ${Array.from(actionsByName.keys()).join(', ')}`,
        );
      }
    }
  }
  if (actionsByName.size === 0) {
    throw new Error('runExploration needs at least one action');
  }

  const invariantList = options.invariants ?? [];
  const alwaysList = invariantList.filter((invariant) => invariant.kind === 'always');
  const eventuallyList = invariantList.filter((invariant) => invariant.kind === 'eventually');
  const armed = new Map<string, number>();
  const recorder = new TraceRecorder({
    seed,
    url: options.url,
    viewport: page.viewportSize(),
  });

  const guard = await Guard.install(page, {
    contract: options.contract,
    webSocket: options.webSocket,
    settleTimeoutMs: options.settleTimeoutMs,
    activityGraceMs: options.activityGraceMs,
    ignoreErrors: options.ignoreErrors,
  });

  const buildContext = (step: number, ledger: GuardLedgerSnapshot): InvariantContext => ({
    page,
    step,
    ledger,
    trace: recorder.steps,
  });

  const checkAlways = async (step: number): Promise<ViolationRecord | null> => {
    if (alwaysList.length === 0) return null;
    const ledger = await guard.ledger();
    for (const invariant of alwaysList) {
      let checked;
      try {
        checked = normalizeCheckResult(
          await invariant.check(buildContext(step, ledger)),
        );
      } catch (error) {
        checked = { ok: false, message: `check threw: ${errorMessage(error)}` };
      }
      if (checked.ok) continue;
      return {
        invariant: invariant.name,
        kind: 'always',
        message:
          checked.message ??
          `${invariant.name} did not hold after step ${step}`,
        step,
        ...(checked.evidence !== undefined ? { evidence: checked.evidence } : {}),
      };
    }
    return null;
  };

  const checkEventually = async (step: number): Promise<ViolationRecord | null> => {
    for (const invariant of eventuallyList) {
      if (!armed.has(invariant.name)) armed.set(invariant.name, Date.now());
      const timeoutMs = invariant.timeoutMs ?? 5_000;
      const deadline = (armed.get(invariant.name) ?? Date.now()) + timeoutMs;
      let last: NormalizedCheck = { ok: false };
      while (true) {
        const ledger = await guard.ledger();
        try {
          last = normalizeCheckResult(
            await invariant.check(buildContext(step, ledger)),
          );
        } catch (error) {
          last = { ok: false, message: `check threw: ${errorMessage(error)}`, evidence: undefined };
        }
        if (last.ok) {
          armed.delete(invariant.name);
          break;
        }
        if (Date.now() >= deadline) {
          return {
            invariant: invariant.name,
            kind: 'eventually',
            message:
              last.message ??
              `${invariant.name} was still not satisfied after ${formatMs(timeoutMs)}`,
            step,
            ...(last.evidence !== undefined ? { evidence: last.evidence } : {}),
          };
        }
        await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
      }
    }
    return null;
  };

  const finish = async (
    violation: ViolationRecord | null,
  ): Promise<RunResult> => {
    if (violation) recorder.setViolation(violation);
    recorder.finish();
    let ledger: GuardLedgerSnapshot | null = null;
    try {
      ledger = await guard.ledger();
    } catch {
      ledger = null;
    }
    const traceFile: TraceFile = recorder.toJSON(guard.nodeObservations());
    let artifacts: ArtifactPaths | undefined;
    if (options.writeArtifacts !== false) {
      artifacts = await writeArtifacts({
        outputDir,
        trace: traceFile,
        page,
        screenshot: options.screenshotOnFailure !== false,
      });
    }
    guard.detach();
    const result: RunResult = {
      ok: violation === null,
      seed,
      steps: recorder.steps.slice(),
      violation,
      ledger,
      ...(artifacts ? { artifacts } : {}),
      durationMs: Date.now() - startedAt,
    };
    if (violation) {
      options.onViolation?.(violation);
      if (options.throwOnViolation) {
        const error = new Error(
          `agent-ui-guard: ${violation.invariant} violated at step ${violation.step}: ${violation.message}`,
        );
        (error as Error & { result?: RunResult }).result = result;
        throw error;
      }
    }
    return result;
  };

  await page.goto(options.url, options.gotoOptions ?? { waitUntil: 'domcontentloaded' });
  await guard.ready();
  await guard.settle({ timeoutMs: options.settleTimeoutMs ?? 2_000, activityGraceMs: 100 });

  const initial = await checkAlways(0);
  if (initial) return finish(initial);

  for (let step = 0; step < stepCount; step += 1) {
    if (
      options.timeBudgetMs !== undefined &&
      Date.now() - startedAt > options.timeBudgetMs
    ) {
      break;
    }

    const planned = plan?.[step];
    const action = planned
      ? actionsByName.get(planned.action)!
      : pickAction(options.actions, rng);
    const params =
      planned?.params ?? (action.params ? action.params(rng) : {});

    const pending = recorder.begin(step, action.name, params);
    let ok = true;
    let actionError: unknown;
    try {
      await action.run({ page, step, params, rng });
    } catch (error) {
      ok = false;
      actionError = error;
    }
    const traceStep = recorder.end(
      pending,
      ok ? { ok: true } : { ok: false, error: actionError },
    );
    options.onStep?.({
      index: step,
      action: action.name,
      params,
      ok: traceStep.ok,
      ...(traceStep.error ? { error: traceStep.error } : {}),
      durationMs: traceStep.durationMs,
    });
    if (!ok && options.strictActions) {
      recorder.finish();
      throw actionError;
    }

    await guard.settle({
      timeoutMs: options.settleTimeoutMs,
      activityGraceMs: options.activityGraceMs,
    });

    const alwaysViolation = await checkAlways(step);
    if (alwaysViolation) return finish(alwaysViolation);

    const eventuallyViolation = await checkEventually(step);
    if (eventuallyViolation) return finish(eventuallyViolation);
  }

  // Let pending `eventually` invariants reach their deadline before concluding.
  const finalViolation = await checkEventually(Math.max(0, recorder.steps.length - 1));
  return finish(finalViolation);
}

export interface ReplayOptions {
  page: Page;
  trace: TraceFile;
  actions: ActionDefinition[];
  invariants?: Invariant[];
  outputDir?: string;
  settleTimeoutMs?: number;
  contract?: Partial<GuardContract>;
  ignoreErrors?: Array<string | RegExp>;
}

/** Re-run the exact action sequence of a recorded trace. */
export async function replayTrace(options: ReplayOptions): Promise<RunResult> {
  return runExploration({
    page: options.page,
    url: options.trace.url,
    actions: options.actions,
    invariants: options.invariants ?? [],
    plan: stepsToPlan(options.trace),
    steps: options.trace.steps.length,
    seed: options.trace.seed,
    outputDir: options.outputDir ?? '.agent-ui-guard/replay',
    ...(options.settleTimeoutMs !== undefined
      ? { settleTimeoutMs: options.settleTimeoutMs }
      : {}),
    ...(options.contract ? { contract: options.contract } : {}),
    ...(options.ignoreErrors ? { ignoreErrors: options.ignoreErrors } : {}),
  });
}

/** Load a `trace.json` from disk and replay it. */
export async function replayTraceFile(
  tracePath: string,
  options: Omit<ReplayOptions, 'trace'>,
): Promise<RunResult> {
  const trace = await readTraceFile(tracePath);
  return replayTrace({ ...options, trace });
}
