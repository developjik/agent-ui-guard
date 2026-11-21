import type { GuardContract, PageSnapshot } from './types.js';

export const RUNTIME_GLOBAL = '__AGENT_UI_GUARD__';
export const RUNTIME_VERSION = '0.1.0';

/**
 * Builds the script Playwright injects with `addInitScript({ content })`.
 *
 * The runtime is written once, as the typed function below, and serialized
 * here. It is not handed to `addInitScript(fn)` directly: bundlers such as
 * esbuild (and therefore `tsx`) add `__name(...)` calls around named
 * functions when serializing source, and those helpers do not exist inside the
 * page. Injecting the source as a string, with the helper stubbed, works the
 * same under every runner.
 */
export function buildRuntimeScript(contract: GuardContract): string {
  const source = installAgentUiGuardRuntime.toString();
  const serializedContract = JSON.stringify(contract);
  return [
    '/* agent-ui-guard runtime ' + RUNTIME_VERSION + ' */',
    'var __name = function (target) { return target; };',
    '(' + source + ')(' + serializedContract + ');',
  ].join('\n');
}

interface RuntimeHandle {
  version: string;
  contract: GuardContract;
  snapshot(): PageSnapshot;
  reset(): void;
  sample(): void;
  isStreaming(): boolean;
}

declare global {
  interface Window {
    __AGENT_UI_GUARD__?: RuntimeHandle;
  }
}

/**
 * The in-page half of agent-ui-guard.
 *
 * Playwright serializes this function and runs it before any page script, so it
 * must be completely self-contained: no imports, no closures over module scope.
 * It observes the DOM continuously instead of only when the runner asks, which
 * is what lets it catch violations that live for a few milliseconds, such as two
 * modal dialogs being mounted in the same frame.
 */
export function installAgentUiGuardRuntime(contract: GuardContract): void {
  if (window.__AGENT_UI_GUARD__) return;

  const MAX_CONFLICTS = 200;
  const MAX_EPISODES = 500;
  const MAX_TOOL_CALLS = 500;
  const MAX_ORPHANS = 200;

  const t0 = performance.now();
  const now = (): number => performance.now() - t0;

  interface Conflict {
    at: number;
    count: number;
    nodes: string[];
  }
  interface Episode {
    start: number;
    end: number | null;
  }
  interface ToolCall {
    id: string;
    name: string;
    state: string;
    firstSeenAt: number;
    stateChangedAt: number;
    terminalAt: number | null;
    turnId: string | null;
    detachedAt: number | null;
  }
  interface Orphan {
    at: number;
    turnId: string;
    toolCallIds: string[];
  }
  interface TurnState {
    id: string;
    state: string;
  }

  const modals = { current: 0, peak: 0, conflicts: [] as Conflict[] };
  let modalConflictOpen = false;

  const streaming = {
    active: false,
    activeSince: null as number | null,
    episodes: [] as Episode[],
  };

  const toolCalls = new Map<string, ToolCall>();
  const turns = new Map<string, TurnState>();
  const orphans: Orphan[] = [];
  let mutations = 0;
  let autoId = 0;

  const isVisible = (el: Element): boolean => {
    if (!el.isConnected) return false;
    const html = el as HTMLElement;
    if (html.closest('[hidden]')) return false;
    if (html.getAttribute('aria-hidden') === 'true') return false;
    if (html.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(html);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.opacity === '0'
    ) {
      return false;
    }
    return true;
  };

  const describe = (el: Element): string => {
    let out = el.tagName.toLowerCase();
    if (el.id) out += '#' + el.id;
    const role = el.getAttribute('role');
    if (role) out += '[role=' + role + ']';
    const label = el.getAttribute('aria-label');
    if (label) out += '[aria-label=' + label.slice(0, 40) + ']';
    return out;
  };

  const visibleMatches = (selector: string): Element[] => {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
    return nodes.filter(isVisible);
  };

  const sampleModals = (): void => {
    const nodes = visibleMatches(contract.modalSelector);
    modals.current = nodes.length;
    if (nodes.length > modals.peak) modals.peak = nodes.length;
    if (nodes.length > 1) {
      const descriptors = nodes.map(describe);
      if (modalConflictOpen) {
        const last = modals.conflicts[modals.conflicts.length - 1];
        if (last) {
          last.count = Math.max(last.count, nodes.length);
          last.nodes = descriptors;
        }
      } else {
        modals.conflicts.push({ at: now(), count: nodes.length, nodes: descriptors });
        if (modals.conflicts.length > MAX_CONFLICTS) modals.conflicts.shift();
        modalConflictOpen = true;
      }
    } else {
      modalConflictOpen = false;
    }
  };

  const sampleStreaming = (): void => {
    const nodes = visibleMatches(contract.streamingSelector);
    const active = nodes.length > 0;
    if (active && !streaming.active) {
      streaming.active = true;
      streaming.activeSince = now();
    } else if (!active && streaming.active) {
      streaming.episodes.push({ start: streaming.activeSince ?? now(), end: now() });
      if (streaming.episodes.length > MAX_EPISODES) streaming.episodes.shift();
      streaming.active = false;
      streaming.activeSince = null;
    }
  };

  const turnIdOf = (el: Element): string | null => {
    const turn = el.closest(contract.turnSelector);
    if (!turn) return null;
    const id = turn.getAttribute(contract.turnIdAttr);
    return id || null;
  };

  const sampleToolCalls = (): void => {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(contract.toolCallSelector));
    } catch {
      nodes = [];
    }
    const seen = new Set<string>();
    for (const el of nodes) {
      const html = el as HTMLElement;
      let id = el.getAttribute(contract.toolCallIdAttr) || '';
      if (!id) {
        id = html.dataset.augAutoId || '';
        if (!id) {
          id = 'auto-' + ++autoId;
          html.dataset.augAutoId = id;
        }
      }
      seen.add(id);
      const state = el.getAttribute(contract.toolCallStateAttr) || 'unknown';
      const name = el.getAttribute(contract.toolCallNameAttr) || el.getAttribute(contract.toolCallStateAttr) || id;
      const terminal = contract.terminalStates.indexOf(state) !== -1;
      const turnId = turnIdOf(el);
      const existing = toolCalls.get(id);
      if (!existing) {
        if (toolCalls.size >= MAX_TOOL_CALLS) continue;
        toolCalls.set(id, {
          id,
          name,
          state,
          firstSeenAt: now(),
          stateChangedAt: now(),
          terminalAt: terminal ? now() : null,
          turnId,
          detachedAt: null,
        });
        continue;
      }
      if (existing.state !== state) {
        existing.state = state;
        existing.stateChangedAt = now();
        if (terminal && existing.terminalAt === null) existing.terminalAt = now();
      }
      if (turnId) existing.turnId = turnId;
      if (existing.detachedAt !== null) existing.detachedAt = null;
    }

    for (const record of toolCalls.values()) {
      if (!seen.has(record.id) && record.terminalAt === null && record.detachedAt === null) {
        record.detachedAt = now();
      }
    }
  };

  const sampleTurns = (): void => {
    let nodes: Element[] = [];
    try {
      nodes = Array.from(document.querySelectorAll(contract.turnSelector));
    } catch {
      nodes = [];
    }
    for (const el of nodes) {
      const html = el as HTMLElement;
      let id = el.getAttribute(contract.turnIdAttr) || '';
      if (!id) {
        id = html.dataset.augAutoTurnId || '';
        if (!id) {
          id = 'auto-turn-' + ++autoId;
          html.dataset.augAutoTurnId = id;
        }
      }
      const state = el.getAttribute(contract.turnStateAttr) || 'unknown';
      const existing = turns.get(id);
      if (!existing) {
        turns.set(id, { id, state });
        continue;
      }
      if (existing.state === state) continue;
      existing.state = state;
      if (contract.turnCompleteStates.indexOf(state) === -1) continue;

      const open: string[] = [];
      for (const record of toolCalls.values()) {
        if (record.turnId === id && record.terminalAt === null) open.push(record.id);
      }
      if (open.length > 0) {
        orphans.push({ at: now(), turnId: id, toolCallIds: open });
        if (orphans.length > MAX_ORPHANS) orphans.shift();
      }
    }
  };

  const sample = (): void => {
    sampleToolCalls();
    sampleTurns();
    sampleModals();
    sampleStreaming();
  };

  const snapshot = (): PageSnapshot => {
    sample();
    return {
      runtimeVersion: '0.1.0',
      now: now(),
      modals: {
        current: modals.current,
        peak: modals.peak,
        conflicts: modals.conflicts.map((c) => ({
          at: c.at,
          count: c.count,
          nodes: c.nodes.slice(),
        })),
      },
      streaming: {
        active: streaming.active,
        activeSince: streaming.activeSince,
        episodes: streaming.episodes.map((e) => ({ start: e.start, end: e.end })),
      },
      toolCalls: Array.from(toolCalls.values()).map((t) => ({ ...t })),
      orphans: orphans.map((o) => ({
        at: o.at,
        turnId: o.turnId,
        toolCallIds: o.toolCallIds.slice(),
      })),
      mutations,
    };
  };

  const reset = (): void => {
    modals.current = 0;
    modals.peak = 0;
    modals.conflicts.length = 0;
    modalConflictOpen = false;
    streaming.active = false;
    streaming.activeSince = null;
    streaming.episodes.length = 0;
    toolCalls.clear();
    turns.clear();
    orphans.length = 0;
    mutations = 0;
    autoId = 0;
  };

  const start = (): void => {
    sample();
    const observer = new MutationObserver(() => {
      mutations += 1;
      sample();
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [
        'aria-modal',
        'aria-hidden',
        'aria-busy',
        'hidden',
        'style',
        'class',
        'open',
        contract.toolCallStateAttr,
        contract.turnStateAttr,
      ],
    });
    // MutationObserver misses nothing in the DOM, but a state that is painted
    // then removed between two mutation batches is still worth a periodic look.
    window.setInterval(sample, 150);
    window.addEventListener('pagehide', sample);
  };

  window.__AGENT_UI_GUARD__ = {
    version: '0.1.0',
    contract,
    snapshot,
    reset,
    sample,
    isStreaming: () => {
      sampleStreaming();
      return streaming.active;
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else if (document.documentElement) {
    start();
  } else {
    window.addEventListener('DOMContentLoaded', start, { once: true });
  }
}
