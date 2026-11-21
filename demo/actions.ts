import {
  clickTarget,
  defineAction,
  pressEscape,
  sendPrompt,
  waitRandom,
  type ActionDefinition,
} from '../src/actions.js';

/** Prompts that exercise short answers, tool calls and plain text. */
export const PROMPTS = [
  'What changed in v2?',
  'Summarise the open incident',
  'Write a short checklist for the release',
  'Why did the stream stall last week?',
] as const;

/**
 * The action set the demo fixture understands. Copy this shape for your own
 * app: one `ActionDefinition` per thing a user can do.
 */
export const demoActions: ActionDefinition[] = [
  sendPrompt('#composer-input', PROMPTS, { weight: 6 }),
  defineAction({
    name: 'openCommandPalette',
    weight: 3,
    description: 'Open the command palette with Ctrl+K',
    async run({ page }) {
      await page.keyboard.press('Control+k');
    },
  }),
  clickTarget('openSettings', '#open-settings', { weight: 2 }),
  pressEscape('pressEscape', 3),
  defineAction({
    name: 'switchSession',
    weight: 2,
    description: 'Switch to another session',
    params: (rng) => ({ slot: rng.int(3) }),
    async run({ page, params }) {
      const buttons = page.locator('#session-list .session');
      const count = await buttons.count();
      if (count === 0) return;
      const slot = typeof params.slot === 'number' ? params.slot : 0;
      await buttons.nth(slot % count).click({ timeout: 1_000 });
    },
  }),
  clickTarget('cancelTurn', '#cancel-turn', { weight: 1, description: 'Stop the streaming turn' }),
  clickTarget('newSession', '#new-session', { weight: 1 }),
  waitRandom('wait', 40, 220, 1),
];
