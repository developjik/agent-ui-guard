import { formatMs } from './analyze.js';
import type {
  TraceFile,
  TraceStep,
  ViolationRecord,
} from './types.js';
import { TOOL_VERSION } from './version.js';

export interface TraceMeta {
  seed: number;
  url: string;
  viewport: { width: number; height: number } | null;
}

export interface PendingStep {
  index: number;
  action: string;
  params: Record<string, unknown>;
  startedAt: number;
}

/**
 * Records every step as it happens so a failing run can be written to
 * `trace.json` and replayed action-for-action.
 */
export class TraceRecorder {
  readonly steps: TraceStep[] = [];
  private violation: ViolationRecord | null = null;
  private readonly startedAt: number;
  private finishedAt: number | null = null;

  constructor(private readonly meta: TraceMeta) {
    this.startedAt = Date.now();
  }

  begin(index: number, action: string, params: Record<string, unknown>): PendingStep {
    return { index, action, params, startedAt: Date.now() - this.startedAt };
  }

  end(pending: PendingStep, outcome: { ok: boolean; error?: unknown }): TraceStep {
    const step: TraceStep = {
      index: pending.index,
      action: pending.action,
      params: pending.params,
      at: pending.startedAt,
      durationMs: Date.now() - this.startedAt - pending.startedAt,
      ok: outcome.ok,
      ...(outcome.error !== undefined
        ? { error: errorMessage(outcome.error) }
        : outcome.ok
          ? {}
          : { error: 'failed' }),
    };
    this.steps.push(step);
    return step;
  }

  setViolation(violation: ViolationRecord): void {
    if (!this.violation) this.violation = violation;
  }

  getViolation(): ViolationRecord | null {
    return this.violation;
  }

  finish(): void {
    this.finishedAt = Date.now();
  }

  toJSON(observations: TraceFile['observations']): TraceFile {
    return {
      version: 1,
      tool: 'agent-ui-guard',
      toolVersion: TOOL_VERSION,
      seed: this.meta.seed,
      url: this.meta.url,
      viewport: this.meta.viewport,
      createdAt: new Date(this.startedAt).toISOString(),
      finishedAt: this.finishedAt === null ? null : new Date(this.finishedAt).toISOString(),
      steps: this.steps.map((step) => ({ ...step })),
      violation: this.violation,
      observations,
    };
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.split('\n')[0] ?? error.message;
  return String(error);
}

/** Validate and load a `trace.json` written by a previous run. */
export function parseTrace(value: unknown): TraceFile {
  if (!value || typeof value !== 'object') {
    throw new Error('Not a trace file: expected a JSON object');
  }
  const file = value as Partial<TraceFile>;
  if (file.tool !== 'agent-ui-guard' || file.version !== 1) {
    throw new Error('Not an agent-ui-guard trace (version 1)');
  }
  if (typeof file.url !== 'string' || !Array.isArray(file.steps)) {
    throw new Error('Trace file is missing `url` or `steps`');
  }
  const steps = file.steps.map((step, index) => {
    if (!step || typeof step.action !== 'string') {
      throw new Error(`Trace step ${index} has no action name`);
    }
    return {
      index: typeof step.index === 'number' ? step.index : index,
      action: step.action,
      params: (step.params ?? {}) as Record<string, unknown>,
      at: typeof step.at === 'number' ? step.at : 0,
      durationMs: typeof step.durationMs === 'number' ? step.durationMs : 0,
      ok: step.ok !== false,
      ...(step.error ? { error: step.error } : {}),
    };
  });
  return {
    version: 1,
    tool: 'agent-ui-guard',
    toolVersion: typeof file.toolVersion === 'string' ? file.toolVersion : TOOL_VERSION,
    seed: typeof file.seed === 'number' ? file.seed : 0,
    url: file.url,
    viewport:
      file.viewport && typeof file.viewport.width === 'number'
        ? { width: file.viewport.width, height: file.viewport.height }
        : null,
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : new Date(0).toISOString(),
    finishedAt: typeof file.finishedAt === 'string' ? file.finishedAt : null,
    steps,
    violation: file.violation ?? null,
    observations: {
      consoleErrors: file.observations?.consoleErrors ?? [],
      pageErrors: file.observations?.pageErrors ?? [],
      http5xx: file.observations?.http5xx ?? [],
      ...(file.observations?.transportFrames ? { transportFrames: file.observations.transportFrames } : {}),
    },
  };
}

/** Just the actions and parameters, ready to hand to `runExploration({ plan })`. */
export function stepsToPlan(
  trace: TraceFile,
): Array<{ action: string; params: Record<string, unknown> }> {
  return trace.steps.map((step) => ({
    action: step.action,
    params: { ...step.params },
  }));
}

/** Human-readable summary written next to the trace on failure. */
export function traceToMarkdown(trace: TraceFile): string {
  const lines: string[] = [];
  lines.push('# agent-ui-guard failure report');
  lines.push('');
  if (trace.violation) {
    lines.push(`**Invariant:** \`${trace.violation.invariant}\` (${trace.violation.kind})`);
    lines.push('');
    lines.push(`**Violated at step:** ${trace.violation.step}`);
    lines.push('');
    lines.push('```');
    lines.push(trace.violation.message);
    lines.push('```');
    lines.push('');
  } else {
    lines.push('No violation was recorded.');
    lines.push('');
  }
  lines.push('## Run');
  lines.push('');
  lines.push(`- URL: ${trace.url}`);
  lines.push(`- Seed: \`${trace.seed}\``);
  lines.push(`- Steps executed: ${trace.steps.length}`);
  lines.push(`- Started: ${trace.createdAt}`);
  if (trace.viewport) {
    lines.push(`- Viewport: ${trace.viewport.width}x${trace.viewport.height}`);
  }
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('| # | action | params | at | duration | ok |');
  lines.push('|---|--------|--------|----|----------|----|');
  for (const step of trace.steps) {
    const params = JSON.stringify(step.params).replace(/\|/g, '\\|');
    lines.push(
      `| ${step.index} | ${step.action} | \`${params}\` | ${formatMs(step.at)} | ${step.durationMs}ms | ${step.ok ? 'yes' : 'no'} |`,
    );
  }
  lines.push('');
  const observations = [
    ...trace.observations.consoleErrors.map((e) => `- console.error: ${e.text}`),
    ...trace.observations.pageErrors.map((e) => `- pageerror: ${e.message}`),
    ...trace.observations.http5xx.map((e) => `- HTTP ${e.status}: ${e.method} ${e.url}`),
  ];
  if (observations.length > 0) {
    lines.push('## Page observations');
    lines.push('');
    lines.push(...observations);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * A standalone Playwright spec that replays the recorded steps. It is copied
 * next to the trace so the failure can be turned into a regression test by
 * pointing the action import at the app's real action definitions.
 */
export function generateReproSpec(trace: TraceFile): string {
  const title = trace.violation
    ? `reproduces ${trace.violation.invariant} (step ${trace.violation.step})`
    : 'replays a passing run';
  const plan = stepsToPlan(trace);
  return `/**
 * Minimal reproduction generated by agent-ui-guard ${trace.toolVersion}.
 *
 *   ${trace.createdAt}
 *   seed ${trace.seed}, ${trace.steps.length} steps
 *
 * The plan below is the exact action sequence that reached the failure, so this
 * spec fails again for the same reason. Point the ACTIONS import at the action
 * definitions your own suite uses (the ones registered in \`runExploration\`).
 */
import { expect, test } from '@playwright/test';
// TODO: import the app's action definitions, e.g. \`import { actions } from './actions';\`
import { ACTIONS } from './actions';
import { builtinInvariants, runExploration } from 'agent-ui-guard';

const URL = ${JSON.stringify(trace.url)};
const SEED = ${trace.seed};
const PLAN = ${JSON.stringify(plan, null, 2)} as Array<{
  action: string;
  params: Record<string, unknown>;
}>;

test(${JSON.stringify(title)}, async ({ page }) => {
  const result = await runExploration({
    page,
    ${trace.observations.transportFrames ? `transportReplay: ${JSON.stringify(trace.observations.transportFrames)},` : ''}
    url: URL,
    actions: ACTIONS,
    plan: PLAN,
    invariants: builtinInvariants(),
    seed: SEED,
    steps: PLAN.length,
    outputDir: 'test-results/repro',
  });

  expect(result.violation?.invariant ?? null).toBe(
    ${JSON.stringify(trace.violation?.invariant ?? null)},
  );
});
`;
}
