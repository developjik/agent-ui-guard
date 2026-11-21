import { describe, expect, it } from 'vitest';
import {
  noConsoleOrPageErrors,
  noHttp5xx,
  noStuckStreaming,
  singleModalAtATime,
  toolCallBalanced,
} from '../src/invariants.js';
import type { ToolCallRecord } from '../src/types.js';
import { makeLedger, runCheck } from './helpers.js';

function toolCall(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    id: 'tc-1',
    name: 'web.search',
    state: 'running',
    firstSeenAt: 100,
    stateChangedAt: 100,
    terminalAt: null,
    turnId: 'turn-1',
    detachedAt: null,
    ...overrides,
  };
}

describe('singleModalAtATime', () => {
  it('passes when at most one modal was ever open', async () => {
    const result = await runCheck(
      singleModalAtATime(),
      makeLedger({ modals: { current: 1, peak: 1, conflicts: [] } }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails on a recorded conflict and names both dialogs', async () => {
    const result = await runCheck(
      singleModalAtATime(),
      makeLedger({
        modals: {
          current: 2,
          peak: 2,
          conflicts: [
            {
              at: 420,
              count: 2,
              nodes: ['dialog#settings-dialog', 'div#palette[role=dialog]'],
            },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('2');
    expect(result.message).toContain('div#palette[role=dialog]');
    expect(result.evidence).toMatchObject({ conflicts: [{ count: 2 }] });
  });

  it('reports the worst conflict when several were recorded', async () => {
    const result = await runCheck(
      singleModalAtATime(),
      makeLedger({
        modals: {
          current: 2,
          peak: 3,
          conflicts: [
            { at: 100, count: 2, nodes: ['a', 'b'] },
            { at: 900, count: 3, nodes: ['a', 'b', 'c'] },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('peak 3');
  });
});

describe('noStuckStreaming', () => {
  it('passes when nothing streamed', async () => {
    expect((await runCheck(noStuckStreaming(), makeLedger())).ok).toBe(true);
  });

  it('passes for a stream that settled inside the budget', async () => {
    const result = await runCheck(
      noStuckStreaming({ maxStreamMs: 2_000 }),
      makeLedger({
        now: 3_000,
        streaming: { active: false, activeSince: null, episodes: [{ start: 100, end: 1_200 }] },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails while a stream is still running past the budget', async () => {
    const result = await runCheck(
      noStuckStreaming({ maxStreamMs: 1_000 }),
      makeLedger({
        now: 4_000,
        streaming: { active: true, activeSince: 500, episodes: [] },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('still streaming');
    expect(result.message).toContain('3.50s');
  });

  it('fails when a finished stream ran too long', async () => {
    const result = await runCheck(
      noStuckStreaming({ maxStreamMs: 1_000 }),
      makeLedger({
        now: 10_000,
        streaming: {
          active: false,
          activeSince: null,
          episodes: [{ start: 0, end: 9_000 }],
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('exceeded');
  });
});

describe('toolCallBalanced', () => {
  it('passes when every tool call is terminal', async () => {
    const result = await runCheck(
      toolCallBalanced(),
      makeLedger({
        toolCalls: [toolCall({ state: 'done', terminalAt: 800 })],
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('passes for a tool call that is still young', async () => {
    const result = await runCheck(
      toolCallBalanced({ settleTimeoutMs: 5_000 }),
      makeLedger({ now: 900, toolCalls: [toolCall()] }),
    );
    expect(result.ok).toBe(true);
  });

  it('fails when a turn finished with a tool call still running', async () => {
    const result = await runCheck(
      toolCallBalanced(),
      makeLedger({
        now: 1_200,
        toolCalls: [toolCall()],
        orphans: [{ at: 900, turnId: 'turn-1', toolCallIds: ['tc-1'] }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('web.search');
    expect(result.message).toContain('turn finished');
  });

  it('fails when a running card is unmounted without a terminal state', async () => {
    const result = await runCheck(
      toolCallBalanced(),
      makeLedger({
        now: 2_000,
        toolCalls: [toolCall({ detachedAt: 1_500 })],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('unmounted');
  });

  it('fails when a tool call never settles', async () => {
    const result = await runCheck(
      toolCallBalanced({ settleTimeoutMs: 1_000 }),
      makeLedger({ now: 5_000, toolCalls: [toolCall()] }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('never settled');
  });
});

describe('noConsoleOrPageErrors', () => {
  it('passes on a clean page', async () => {
    expect((await runCheck(noConsoleOrPageErrors(), makeLedger())).ok).toBe(true);
  });

  it('fails on a console error', async () => {
    const result = await runCheck(
      noConsoleOrPageErrors(),
      makeLedger({
        consoleErrors: [{ at: 10, text: 'Failed to hydrate', location: 'app.js:3' }],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Failed to hydrate');
  });

  it('honours substring and RegExp ignore rules', async () => {
    const ledger = makeLedger({
      consoleErrors: [{ at: 10, text: 'Failed to load resource: favicon' }],
      pageErrors: [{ at: 11, message: 'ResizeObserver loop limit exceeded' }],
    });
    const result = await runCheck(
      noConsoleOrPageErrors({
        ignoreErrors: ['favicon', /ResizeObserver loop/],
      }),
      ledger,
    );
    expect(result.ok).toBe(true);
  });

  it('fails on an uncaught page error', async () => {
    const result = await runCheck(
      noConsoleOrPageErrors(),
      makeLedger({ pageErrors: [{ at: 5, message: 'Cannot read properties of null' }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Cannot read properties of null');
  });
});

describe('noHttp5xx', () => {
  it('passes when all responses are below 500', async () => {
    expect((await runCheck(noHttp5xx(), makeLedger())).ok).toBe(true);
  });

  it('fails and lists the failing request', async () => {
    const result = await runCheck(
      noHttp5xx(),
      makeLedger({
        http5xx: [
          { at: 50, method: 'POST', url: 'http://localhost/api/chat', status: 500 },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('POST http://localhost/api/chat');
  });
});
