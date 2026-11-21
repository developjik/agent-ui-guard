import type {
  ConsoleErrorRecord,
  GuardLedgerSnapshot,
  HttpErrorRecord,
  OrphanToolCall,
  StreamingEpisode,
  ToolCallRecord,
} from './types.js';

/** `1.42s`, `0.85s`, `12.4s` — short and readable in failure messages. */
export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return String(ms);
  return `${(Math.max(0, ms) / 1000).toFixed(2)}s`;
}

export interface StuckStream {
  /** When the stream started (or the oldest known start). */
  start: number;
  /** How long it has been running (or ran, if it ended too late). */
  durationMs: number;
  /** `true` when the stream is still running now. */
  active: boolean;
  episode: StreamingEpisode;
}

/**
 * Streams that took longer than `maxStreamMs`, including one that is still
 * running at the moment of the check.
 */
export function findStuckStreams(
  ledger: GuardLedgerSnapshot,
  maxStreamMs: number,
): StuckStream[] {
  const out: StuckStream[] = [];
  for (const episode of ledger.streaming.episodes) {
    const end = episode.end ?? ledger.now;
    const durationMs = end - episode.start;
    if (durationMs > maxStreamMs) {
      out.push({ start: episode.start, durationMs, active: false, episode });
    }
  }
  if (ledger.streaming.active && ledger.streaming.activeSince !== null) {
    const durationMs = ledger.now - ledger.streaming.activeSince;
    if (durationMs > maxStreamMs) {
      out.push({
        start: ledger.streaming.activeSince,
        durationMs,
        active: true,
        episode: { start: ledger.streaming.activeSince, end: null },
      });
    }
  }
  return out;
}

export interface OrphanToolCallDetail {
  toolCallId: string;
  name: string;
  state: string;
  /** Why it counts as orphaned: its turn finished, it was unmounted, or it simply never settled. */
  reason: 'turn-finished' | 'unmounted' | 'never-settled';
  turnId: string | null;
  ageMs: number;
  at: number;
}

function recordById(
  records: ToolCallRecord[],
  id: string,
): ToolCallRecord | undefined {
  return records.find((r) => r.id === id);
}

/**
 * Tool calls that never reached a terminal state:
 *
 *  - the turn they belong to finished while they were still running (the
 *    classic orphan spinner),
 *  - the card was removed from the DOM without ever being marked terminal,
 *  - or they have been running longer than `settleTimeoutMs` and are still on
 *    screen when the check runs.
 */
export function findOrphanToolCalls(
  ledger: GuardLedgerSnapshot,
  options: { settleTimeoutMs: number },
): OrphanToolCallDetail[] {
  const out: OrphanToolCallDetail[] = [];
  const seen = new Set<string>();

  for (const orphan of ledger.orphans) {
    for (const id of orphan.toolCallIds) {
      const record = recordById(ledger.toolCalls, id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        toolCallId: id,
        name: record?.name ?? id,
        state: record?.state ?? 'unknown',
        reason: 'turn-finished',
        turnId: orphan.turnId,
        ageMs: ledger.now - (record?.firstSeenAt ?? orphan.at),
        at: orphan.at,
      });
    }
  }

  for (const record of ledger.toolCalls) {
    if (seen.has(record.id)) continue;
    if (record.terminalAt !== null) continue;
    if (record.detachedAt !== null) {
      seen.add(record.id);
      out.push({
        toolCallId: record.id,
        name: record.name,
        state: record.state,
        reason: 'unmounted',
        turnId: record.turnId,
        ageMs: record.detachedAt - record.firstSeenAt,
        at: record.detachedAt,
      });
      continue;
    }
    const age = ledger.now - record.firstSeenAt;
    if (age > options.settleTimeoutMs) {
      seen.add(record.id);
      out.push({
        toolCallId: record.id,
        name: record.name,
        state: record.state,
        reason: 'never-settled',
        turnId: record.turnId,
        ageMs: age,
        at: ledger.now,
      });
    }
  }

  return out;
}

export function conflictsFromLedger(
  ledger: GuardLedgerSnapshot,
): GuardLedgerSnapshot['modals']['conflicts'] {
  return ledger.modals.conflicts;
}

export interface IgnoreMatcher {
  (record: ConsoleErrorRecord): boolean;
}

/**
 * Console errors and uncaught page errors, minus anything matched by `ignore`
 * (string = substring match, RegExp = tested against the message).
 */
export function findConsoleAndPageErrors(
  ledger: GuardLedgerSnapshot,
  ignore: Array<string | RegExp> = [],
): Array<{ source: 'console' | 'pageerror'; at: number; message: string }> {
  const matches = (message: string): boolean =>
    ignore.some((rule) =>
      typeof rule === 'string' ? message.includes(rule) : rule.test(message),
    );

  const out: Array<{ source: 'console' | 'pageerror'; at: number; message: string }> = [];
  for (const record of ledger.consoleErrors) {
    const message = record.location
      ? `${record.text} (${record.location})`
      : record.text;
    if (matches(message)) continue;
    out.push({ source: 'console', at: record.at, message });
  }
  for (const record of ledger.pageErrors) {
    if (matches(record.message)) continue;
    out.push({ source: 'pageerror', at: record.at, message: record.message });
  }
  return out;
}

export function findHttp5xx(
  ledger: GuardLedgerSnapshot,
): HttpErrorRecord[] {
  return ledger.http5xx.slice();
}

/** One-line summary of a ledger, handy in logs and reports. */
export function summarizeLedger(ledger: GuardLedgerSnapshot): string {
  const terminal = ledger.toolCalls.filter((t) => t.terminalAt !== null).length;
  const open = ledger.toolCalls.length - terminal;
  return [
    `t=${formatMs(ledger.now)}`,
    `modals=${ledger.modals.current}(peak ${ledger.modals.peak}, conflicts ${ledger.modals.conflicts.length})`,
    `streaming=${ledger.streaming.active ? 'yes' : 'no'}(episodes ${ledger.streaming.episodes.length})`,
    `toolCalls=${ledger.toolCalls.length}(open ${open}, orphans ${ledger.orphans.length})`,
    `consoleErrors=${ledger.consoleErrors.length}`,
    `pageErrors=${ledger.pageErrors.length}`,
    `http5xx=${ledger.http5xx.length}`,
  ].join(' ');
}

export type { OrphanToolCall };
