import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A small, dependency-free streaming chat app used as the reference fixture for
 * agent-ui-guard. It speaks the DOM contract in `src/contract.ts` and can be
 * started in several deliberately broken modes.
 */
export type DemoMode =
  | 'healthy'
  | 'double-modal'
  | 'orphan-spinner'
  | 'stuck-streaming'
  | 'http-500';

export const DEMO_MODES: DemoMode[] = [
  'healthy',
  'double-modal',
  'orphan-spinner',
  'stuck-streaming',
  'http-500',
];

export interface DemoServer {
  url: string;
  mode: DemoMode;
  /** Number of /api/chat requests served so far. */
  readonly turns: number;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function answerChunks(prompt: string): string[] {
  const topic = prompt.trim().slice(0, 60) || 'your question';
  return [
    'Here is what I found about ',
    `"${topic}".\n\n`,
    '1. The streaming path now batches deltas ',
    'every frame instead of every token.\n',
    '2. Tool calls report a terminal state before the turn closes.\n',
    '3. Only one dialog can own focus at a time.\n\n',
    'Want me to turn this into a checklist?',
  ];
}

async function serveIndex(res: ServerResponse, mode: DemoMode): Promise<void> {
  const html = await readFile(path.join(publicDir, 'index.html'), 'utf8');
  const body = html.replace('__DEMO_MODE__', mode);
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function serveStatic(
  res: ServerResponse,
  fileName: string,
  type: string,
): Promise<void> {
  try {
    const body = await readFile(path.join(publicDir, fileName));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  mode: DemoMode,
  state: { turns: number },
): Promise<void> {
  const raw = await readBody(req);
  let prompt = '';
  let requestedTurnId: string | undefined;
  try {
    const body = JSON.parse(raw || '{}') as { prompt?: unknown; turnId?: unknown };
    if (typeof body.prompt === 'string') prompt = body.prompt;
    if (typeof body.turnId === 'string') requestedTurnId = body.turnId;
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  state.turns += 1;
  const turnNumber = state.turns;

  if (mode === 'http-500' && turnNumber >= 2) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'model gateway exploded' }));
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const send = (event: string, data: unknown): void => {
    if (closed || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const turnId = requestedTurnId ?? `turn-${turnNumber}`;
  const toolCallId = `${turnId}-tool-1`;

  send('turn', { turnId, state: 'streaming' });
  await sleep(20);
  send('tool_call', { id: toolCallId, name: 'web.search', state: 'running' });

  for (const delta of answerChunks(prompt)) {
    if (closed) return;
    await sleep(28);
    send('text', { delta });
  }

  // Healthy turns always close their tool call before the turn ends. The buggy
  // fixtures reproduce the two ways real apps get this wrong.
  if (mode !== 'orphan-spinner') {
    send('tool_call', { id: toolCallId, name: 'web.search', state: 'done' });
  }

  if (mode === 'stuck-streaming') {
    // Connection drops without ever clearing the streaming indicator.
    res.end();
    return;
  }

  send('turn', { turnId, state: 'done' });
  res.end();
}

export async function startDemoServer(
  options: { mode?: DemoMode; port?: number } = {},
): Promise<DemoServer> {
  const mode = options.mode ?? 'healthy';
  const state = { turns: 0 };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          await serveIndex(res, mode);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/app.js') {
          await serveStatic(res, 'app.js', MIME['.js']!);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/styles.css') {
          await serveStatic(res, 'styles.css', MIME['.css']!);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, mode }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/chat') {
          await handleChat(req, res, mode, state);
          return;
        }
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      } catch {
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('demo server error');
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/`,
    mode,
    get turns(): number {
      return state.turns;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
