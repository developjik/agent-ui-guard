import type {
  GuardLedgerSnapshot,
  Invariant,
  InvariantContext,
} from '../src/types.js';
import { normalizeCheckResult, type NormalizedCheck } from '../src/invariants.js';

export function makeLedger(
  overrides: Partial<GuardLedgerSnapshot> = {},
): GuardLedgerSnapshot {
  return {
    runtimeVersion: '0.1.0',
    now: overrides.now ?? 1_000,
    modals: { current: 0, peak: 0, conflicts: [], ...(overrides.modals ?? {}) },
    streaming: {
      active: false,
      activeSince: null,
      episodes: [],
      ...(overrides.streaming ?? {}),
    },
    toolCalls: overrides.toolCalls ?? [],
    orphans: overrides.orphans ?? [],
    mutations: overrides.mutations ?? 0,
    consoleErrors: overrides.consoleErrors ?? [],
    pageErrors: overrides.pageErrors ?? [],
    http5xx: overrides.http5xx ?? [],
  };
}

export async function runCheck(
  invariant: Invariant,
  ledger: GuardLedgerSnapshot,
): Promise<NormalizedCheck> {
  const context = { ledger, step: 0, trace: [] } as unknown as InvariantContext;
  return normalizeCheckResult(await invariant.check(context));
}
