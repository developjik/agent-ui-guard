import { describe, expect, it } from 'vitest';
import {
  generateReproSpec,
  parseTrace,
  stepsToPlan,
  TraceRecorder,
  traceToMarkdown,
} from '../src/trace.js';
import type { TraceFile } from '../src/types.js';

function record(): TraceRecorder {
  return new TraceRecorder({
    seed: 1337,
    url: 'http://localhost:5173/',
    viewport: { width: 1120, height: 780 },
  });
}

const observations = { consoleErrors: [], pageErrors: [], http5xx: [] };

describe('TraceRecorder', () => {
  it('records steps with their parameters and timing', () => {
    const recorder = record();
    const pending = recorder.begin(0, 'sendPrompt', { prompt: 'hello' });
    recorder.end(pending, { ok: true });
    const pending2 = recorder.begin(1, 'pressEscape', {});
    recorder.end(pending2, { ok: false, error: new Error('detached') });

    expect(recorder.steps).toHaveLength(2);
    expect(recorder.steps[0]).toMatchObject({
      index: 0,
      action: 'sendPrompt',
      params: { prompt: 'hello' },
      ok: true,
    });
    expect(recorder.steps[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(recorder.steps[1]).toMatchObject({ ok: false, error: 'detached' });
  });

  it('keeps the first violation only', () => {
    const recorder = record();
    recorder.setViolation({
      invariant: 'singleModalAtATime',
      kind: 'always',
      message: 'two modals',
      step: 3,
    });
    recorder.setViolation({
      invariant: 'noHttp5xx',
      kind: 'always',
      message: 'later',
      step: 4,
    });
    expect(recorder.getViolation()?.invariant).toBe('singleModalAtATime');
  });

  it('produces a trace file that round-trips through parseTrace', () => {
    const recorder = record();
    const pending = recorder.begin(0, 'openCommandPalette', {});
    recorder.end(pending, { ok: true });
    recorder.setViolation({
      invariant: 'singleModalAtATime',
      kind: 'always',
      message: '2 modals',
      step: 0,
    });
    recorder.finish();

    const file = recorder.toJSON(observations);
    const parsed = parseTrace(JSON.parse(JSON.stringify(file)));

    expect(parsed.tool).toBe('agent-ui-guard');
    expect(parsed.seed).toBe(1337);
    expect(parsed.url).toBe('http://localhost:5173/');
    expect(parsed.viewport).toEqual({ width: 1120, height: 780 });
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.violation?.invariant).toBe('singleModalAtATime');
    expect(parsed.finishedAt).toBeTruthy();
  });

  it('rejects files that are not traces', () => {
    expect(() => parseTrace({})).toThrow(/trace/i);
    expect(() => parseTrace({ tool: 'agent-ui-guard', version: 2 })).toThrow(/version/i);
    expect(() => parseTrace({ tool: 'agent-ui-guard', version: 1 })).toThrow(/url/);
  });
});

describe('stepsToPlan', () => {
  it('turns a trace into a replayable plan', () => {
    const file: TraceFile = {
      version: 1,
      tool: 'agent-ui-guard',
      toolVersion: '0.1.0',
      seed: 7,
      url: 'http://localhost/',
      viewport: null,
      createdAt: new Date(0).toISOString(),
      finishedAt: null,
      steps: [
        { index: 0, action: 'sendPrompt', params: { prompt: 'hi' }, at: 0, durationMs: 5, ok: true },
        { index: 1, action: 'pressEscape', params: {}, at: 6, durationMs: 1, ok: true },
      ],
      violation: null,
      observations,
    };
    expect(stepsToPlan(file)).toEqual([
      { action: 'sendPrompt', params: { prompt: 'hi' } },
      { action: 'pressEscape', params: {} },
    ]);
  });
});

describe('traceToMarkdown', () => {
  it('describes the violation and every step', () => {
    const recorder = record();
    recorder.end(recorder.begin(0, 'openSettings', {}), { ok: true });
    recorder.end(recorder.begin(1, 'openCommandPalette', {}), { ok: true });
    recorder.setViolation({
      invariant: 'singleModalAtATime',
      kind: 'always',
      message: '2 modals open at once',
      step: 1,
    });
    const markdown = traceToMarkdown(recorder.toJSON(observations));
    expect(markdown).toContain('# agent-ui-guard failure report');
    expect(markdown).toContain('singleModalAtATime');
    expect(markdown).toContain('2 modals open at once');
    expect(markdown).toContain('| 1 | openCommandPalette |');
    expect(markdown).toContain('Seed: `1337`');
  });
});

describe('generateReproSpec', () => {
  it('contains the recorded plan and the expected invariant', () => {
    const recorder = record();
    recorder.end(recorder.begin(0, 'sendPrompt', { prompt: 'hi' }), { ok: true });
    recorder.setViolation({
      invariant: 'toolCallBalanced',
      kind: 'always',
      message: 'orphan spinner',
      step: 0,
    });
    const spec = generateReproSpec(recorder.toJSON(observations));
    expect(spec).toContain('import { expect, test } from \'@playwright/test\'');
    expect(spec).toContain('"action": "sendPrompt"');
    expect(spec).toContain('"prompt": "hi"');
    expect(spec).toContain('toolCallBalanced');
    expect(spec).toContain('steps: PLAN.length');
  });
});
