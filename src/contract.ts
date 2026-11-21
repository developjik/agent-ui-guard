import type { GuardContract } from './types.js';

/**
 * Every hook agent-ui-guard needs from the app under test. These are ordinary,
 * widely used ARIA/data attributes, so most streaming chat UIs already expose
 * most of them; the demo app in `demo/` is a reference implementation.
 */
export const DEFAULT_CONTRACT: GuardContract = {
  modalSelector: '[aria-modal="true"]',
  streamingSelector: '[data-streaming="true"], [aria-busy="true"]',
  toolCallSelector: '[data-tool-call]',
  toolCallIdAttr: 'data-tool-call-id',
  toolCallNameAttr: 'data-tool-call-name',
  toolCallStateAttr: 'data-state',
  terminalStates: ['done', 'error', 'cancelled'],
  turnSelector: '[data-turn]',
  turnIdAttr: 'data-turn-id',
  turnStateAttr: 'data-turn-state',
  turnCompleteStates: ['done', 'error', 'cancelled'],
};

export function resolveContract(
  overrides: Partial<GuardContract> | undefined,
): GuardContract {
  if (!overrides) return { ...DEFAULT_CONTRACT, terminalStates: [...DEFAULT_CONTRACT.terminalStates], turnCompleteStates: [...DEFAULT_CONTRACT.turnCompleteStates] };
  return {
    ...DEFAULT_CONTRACT,
    ...overrides,
    terminalStates: overrides.terminalStates ?? [...DEFAULT_CONTRACT.terminalStates],
    turnCompleteStates:
      overrides.turnCompleteStates ?? [...DEFAULT_CONTRACT.turnCompleteStates],
  };
}
