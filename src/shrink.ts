import type { Browser, BrowserContext } from '@playwright/test';
import { writeArtifacts, type ArtifactPaths } from './artifacts.js';
import { runExploration, type RunOptions } from './runner.js';
import { stepsToPlan } from './trace.js';
import type { TraceFile } from './types.js';

export interface ShrinkOptions {
  /** Entire shrinking operation, including verification and artifact writing. Default 30000. */
  timeBudgetMs?: number;
  /** Replay attempts, including original and final confirmation. Default 50. */
  maxAttempts?: number;
}
export interface ShrinkResult {
  status: 'reduced' | 'unchanged' | 'unreproducible' | 'timed-out' | 'attempt-limit' | 'error';
  originalSteps: number;
  reducedSteps: number;
  attempts: number;
  durationMs: number;
  reason?: string;
  artifacts?: ArtifactPaths;
}

/** Best-effort ddmin in fresh contexts; never edits or discards original evidence. */
export async function shrinkTrace(input: {
  trace: TraceFile;
  browser: Browser;
  run: Omit<RunOptions, 'page' | 'plan' | 'steps' | 'shrink'>;
  options?: ShrinkOptions;
}): Promise<ShrinkResult> {
  const start = Date.now();
  const budget = input.options?.timeBudgetMs ?? 30000;
  const max = input.options?.maxAttempts ?? 50;
  if (!Number.isFinite(budget) || budget <= 0 || !Number.isInteger(max) || max < 2) throw new Error('shrink needs a positive time budget and at least two attempts');
  const deadline = start + budget;
  const original = stepsToPlan(input.trace);
  let attempts = 0;
  let active: BrowserContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (status: ShrinkResult['status'], reason?: string, artifacts?: ArtifactPaths): ShrinkResult => ({ status, originalSteps: original.length, reducedSteps: status === 'reduced' ? best.length : original.length, attempts, durationMs: Date.now() - start, ...(reason ? { reason } : {}), ...(artifacts ? { artifacts } : {}) });
  let best = original;
  if (!input.trace.violation) return finish('unreproducible', 'Original trace has no violation');
  const target = input.trace.violation;
  const checkBudget = () => {
    if (Date.now() + 10 >= deadline) throw new Error('shrink-timeout');
    if (attempts >= max) throw new Error('shrink-attempt-limit');
  };
  const replay = async (plan: typeof original, publish = false): Promise<boolean> => {
    checkBudget(); attempts++;
    let expired = false;
    const operation = async (): Promise<boolean> => {
      active = await input.browser.newContext({ ...(input.trace.viewport ? { viewport: input.trace.viewport } : {}) });
      const context = active;
      try {
        if (expired || Date.now() >= deadline) throw new Error('shrink-timeout');
        const page = await context.newPage();
        const result = await runExploration({
          ...input.run, page, url: input.trace.url, seed: input.trace.seed, plan, steps: plan.length,
          ...(input.trace.observations.transportFrames ? { transportReplay: input.trace.observations.transportFrames } : {}),
          shrink: false, writeArtifacts: false, throwOnViolation: false, onStep: undefined, onViolation: undefined,
          gotoOptions: { ...input.run.gotoOptions, timeout: Math.max(1, deadline - Date.now()) },
          timeBudgetMs: Math.max(1, deadline - Date.now()),
        });
        if (expired || Date.now() + 10 >= deadline) throw new Error('shrink-timeout');
        const matched = result.violation?.invariant === target.invariant && result.violation?.kind === target.kind && !result.violation?.message.startsWith('check threw:');
        if (matched && publish) {
          const trace: TraceFile = { ...input.trace, createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: result.steps, violation: result.violation, observations: { consoleErrors: result.ledger?.consoleErrors ?? [], pageErrors: result.ledger?.pageErrors ?? [], http5xx: result.ledger?.http5xx ?? [], ...(input.trace.observations.transportFrames ? { transportFrames: input.trace.observations.transportFrames } : {}) } };
          published = await writeArtifacts({ outputDir: `${input.run.outputDir ?? '.agent-ui-guard'}/shrunk`, trace, page, screenshot: input.run.screenshotOnFailure !== false });
        }
        return matched;
      } finally {
        await Promise.race([context.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 250))]); active = undefined;
      }
    };
    return await Promise.race([operation(), new Promise<never>((_, reject) => { timer = setTimeout(() => { expired = true; reject(new Error('shrink-timeout')); void active?.close().catch(() => undefined); }, Math.max(1, deadline - Date.now())); })]).finally(() => { if (timer) clearTimeout(timer); });
  };
  let published: ArtifactPaths | undefined;
  try {
    if (!await replay(best)) return finish('unreproducible', 'Original plan did not reproduce the same invariant');
    let granularity = 2;
    while (best.length > 0) {
      let reduced = false;
      const chunk = Math.ceil(best.length / granularity);
      for (let offset = 0; offset < best.length; offset += chunk) {
        // Reserve one attempt to confirm/publish the final candidate.
        if (attempts >= max - 1) return finish('attempt-limit', 'Original artifacts retained');
        const candidate = [...best.slice(0, offset), ...best.slice(offset + chunk)];
        if (await replay(candidate)) { best = candidate; granularity = Math.max(2, granularity - 1); reduced = true; break; }
      }
      if (reduced) continue;
      if (granularity >= best.length) break;
      granularity = Math.min(best.length, granularity * 2);
    }
    if (best.length === original.length) return finish('unchanged');
    if (!await replay(best, true)) return finish('unreproducible', 'Final candidate did not reproduce; original artifacts retained');
    return finish('reduced', undefined, published);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (Date.now() >= deadline || reason === 'shrink-timeout') return finish('timed-out', 'Time budget exhausted; original artifacts retained');
    if (reason === 'shrink-attempt-limit') return finish('attempt-limit', 'Attempt limit reached; original artifacts retained');
    return finish('error', reason);
  } finally {
    if (timer) clearTimeout(timer);
    if (active) void active.close().catch(() => undefined);
  }
}
