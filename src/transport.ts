import type { Page, WebSocket as PlaywrightWebSocket } from '@playwright/test';

export interface StreamEvent {
  type: 'start' | 'delta' | 'tool-call' | 'finish' | 'error';
  runId: string;
  id?: string;
  seq?: number;
  delta?: string;
  data?: unknown;
}
export interface TransportFrame {
  transport: 'websocket';
  connection: number;
  url: string;
  direction: 'sent' | 'received';
  at: number;
  encoding: 'text' | 'base64';
  raw: string;
  event?: StreamEvent;
}
/** Explicit normalized JSON envelope. Supply a mapper for your application's wire protocol. */
export function normalizeStreamEvent(payload: string | Buffer): StreamEvent | undefined {
  let value: unknown;
  try { value = JSON.parse(payload.toString()); } catch { return; }
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (!['start', 'delta', 'tool-call', 'finish', 'error'].includes(String(data.type)) || typeof data.runId !== 'string') return;
  return { type: data.type as StreamEvent['type'], runId: data.runId,
    ...(typeof data.id === 'string' ? { id: data.id } : {}),
    ...(typeof data.seq === 'number' && Number.isFinite(data.seq) ? { seq: data.seq } : {}),
    ...(typeof data.delta === 'string' ? { delta: data.delta } : {}), data: value };
}
export type StreamMapper = (payload: string | Buffer) => StreamEvent | undefined;
/** Passive listener, so recording never replaces the app's messages or handlers. */
export function recordWebSockets(page: Page, options: { map?: StreamMapper; onFrame: (frame: TransportFrame) => void }): () => void {
  const start = Date.now(); let connection = 0;
  const cleanups: Array<() => void> = [];
  const onSocket = (socket: PlaywrightWebSocket) => {
    const id = connection++;
    const receive = (direction: TransportFrame['direction']) => ({ payload }: { payload: string | Buffer }) => {
      const event = (options.map ?? normalizeStreamEvent)(payload);
      options.onFrame({ transport: 'websocket', connection: id, url: socket.url(), direction, at: Date.now() - start,
        encoding: typeof payload === 'string' ? 'text' : 'base64', raw: typeof payload === 'string' ? payload : payload.toString('base64'), ...(event ? { event } : {}) });
    };
    const sent = receive('sent'); const received = receive('received');
    socket.on('framesent', sent); socket.on('framereceived', received);
    cleanups.push(() => { socket.off('framesent', sent); socket.off('framereceived', received); });
  };
  page.on('websocket', onSocket);
  return () => { page.off('websocket', onSocket); for (const cleanup of cleanups.splice(0)) cleanup(); };
}

/** Mock WS before navigation. Client messages gate recorded responses, preserving request order.
 * No real server is contacted. Routes last for the page lifetime; use a fresh page per replay.
 */
export async function replayWebSockets(page: Page, frames: readonly TransportFrame[], options: { url?: string | RegExp; speed?: number; onFrame?: (frame: TransportFrame) => void } = {}): Promise<void> {
  const speed = options.speed ?? 0;
  if (!Number.isFinite(speed) || speed < 0) throw new Error('speed must be finite and nonnegative');
  const groups = new Map<number, TransportFrame[]>();
  for (const frame of frames) { const group = groups.get(frame.connection) ?? []; group.push(frame); groups.set(frame.connection, group); }
  const pending = [...groups.values()];
  await page.routeWebSocket(options.url ?? /./, route => {
    const index = pending.findIndex(group => group[0]?.url === route.url());
    if (index < 0) { void route.close({ code: 1008, reason: 'No recording for this connection' }); return; }
    const group = pending.splice(index, 1)[0]!;
    let cursor = 0; let previous = group[0]?.at ?? 0; let closed = false; let queue = Promise.resolve();
    const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
    const wait = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms); timers.set(timer, resolve); });
    const deliver = async () => {
      while (!closed && group[cursor]?.direction === 'received') {
        const frame = group[cursor++]!;
        if (speed > 0) await wait(Math.max(0, frame.at - previous) / speed);
        previous = frame.at;
        if (!closed) { route.send(frame.encoding === 'base64' ? Buffer.from(frame.raw, 'base64') : frame.raw); options.onFrame?.(frame); }
      }
    };
    route.onClose(() => { closed = true; for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); } timers.clear(); });
    route.onMessage(message => {
      queue = queue.then(async () => {
        const expected = group[cursor];
        const raw = typeof message === 'string' ? message : message.toString('base64');
        const encoding = typeof message === 'string' ? 'text' : 'base64';
        if (!expected || expected.direction !== 'sent' || expected.raw !== raw || expected.encoding !== encoding) {
          closed = true; await route.close({ code: 1008, reason: 'Recorded client message mismatch' }); return;
        }
        options.onFrame?.(expected); cursor++; previous = expected.at; await deliver();
      }).catch(() => { closed = true; });
    });
    queue = deliver();
  });
}

/** Transport-independent ordering, duplicate, and terminal-state checks. */
export function streamEventViolation(events: readonly StreamEvent[]): string | undefined {
  const runs = new Map<string, { terminal: boolean; seq?: number; ids: Set<string> }>();
  for (const event of events) {
    let run = runs.get(event.runId);
    if (event.type === 'start') {
      if (run) return `Duplicate start for run ${event.runId}`;
      run = { terminal: false, ids: new Set() }; runs.set(event.runId, run);
    } else if (!run) return `${event.type} before start for run ${event.runId}`;
    if (run!.terminal) return `${event.type} after terminal state for run ${event.runId}`;
    if (event.id) { if (run!.ids.has(event.id)) return `Duplicate event ${event.id}`; run!.ids.add(event.id); }
    if (event.seq !== undefined) { if (run!.seq !== undefined && event.seq <= run!.seq) return `Out-of-order sequence ${event.seq} for run ${event.runId}`; run!.seq = event.seq; }
    if (event.type === 'finish' || event.type === 'error') run!.terminal = true;
  }
}
