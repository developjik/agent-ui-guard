import { readFileSync } from 'node:fs';
import {
  always,
  builtinInvariants,
  parseTrace,
  runExploration,
  type TraceFile,
} from '../src/index.js';
import { demoActions } from '../demo/actions.js';
import { expect, test } from './fixtures.js';

test('healthy fixture survives 24 fuzzed steps and writes a trace', async ({ page, demo }) => {
  const url = await demo('healthy');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    invariants: [
      ...builtinInvariants({ maxStreamMs: 4_000, settleTimeoutMs: 4_000 }),
      always('composer is enabled while the UI is idle', async ({ page: p }) =>
        p.locator('#composer-input').isEnabled(),
      ),
    ],
    seed: 1337,
    steps: 24,
    settleTimeoutMs: 4_000,
    outputDir: 'test-results/aug-healthy',
  });

  expect(result.violation, result.violation?.message).toBeNull();
  expect(result.ok).toBe(true);
  expect(result.steps).toHaveLength(24);
  expect(result.artifacts?.trace).toBeTruthy();
  expect(result.artifacts?.repro).toBeTruthy();

  const trace = parseTrace(JSON.parse(readFileSync(result.artifacts!.trace, 'utf8'))) as TraceFile;
  expect(trace.seed).toBe(1337);
  expect(trace.steps).toHaveLength(24);
  expect(trace.violation).toBeNull();
  expect(trace.url).toBe(url);
});

test('the same seed produces the same action sequence', async ({ page, demo }) => {
  const url = await demo('healthy');

  const run = async (outputDir: string) => {
    const result = await runExploration({
      page,
      url,
      actions: demoActions,
      seed: 20261121,
      steps: 8,
      settleTimeoutMs: 4_000,
      outputDir,
    });
    return result.steps.map((step) => `${step.action}:${JSON.stringify(step.params)}`);
  };

  const first = await run('test-results/aug-determinism-a');
  // A fresh page keeps the two runs independent.
  await page.goto('about:blank');
  const second = await run('test-results/aug-determinism-b');

  expect(second).toEqual(first);
  expect(first.length).toBe(8);
});
