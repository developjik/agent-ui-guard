/**
 * Public types for agent-ui-guard.
 *
 * The harness has two halves that meet in a ledger:
 *
 *  - a tiny in-page runtime (installed with `addInitScript`) that watches the DOM
 *    continuously and records what happened, including things that are only true
 *    for a few milliseconds (two modals open at once, a stream that never ends);
 *  - a Node-side runner that drives random user actions, reads the ledger, and
 *    evaluates invariants.
 *
 * All timestamps in a ledger are milliseconds since the guard was installed.
 */

export type Awaitable<T> = T | Promise<T>;

/**
 * The DOM contract agent-ui-guard observes. Every selector and attribute has a
 * default; override only the parts your app names differently.
 */
export interface GuardContract {
  /** Elements that are modal dialogs while they are shown. Default `[aria-modal="true"]`. */
  modalSelector: string;
  /** Elements that mean "a model response is streaming right now". Default `[data-streaming="true"], [aria-busy="true"]`. */
  streamingSelector: string;
  /** Tool-call cards. Default `[data-tool-call]`. */
  toolCallSelector: string;
  /** Attribute holding the stable tool-call id. Default `data-tool-call-id`. */
  toolCallIdAttr: string;
  /** Attribute holding the tool name, used in failure messages. Default `data-tool-call-name`. */
  toolCallNameAttr: string;
  /** Attribute holding the tool-call state. Default `data-state`. */
  toolCallStateAttr: string;
  /** States that end a tool call. Default `done`, `error`, `cancelled`. */
  terminalStates: string[];
  /** Elements that wrap one assistant turn. Default `[data-turn]`. */
  turnSelector: string;
  /** Attribute holding the stable turn id. Default `data-turn-id`. */
  turnIdAttr: string;
  /** Attribute holding the turn state. Default `data-turn-state`. */
  turnStateAttr: string;
  /** States that end a turn. Default `done`, `error`, `cancelled`. */
  turnCompleteStates: string[];
}

/** A moment at which more than one modal dialog was visible. */
export interface ModalConflict {
  /** Milliseconds since the guard was installed. */
  at: number;
  /** How many modals were visible at that moment (the peak of the episode). */
  count: number;
  /** Short descriptors such as `dialog#settings[aria-label=Settings]`. */
  nodes: string[];
}

/** One continuous period during which a streaming indicator was visible. */
export interface StreamingEpisode {
  start: number;
  /** `null` while the stream is still running, or forever if it never settles. */
  end: number | null;
}

export interface ToolCallRecord {
  id: string;
  name: string;
  /** Last observed `data-state` value. */
  state: string;
  firstSeenAt: number;
  stateChangedAt: number;
  /** When the card first reached a terminal state, or `null` if it never did. */
  terminalAt: number | null;
  /** Turn id the card was rendered inside, when the app provides one. */
  turnId: string | null;
  /** When the card left the DOM while still non-terminal. */
  detachedAt: number | null;
}

/** A turn that completed while one of its tool calls was still running. */
export interface OrphanToolCall {
  at: number;
  turnId: string;
  toolCallIds: string[];
}

/** What the in-page runtime reports at any instant. */
export interface PageSnapshot {
  runtimeVersion: string;
  /** Page clock, milliseconds since the guard was installed. */
  now: number;
  modals: {
    current: number;
    peak: number;
    /** One entry per episode during which more than one modal was visible. */
    conflicts: ModalConflict[];
  };
  streaming: {
    active: boolean;
    activeSince: number | null;
    episodes: StreamingEpisode[];
  };
  toolCalls: ToolCallRecord[];
  orphans: OrphanToolCall[];
  /** Number of DOM mutation batches the runtime processed (useful for sanity checks). */
  mutations: number;
}

export interface ConsoleErrorRecord {
  at: number;
  text: string;
  location?: string;
}

export interface PageErrorRecord {
  at: number;
  message: string;
  stack?: string;
}

export interface HttpErrorRecord {
  at: number;
  method: string;
  url: string;
  status: number;
  resourceType?: string;
}

/** Page observations merged with what only the Node side can see. */
export interface GuardLedgerSnapshot extends PageSnapshot {
  consoleErrors: ConsoleErrorRecord[];
  pageErrors: PageErrorRecord[];
  http5xx: HttpErrorRecord[];
  transportFrames?: import('./transport.js').TransportFrame[];
}

export type InvariantCheckResult =
  | void
  | boolean
  | {
      ok: boolean;
      message?: string;
      evidence?: unknown;
    };

export interface InvariantContext {
  page: import('@playwright/test').Page;
  /** Zero-based index of the step that just finished. */
  step: number;
  ledger: GuardLedgerSnapshot;
  /** Steps recorded so far, in order. */
  trace: TraceStep[];
}

export type InvariantCheck = (
  ctx: InvariantContext,
) => Awaitable<InvariantCheckResult>;

export interface Invariant {
  name: string;
  kind: 'always' | 'eventually';
  /**
   * For `eventually` invariants: how long the property may stay unsatisfied
   * before it is reported as a violation. Ignored for `always`.
   */
  timeoutMs?: number;
  description?: string;
  check: InvariantCheck;
}

export interface ViolationRecord {
  invariant: string;
  kind: 'always' | 'eventually';
  message: string;
  /** Index of the step during which the violation was detected. */
  step: number;
  evidence?: unknown;
}

export interface TraceStep {
  index: number;
  action: string;
  params: Record<string, unknown>;
  /** Milliseconds since the run started. */
  at: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface TraceFile {
  version: 1;
  tool: 'agent-ui-guard';
  toolVersion: string;
  seed: number;
  url: string;
  viewport: { width: number; height: number } | null;
  createdAt: string;
  finishedAt: string | null;
  steps: TraceStep[];
  violation: ViolationRecord | null;
  observations: {
    consoleErrors: ConsoleErrorRecord[];
    pageErrors: PageErrorRecord[];
    http5xx: HttpErrorRecord[];
    transportFrames?: import('./transport.js').TransportFrame[];
  };
}
