import type { Page } from '@playwright/test';
import type { Rng } from './rng.js';

export interface ActionRunContext {
  page: Page;
  /** Zero-based step index. */
  step: number;
  params: Record<string, unknown>;
  rng: Rng;
}

/**
 * One thing a user can do in the app. The runner picks these at random by
 * weight (or follows a recorded plan), records the parameters, and replays them
 * verbatim when a failure is reproduced.
 */
export interface ActionDefinition {
  name: string;
  description?: string;
  /** Relative probability of being picked. Default 1. */
  weight?: number;
  /** Choose this invocation's parameters from the seeded RNG. */
  params?: (rng: Rng) => Record<string, unknown>;
  run(ctx: ActionRunContext): Promise<void>;
}

export function defineAction(
  definition: Omit<ActionDefinition, 'weight'> & { weight?: number },
): ActionDefinition {
  return definition;
}

/** Press Escape anywhere on the page (closes the topmost dialog in most apps). */
export function pressEscape(name = 'pressEscape', weight = 1): ActionDefinition {
  return defineAction({
    name,
    weight,
    description: 'Press Escape',
    async run({ page }) {
      await page.keyboard.press('Escape');
    },
  });
}

/** Click a selector, if it is visible and enabled; otherwise the step is a no-op. */
export function clickTarget(
  name: string,
  selector: string,
  options: { weight?: number; description?: string } = {},
): ActionDefinition {
  return defineAction({
    name,
    weight: options.weight ?? 1,
    description: options.description ?? `Click ${selector}`,
    async run({ page }) {
      const target = page.locator(selector).first();
      if ((await target.count()) === 0) return;
      if (!(await target.isVisible())) return;
      if (!(await target.isEnabled().catch(() => true))) return;
      await target.click({ timeout: 1_000 });
    },
  });
}

/**
 * Type one of `prompts` into `selector` and submit it.
 *
 * This is the action every streaming chat UI needs; it is deliberately a no-op
 * while the composer is disabled, so the fuzzer keeps exploring instead of
 * failing on a legitimately busy UI.
 */
export function sendPrompt(
  selector: string,
  prompts: readonly string[],
  options: { name?: string; weight?: number; submitWith?: string } = {},
): ActionDefinition {
  return defineAction({
    name: options.name ?? 'sendPrompt',
    weight: options.weight ?? 4,
    description: `Type a prompt into ${selector} and submit`,
    params: (rng) => ({ prompt: rng.pick(prompts) }),
    async run({ page, params }) {
      const prompt = typeof params.prompt === 'string' ? params.prompt : prompts[0] ?? 'hello';
      const input = page.locator(selector).first();
      if ((await input.count()) === 0) return;
      if (!(await input.isVisible())) return;
      if (!(await input.isEnabled().catch(() => true))) return;
      await input.fill(prompt, { timeout: 1_000 });
      await input.press(options.submitWith ?? 'Enter');
    },
  });
}

/** Wait for a random duration in [minMs, maxMs]. */
export function waitRandom(
  name = 'wait',
  minMs = 50,
  maxMs = 300,
  weight = 1,
): ActionDefinition {
  return defineAction({
    name,
    weight,
    description: `Wait ${minMs}-${maxMs}ms`,
    params: (rng) => ({ ms: minMs + rng.int(Math.max(1, maxMs - minMs)) }),
    async run({ page, params }) {
      const ms = typeof params.ms === 'number' ? params.ms : minMs;
      await page.waitForTimeout(ms);
    },
  });
}
