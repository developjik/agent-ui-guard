import { existsSync, readFileSync } from 'node:fs';
import {
  noHttp5xx,
  noStuckStreaming,
  parseTrace,
  replayTrace,
  runExploration,
  singleModalAtATime,
  toolCallBalanced,
} from '../src/index.js';
import { demoActions, PROMPTS } from '../demo/actions.js';
import { expect, test } from './fixtures.js';

test('catches two dialogs open at once and records a repro trace', async ({ page, demo }) => {
  const url = await demo('double-modal');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [{ action: 'openSettings' }, { action: 'openCommandPalette' }],
    invariants: [singleModalAtATime()],
    seed: 7,
    outputDir: 'test-results/aug-double-modal',
  });

  expect(result.violation?.invariant).toBe('singleModalAtATime');
  expect(result.violation?.kind).toBe('always');
  expect(result.violation?.step).toBe(1);
  expect(result.violation?.message).toContain('settings-dialog');
  expect(result.violation?.message).toContain('palette');

  const artifacts = result.artifacts!;
  for (const file of [artifacts.trace, artifacts.report, artifacts.repro, artifacts.dom, artifacts.screenshot]) {
    expect(file, `missing artifact ${file}`).toBeTruthy();
    expect(existsSync(file!)).toBe(true);
  }

  const trace = parseTrace(JSON.parse(readFileSync(artifacts.trace, 'utf8')));
  expect(trace.violation?.invariant).toBe('singleModalAtATime');
  expect(trace.steps.map((step) => step.action)).toEqual([
    'openSettings',
    'openCommandPalette',
  ]);

  const report = readFileSync(artifacts.report, 'utf8');
  expect(report).toContain('singleModalAtATime');
  const repro = readFileSync(artifacts.repro, 'utf8');
  expect(repro).toContain('openCommandPalette');

  // The recorded trace reproduces the same violation without the fuzzer.
  const replay = await replayTrace({
    page,
    trace,
    actions: demoActions,
    invariants: [singleModalAtATime()],
    outputDir: 'test-results/aug-double-modal-replay',
  });
  expect(replay.violation?.invariant).toBe('singleModalAtATime');
  expect(replay.violation?.step).toBe(1);
});

test('fuzzing finds the double modal without being told where it is', async ({ page, demo }) => {
  const url = await demo('double-modal');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    invariants: [singleModalAtATime()],
    seed: 13,
    steps: 20,
    settleTimeoutMs: 2_000,
    outputDir: 'test-results/aug-double-modal-fuzz',
  });

  expect(result.violation?.invariant).toBe('singleModalAtATime');
  // The driver opened Settings and then the command palette on its own.
  expect(result.violation?.step).toBe(1);
  expect(result.steps.map((step) => step.action).slice(0, 2)).toEqual([
    'openSettings',
    'openCommandPalette',
  ]);
  expect(result.steps.length).toBeLessThanOrEqual(20);
});

test('catches an orphan tool spinner when the turn closes early', async ({ page, demo }) => {
  const url = await demo('orphan-spinner');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [{ action: 'sendPrompt', params: { prompt: PROMPTS[0] } }],
    invariants: [toolCallBalanced({ settleTimeoutMs: 1_500 })],
    settleTimeoutMs: 1_500,
    outputDir: 'test-results/aug-orphan',
  });

  expect(result.violation?.invariant).toBe('toolCallBalanced');
  expect(result.violation?.message).toContain('web.search');
  expect(result.violation?.message).toMatch(/turn finished|never settled/);
});

test('catches a stream that never settles after the connection drops', async ({ page, demo }) => {
  const url = await demo('stuck-streaming');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [{ action: 'sendPrompt', params: { prompt: PROMPTS[1] } }],
    invariants: [noStuckStreaming({ maxStreamMs: 800 })],
    settleTimeoutMs: 1_200,
    outputDir: 'test-results/aug-stuck-stream',
  });

  expect(result.violation?.invariant).toBe('noStuckStreaming');
  expect(result.violation?.message).toContain('still streaming');
});

test('catches an HTTP 5xx from the model gateway', async ({ page, demo }) => {
  const url = await demo('http-500');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [
      { action: 'sendPrompt', params: { prompt: PROMPTS[0] } },
      { action: 'sendPrompt', params: { prompt: PROMPTS[2] } },
    ],
    invariants: [noHttp5xx()],
    settleTimeoutMs: 2_000,
    outputDir: 'test-results/aug-http-500',
  });

  expect(result.violation?.invariant).toBe('noHttp5xx');
  expect(result.violation?.step).toBe(1);
  expect(result.violation?.message).toContain('500');
});

test('a healthy run of the same plan does not report a violation', async ({ page, demo }) => {
  const url = await demo('healthy');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [
      { action: 'sendPrompt', params: { prompt: PROMPTS[0] } },
      { action: 'openSettings' },
      { action: 'pressEscape' },
    ],
    invariants: [singleModalAtATime(), toolCallBalanced(), noStuckStreaming()],
    settleTimeoutMs: 4_000,
    outputDir: 'test-results/aug-healthy-plan',
  });

  expect(result.violation, result.violation?.message).toBeNull();
});
