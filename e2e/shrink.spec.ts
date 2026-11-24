import { readFile } from 'node:fs/promises';
import { demoActions } from '../demo/actions.js';
import { parseTrace, replayTrace, runExploration, shrinkTrace, singleModalAtATime } from '../src/index.js';
import { expect, test } from './fixtures.js';

test('shrinks double-modal and replays saved shorter trace; original evidence remains', async ({ page, demo }) => {
  const result = await runExploration({ page, url: await demo('double-modal'), actions: demoActions,
    plan: [{ action: 'pressEscape' }, { action: 'pressEscape' }, { action: 'openSettings' }, { action: 'openCommandPalette' }],
    invariants: [singleModalAtATime()], activityGraceMs: 1,
    shrink: { timeBudgetMs: 15000, maxAttempts: 30 }, outputDir: 'test-results/shrink-double' });
  expect(result.steps).toHaveLength(4);
  expect(result.shrink?.status, result.shrink?.reason).toBe('reduced');
  expect(result.shrink?.reducedSteps).toBe(2);
  const original = parseTrace(JSON.parse(await readFile(result.artifacts!.trace, 'utf8')));
  const shortened = parseTrace(JSON.parse(await readFile(result.shrink!.artifacts!.trace, 'utf8')));
  expect(original.steps).toHaveLength(4);
  expect(shortened.steps.map(s => s.action)).toEqual(['openSettings', 'openCommandPalette']);
  expect(await readFile(result.shrink!.artifacts!.repro, 'utf8')).not.toContain('pressEscape');
  expect((await replayTrace({ page, trace: shortened, actions: demoActions, invariants: [singleModalAtATime()], outputDir: 'test-results/shrink-replay' })).violation?.invariant).toBe('singleModalAtATime');
});

test('unreproducible original retains original artifacts and says why', async ({ page, browser, demo }) => {
  const result = await runExploration({ page, url: await demo('double-modal'), actions: demoActions,
    plan: [{ action: 'openSettings' }, { action: 'openCommandPalette' }],
    invariants: [singleModalAtATime()], activityGraceMs: 1, outputDir: 'test-results/shrink-original' });
  const raw = await readFile(result.artifacts!.trace, 'utf8');
  const trace = parseTrace(JSON.parse(raw));
  const shrink = await shrinkTrace({ trace, browser, run: { url: trace.url, actions: demoActions, invariants: [], activityGraceMs: 1 } });
  expect(shrink.status).toBe('unreproducible');
  expect(shrink.artifacts).toBeUndefined();
  expect(await readFile(result.artifacts!.trace, 'utf8')).toBe(raw);
});

test('time and attempt bounds keep original; replay errors are not accepted as the same bug', async ({ page, browser, demo }) => {
  const result = await runExploration({ page, url: await demo('double-modal'), actions: demoActions,
    plan: [{ action: 'pressEscape' }, { action: 'openSettings' }, { action: 'openCommandPalette' }],
    invariants: [singleModalAtATime()], activityGraceMs: 1, outputDir: 'test-results/shrink-bounds' });
  const raw = await readFile(result.artifacts!.trace, 'utf8');
  const trace = parseTrace(JSON.parse(raw));
  const run = { url: trace.url, actions: demoActions, invariants: [singleModalAtATime()], activityGraceMs: 1 };
  const timeout = await shrinkTrace({ trace, browser, run, options: { timeBudgetMs: 1 } });
  expect(timeout.status).toBe('timed-out');
  const limited = await shrinkTrace({ trace, browser, run, options: { maxAttempts: 2 } });
  expect(limited.status).toBe('attempt-limit');
  expect(limited.attempts).toBeLessThanOrEqual(2);
  const throws = await shrinkTrace({ trace, browser, run: { ...run, invariants: [{ name: 'singleModalAtATime', kind: 'always', check: () => { throw new Error('broken check'); } }] } });
  expect(throws.status).toBe('unreproducible');
  expect(await readFile(result.artifacts!.trace, 'utf8')).toBe(raw);
});


test('deadline interrupts an already-started action and closes its context', async ({ page, browser, demo }) => {
  const result = await runExploration({ page, url: await demo('double-modal'), actions: demoActions,
    plan: [{ action: 'openSettings' }, { action: 'openCommandPalette' }],
    invariants: [singleModalAtATime()], activityGraceMs: 1, writeArtifacts: false });
  const trace = { version: 1 as const, tool: 'agent-ui-guard' as const, toolVersion: '0.1.1', seed: result.seed,
    url: page.url(), viewport: null, createdAt: '', finishedAt: null, steps: result.steps, violation: result.violation,
    observations: { consoleErrors: [], pageErrors: [], http5xx: [] } };
  let started = false;
  const count = browser.contexts().length;
  const before = Date.now();
  const shrink = await shrinkTrace({ trace, browser, options: { timeBudgetMs: 700 }, run: { url: trace.url,
    actions: demoActions.map(a => a.name === 'openSettings' ? { ...a, run: async ({ page: p }) => { started = true; await p.waitForTimeout(10000); } } : a),
    invariants: [singleModalAtATime()], activityGraceMs: 1 } });
  expect(started).toBe(true);
  expect(shrink.status).toBe('timed-out');
  expect(Date.now() - before).toBeLessThan(2500);
  await expect.poll(() => browser.contexts().length).toBe(count);
});

test('no-artifacts also suppresses successful reduction files', async ({ page, demo }) => {
  const url = await demo('double-modal');
  const result = await runExploration({ page, url, actions: demoActions, plan: [{ action: 'pressEscape' }, { action: 'openSettings' }, { action: 'openCommandPalette' }],
    invariants: [singleModalAtATime()], activityGraceMs: 1, writeArtifacts: false, shrink: { timeBudgetMs: 10000 } });
  expect(result.artifacts).toBeUndefined();
  expect(result.shrink?.status).toBe('reduced');
  expect(result.shrink?.artifacts).toBeUndefined();
});
