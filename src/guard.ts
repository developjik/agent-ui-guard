import type { ConsoleMessage, Page, Response } from '@playwright/test';
import { resolveContract } from './contract.js';
import { buildRuntimeScript, RUNTIME_GLOBAL } from './runtime.js';
import type {
  ConsoleErrorRecord,
  GuardContract,
  GuardLedgerSnapshot,
  HttpErrorRecord,
  PageErrorRecord,
  PageSnapshot,
} from './types.js';

export interface GuardOptions {
  /** Override parts of the DOM contract. */
  contract?: Partial<GuardContract>;
  /** How long the UI may stay busy before `settle()` gives up. Default 5000ms. */
  settleTimeoutMs?: number;
  /** How long to watch for the first sign of activity after an action. Default 250ms. */
  activityGraceMs?: number;
  /** Ignore console errors whose text matches one of these (substring or RegExp). */
  ignoreErrors?: Array<string | RegExp>;
}

export interface SettleResult {
  settled: boolean;
  waitedMs: number;
  /** `quiet`, `no-activity`, or `timeout`. */
  reason: 'quiet' | 'no-activity' | 'timeout';
  snapshot: PageSnapshot;
}

export interface NodeObservations {
  consoleErrors: ConsoleErrorRecord[];
  pageErrors: PageErrorRecord[];
  http5xx: HttpErrorRecord[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Attaches agent-ui-guard to a Playwright page: injects the in-page runtime
 * before any app script runs and collects what only the Node side can see
 * (console errors, uncaught exceptions, HTTP 5xx).
 *
 * ```ts
 * const guard = await Guard.install(page);
 * await page.goto(url);
 * const ledger = await guard.ledger();
 * ```
 */
export class Guard {
  readonly contract: GuardContract;
  private readonly node: NodeObservations = {
    consoleErrors: [],
    pageErrors: [],
    http5xx: [],
  };
  private readonly t0 = Date.now();
  private readonly listeners: Array<() => void> = [];
  private readonly ignoreErrors: Array<string | RegExp>;

  private constructor(
    readonly page: Page,
    options: GuardOptions,
  ) {
    this.contract = resolveContract(options.contract);
    this.ignoreErrors = options.ignoreErrors ?? [];
    this.settleTimeoutMs = options.settleTimeoutMs ?? 5_000;
    this.activityGraceMs = options.activityGraceMs ?? 250;
  }

  readonly settleTimeoutMs: number;
  readonly activityGraceMs: number;

  static async install(page: Page, options: GuardOptions = {}): Promise<Guard> {
    const guard = new Guard(page, options);
    const script = buildRuntimeScript(guard.contract);
    // Init scripts survive every navigation of this page.
    await page.addInitScript({ content: script });
    // If the page is already loaded, install into the current document too.
    try {
      await page.evaluate(script);
    } catch {
      // about:blank and cross-origin documents can refuse evaluate; the init
      // script still runs on the first real navigation.
    }
    guard.attach();
    return guard;
  }

  private attach(): void {
    const onConsole = (message: ConsoleMessage): void => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (this.isIgnored(text)) return;
      let location: string | undefined;
      try {
        const loc = message.location();
        if (loc.url) location = `${loc.url}:${loc.lineNumber}`;
      } catch {
        location = undefined;
      }
      this.node.consoleErrors.push({
        at: Date.now() - this.t0,
        text,
        ...(location ? { location } : {}),
      });
    };

    const onPageError = (error: Error): void => {
      if (this.isIgnored(error.message)) return;
      this.node.pageErrors.push({
        at: Date.now() - this.t0,
        message: error.message,
        ...(error.stack ? { stack: error.stack.split('\n').slice(0, 5).join('\n') } : {}),
      });
    };

    const onResponse = (response: Response): void => {
      if (response.status() < 500) return;
      const request = response.request();
      this.node.http5xx.push({
        at: Date.now() - this.t0,
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
      });
    };

    this.page.on('console', onConsole);
    this.page.on('pageerror', onPageError);
    this.page.on('response', onResponse);
    this.listeners.push(() => this.page.off('console', onConsole));
    this.listeners.push(() => this.page.off('pageerror', onPageError));
    this.listeners.push(() => this.page.off('response', onResponse));
  }

  private isIgnored(text: string): boolean {
    return this.ignoreErrors.some((rule) =>
      typeof rule === 'string' ? text.includes(rule) : rule.test(text),
    );
  }

  /** Remove the Node-side listeners (the page runtime keeps running). */
  detach(): void {
    for (const remove of this.listeners.splice(0)) remove();
  }

  private async readSnapshot(): Promise<PageSnapshot | null> {
    try {
      return await this.page.evaluate<PageSnapshot | null>(
        `(function () { var h = window[${JSON.stringify(RUNTIME_GLOBAL)}]; return h ? h.snapshot() : null; })()`,
      );
    } catch {
      return null;
    }
  }

  /** Current in-page observations. Throws when the runtime never installed. */
  async snapshot(): Promise<PageSnapshot> {
    const snapshot = await this.readSnapshot();
    if (!snapshot) {
      throw new Error(
        'agent-ui-guard runtime is not on this page. Install the guard before navigating (page.addInitScript) and make sure the page is same-origin.',
      );
    }
    return snapshot;
  }

  /** Page observations plus console errors, page errors and HTTP 5xx. */
  async ledger(): Promise<GuardLedgerSnapshot> {
    const snapshot = await this.snapshot();
    return {
      ...snapshot,
      consoleErrors: this.node.consoleErrors.slice(),
      pageErrors: this.node.pageErrors.slice(),
      http5xx: this.node.http5xx.slice(),
    };
  }

  /** What the Node side has seen so far, without touching the page. */
  nodeObservations(): NodeObservations {
    return {
      consoleErrors: this.node.consoleErrors.slice(),
      pageErrors: this.node.pageErrors.slice(),
      http5xx: this.node.http5xx.slice(),
    };
  }

  clearNodeObservations(): void {
    this.node.consoleErrors.length = 0;
    this.node.pageErrors.length = 0;
    this.node.http5xx.length = 0;
  }

  async reset(): Promise<void> {
    this.clearNodeObservations();
    await this.page.evaluate(
      `(function () { var h = window[${JSON.stringify(RUNTIME_GLOBAL)}]; if (h && h.reset) h.reset(); })()`,
    );
  }

  /**
   * Wait until the UI is quiet: no streaming indicator, no tool call left
   * running. Looks for activity first (`activityGraceMs`), because an action
   * such as sending a prompt starts its request a few milliseconds later.
   */
  async settle(
    options: { timeoutMs?: number; activityGraceMs?: number } = {},
  ): Promise<SettleResult> {
    const timeoutMs = options.timeoutMs ?? this.settleTimeoutMs;
    const graceMs = options.activityGraceMs ?? this.activityGraceMs;
    const start = Date.now();
    const baseline = await this.snapshot();
    let sawActivity = false;

    while (Date.now() - start < graceMs) {
      const snapshot = await this.snapshot();
      if (
        snapshot.streaming.active ||
        snapshot.toolCalls.length > baseline.toolCalls.length ||
        snapshot.modals.current > 0
      ) {
        sawActivity = true;
        break;
      }
      await sleep(20);
    }

    if (!sawActivity && graceMs > 0) {
      const snapshot = await this.snapshot();
      if (!snapshot.streaming.active && !snapshot.toolCalls.some((t) => t.terminalAt === null)) {
        return { settled: true, waitedMs: Date.now() - start, reason: 'no-activity', snapshot };
      }
      sawActivity = true;
    }

    const deadline = Date.now() + timeoutMs;
    let snapshot = await this.snapshot();
    while (true) {
      snapshot = await this.snapshot();
      const openToolCalls = snapshot.toolCalls.some((t) => t.terminalAt === null);
      if (!snapshot.streaming.active && !openToolCalls) {
        return { settled: true, waitedMs: Date.now() - start, reason: 'quiet', snapshot };
      }
      if (Date.now() > deadline) {
        return { settled: false, waitedMs: Date.now() - start, reason: 'timeout', snapshot };
      }
      await sleep(25);
    }
  }

  /** Wait until the in-page runtime answers (it should exist right after goto). */
  async ready(timeoutMs = 3_000): Promise<PageSnapshot> {
    const start = Date.now();
    while (Date.now() - start <= timeoutMs) {
      const snapshot = await this.readSnapshot();
      if (snapshot) return snapshot;
      await sleep(25);
    }
    throw new Error(
      'agent-ui-guard runtime did not appear within ' + timeoutMs + 'ms',
    );
  }
}
