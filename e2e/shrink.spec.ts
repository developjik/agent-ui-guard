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
