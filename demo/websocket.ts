/** Local-only WS demo used by the regression suite. No external APIs. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
export type WsMode = 'healthy' | 'order' | 'terminal' | 'duplicate';
export async function startWebSocketDemo(mode: WsMode = 'healthy') {
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>WebSocket guard demo</title><style>body{font:18px system-ui;max-width:720px;margin:60px auto}button{font:inherit;padding:12px}pre{background:#eef2f7;padding:20px}</style><h1>WebSocket guard demo</h1><p>Mode: ${mode}. Local recorded stream, no model API.</p><button id="send">Send request</button><pre id="events"></pre><script>
  const ws = new WebSocket(location.origin.replace('http','ws') + '/stream');
  ws.onopen=()=>document.body.dataset.ready='true';
  ws.onmessage=e=>document.querySelector('#events').textContent+=e.data+'\\n';
  document.querySelector('#send').onclick=()=>ws.send('request');
  </script></html>`;
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(html); });
  const sockets = new WebSocketServer({ server, path: '/stream' });
  sockets.on('connection', socket => socket.on('message', () => {
    const events = [ { type: 'start', runId: 'r1', id: 's', seq: 0 }, { type: 'delta', runId: 'r1', id: 'd', seq: 1, delta: 'Hello' }, { type: 'finish', runId: 'r1', id: 'f', seq: 2 } ];
    if (mode === 'order') events.splice(0, 2, events[1]!, events[0]!);
    if (mode === 'terminal') events.push({ type: 'delta', runId: 'r1', id: 'late', seq: 3, delta: 'late' });
    if (mode === 'duplicate') events.splice(2, 0, events[1]!);
    for (const event of events) socket.send(JSON.stringify(event));
  }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No listening port');
  return { url: `http://127.0.0.1:${address.port}`, close: async () => { for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve())); } };
}
