import { always, eventually, runExploration } from '../src/index.js';
import { demoActions, PROMPTS } from '../demo/actions.js';
import { expect, test } from './fixtures.js';

test('eventually() waits for a streaming answer to settle', async ({ page, demo }) => {
  const url = await demo('healthy');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [{ action: 'sendPrompt', params: { prompt: PROMPTS[0] } }],
    invariants: [
      eventually('the assistant turn reaches a terminal state', async ({ page: p }) => {
        const done = p.locator('[data-turn][data-turn-state="done"]');
        return (await done.count()) >= 2; // the seeded turn + the new one
      }).within(6_000),
    ],
    settleTimeoutMs: 4_000,
    outputDir: 'test-results/aug-dsl-eventually',
  });

  expect(result.violation, result.violation?.message).toBeNull();
});

test('eventually() reports a violation once the deadline passes', async ({ page, demo }) => {
  const url = await demo('healthy');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [{ action: 'wait', params: { ms: 50 } }],
    invariants: [eventually('a property that never holds', async () => false).within(250)],
    settleTimeoutMs: 1_000,
    outputDir: 'test-results/aug-dsl-eventually-fail',
  });

  expect(result.violation?.invariant).toBe('a property that never holds');
  expect(result.violation?.kind).toBe('eventually');
  expect(result.violation?.message).toContain('not satisfied');
});

test('always() can assert on the live page', async ({ page, demo }) => {
  const url = await demo('healthy');

  const result = await runExploration({
    page,
    url,
    actions: demoActions,
    plan: [{ action: 'sendPrompt', params: { prompt: PROMPTS[3] } }],
    invariants: [
      always('the transcript keeps at least the seeded turn', async ({ page: p }) => {
        const turns = p.locator('[data-turn]');
        return (await turns.count()) >= 1;
      }),
      always('the composer is disabled while a turn streams', async ({ page: p }) => {
        // Either idle (enabled) or streaming with the composer locked; never an
        // enabled composer with a streaming bubble on screen.
        const enabled = await p.locator('#composer-input').isEnabled();
        const streaming = await p.locator('[data-streaming="true"]').count();
        return enabled ? streaming === 0 : streaming > 0;
      }),
    ],
    settleTimeoutMs: 4_000,
    outputDir: 'test-results/aug-dsl-always',
  });

  expect(result.violation, result.violation?.message).toBeNull();
});
