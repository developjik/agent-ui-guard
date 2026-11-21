import {
  findConsoleAndPageErrors,
  findHttp5xx,
  findOrphanToolCalls,
  findStuckStreams,
  formatMs,
} from './analyze.js';
import type {
  Invariant,
  InvariantCheck,
  InvariantCheckResult,
} from './types.js';

export interface BuiltinOptions {
  /** Longest a single streaming episode may last. Default 5000ms. */
  maxStreamMs?: number;
  /** How long a tool call may stay non-terminal before it counts as orphaned. Default 5000ms. */
  settleTimeoutMs?: number;
  /** Console/page error patterns to ignore (substring or RegExp). */
  ignoreErrors?: Array<string | RegExp>;
}

/**
 * Never show more than one modal dialog at a time.
 *
 * Checked continuously in the page, so a second dialog that is mounted and
 * removed inside one frame is still reported.
 */
export function singleModalAtATime(
  options: { name?: string } = {},
): Invariant {
  return {
    name: options.name ?? 'singleModalAtATime',
    kind: 'always',
    description: 'At most one element matching the modal selector is visible at any moment.',
    check: ({ ledger }): InvariantCheckResult => {
      const conflicts = ledger.modals.conflicts;
      if (conflicts.length === 0) return true;
      let worst = conflicts[0]!;
      for (const conflict of conflicts) {
        if (conflict.count > worst.count) worst = conflict;
      }
      return {
        ok: false,
        message:
          `${conflicts.length} moment(s) had more than one modal open ` +
          `(peak ${worst.count} at t=${formatMs(worst.at)}: ${worst.nodes.join(', ')})`,
        evidence: { conflicts },
      };
    },
  };
}

/**
 * A streaming indicator must settle within `maxStreamMs`.
 *
 * Catches an SSE/WS connection that drops without clearing `aria-busy` /
 * `data-streaming`, which leaves the composer disabled forever.
 */
export function noStuckStreaming(
  options: BuiltinOptions & { name?: string } = {},
): Invariant {
  const maxStreamMs = options.maxStreamMs ?? 5_000;
  return {
    name: options.name ?? 'noStuckStreaming',
    kind: 'always',
    description: `No streaming episode lasts longer than ${maxStreamMs}ms.`,
    check: ({ ledger }): InvariantCheckResult => {
      const stuck = findStuckStreams(ledger, maxStreamMs);
      if (stuck.length === 0) return true;
      const parts = stuck.map(
        (s) =>
          `${s.active ? 'still streaming' : 'streamed'} for ${formatMs(s.durationMs)} ` +
          `(started t=${formatMs(s.start)})`,
      );
      return {
        ok: false,
        message: `${stuck.length} stream(s) exceeded ${formatMs(maxStreamMs)}: ${parts.join('; ')}`,
        evidence: { maxStreamMs, stuck },
      };
    },
  };
}

/**
 * Every rendered tool-call card must reach a terminal state
 * (`done` | `error` | `cancelled`) — no orphan spinners.
 */
export function toolCallBalanced(
  options: BuiltinOptions & { name?: string } = {},
): Invariant {
  const settleTimeoutMs = options.settleTimeoutMs ?? 5_000;
  return {
    name: options.name ?? 'toolCallBalanced',
    kind: 'always',
    description:
      'Every tool call reaches a terminal state before or when its turn ends.',
    check: ({ ledger }): InvariantCheckResult => {
      const orphans = findOrphanToolCalls(ledger, { settleTimeoutMs });
      if (orphans.length === 0) return true;
      const parts = orphans.map((o) => {
        const where = o.turnId ? ` in turn ${o.turnId}` : '';
        const why =
          o.reason === 'turn-finished'
            ? 'turn finished while it was still running'
            : o.reason === 'unmounted'
              ? 'unmounted without a terminal state'
              : `still ${o.state} after ${formatMs(o.ageMs)}`;
        return `${o.name}${where} [${o.toolCallId}]: ${why}`;
      });
      return {
        ok: false,
        message: `${orphans.length} tool call(s) never settled: ${parts.join('; ')}`,
        evidence: { settleTimeoutMs, orphans },
      };
    },
  };
}

/** No `console.error` output and no uncaught page errors. */
export function noConsoleOrPageErrors(
  options: BuiltinOptions & { name?: string } = {},
): Invariant {
  return {
    name: options.name ?? 'noConsoleOrPageErrors',
    kind: 'always',
    description: 'The page logs no console errors and throws no uncaught errors.',
    check: ({ ledger }): InvariantCheckResult => {
      const errors = findConsoleAndPageErrors(ledger, options.ignoreErrors ?? []);
      if (errors.length === 0) return true;
      const unique = Array.from(new Set(errors.map((e) => e.message)));
      return {
        ok: false,
        message: `${errors.length} console/page error(s): ${unique.slice(0, 5).join(' | ')}`,
        evidence: { errors },
      };
    },
  };
}

/** No HTTP 5xx response reaches the page. */
export function noHttp5xx(options: { name?: string } = {}): Invariant {
  return {
    name: options.name ?? 'noHttp5xx',
    kind: 'always',
    description: 'The app never receives an HTTP 5xx response.',
    check: ({ ledger }): InvariantCheckResult => {
      const errors = findHttp5xx(ledger);
      if (errors.length === 0) return true;
      const unique = Array.from(
        new Set(errors.map((e) => `${e.status} ${e.method} ${e.url}`)),
      );
      return {
        ok: false,
        message: `${errors.length} HTTP 5xx response(s): ${unique.slice(0, 5).join(' | ')}`,
        evidence: { http5xx: errors },
      };
    },
  };
}

/** The five built-in invariants, configured together. */
export function builtinInvariants(options: BuiltinOptions = {}): Invariant[] {
  return [
    singleModalAtATime(),
    noStuckStreaming(options),
    toolCallBalanced(options),
    noConsoleOrPageErrors(options),
    noHttp5xx(),
  ];
}

/**
 * A property that must hold after every step.
 *
 * ```ts
 * always('composer enabled while idle', async ({ page }) =>
 *   page.locator('#composer-input').isEnabled(),
 * )
 * ```
 */
export function always(
  name: string,
  check: InvariantCheck,
  options: { description?: string } = {},
): Invariant {
  return {
    name,
    kind: 'always',
    ...(options.description !== undefined ? { description: options.description } : {}),
    check,
  };
}

export interface EventuallyInvariant extends Invariant {
  kind: 'eventually';
  timeoutMs: number;
  /** How long the property may stay false before it is a violation. */
  within(ms: number): Invariant;
}

/**
 * A property that must become true within a deadline.
 *
 * ```ts
 * eventually('assistant answer settles', async ({ page }) =>
 *   page.locator('[data-turn-state="done"]').count(),
 * ).within(8_000)
 * ```
 */
export function eventually(
  name: string,
  check: InvariantCheck,
  options: { timeoutMs?: number; description?: string } = {},
): EventuallyInvariant {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const invariant: EventuallyInvariant = {
    name,
    kind: 'eventually',
    timeoutMs,
    ...(options.description !== undefined ? { description: options.description } : {}),
    check,
    within(ms: number): Invariant {
      return { ...invariant, timeoutMs: ms };
    },
  };
  return invariant;
}

export interface NormalizedCheck {
  ok: boolean;
  message?: string;
  evidence?: unknown;
}

/** Turn whatever a check returned into a single shape. */
export function normalizeCheckResult(
  result: InvariantCheckResult,
): NormalizedCheck {
  if (result === undefined || result === true) return { ok: true };
  if (result === false) return { ok: false };
  if (result.ok) return { ok: true, ...(result.message ? { message: result.message } : {}), ...(result.evidence !== undefined ? { evidence: result.evidence } : {}) };
  return {
    ok: false,
    ...(result.message !== undefined ? { message: result.message } : {}),
    ...(result.evidence !== undefined ? { evidence: result.evidence } : {}),
  };
}
