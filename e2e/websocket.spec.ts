import { test, expect } from '@playwright/test';
import { Guard, replayWebSockets, streamEventOrder } from '../src/index.js';
import { startWebSocketDemo, type WsMode } from '../demo/websocket.js';
test('WS recording and request-gated replay preserve the same event sequence and bytes', async ({ browser }) => {
  const server = await startWebSocketDemo();
  const page = await browser.newPage(); const guard = await Guard.install(page, { webSocket: true });
  try {
    await page.goto(server.url); await page.waitForSelector('body[data-ready=true]');
    await page.click('#send'); await expect(page.locator('#events')).toContainText('finish');
    const frames = guard.nodeObservations().transportFrames!;
    expect(frames.map(frame => frame.transport)).toEqual(['websocket','websocket','websocket','websocket']);
    const replay = await browser.newPage();
    const replayGuard = await Guard.install(replay, { webSocket: true });
    await replayWebSockets(replay, frames, { onFrame: frame => replayGuard.recordTransportFrame(frame) });
    await replay.goto(server.url); await replay.waitForSelector('body[data-ready=true]');
    await expect(replay.locator('#events')).toHaveText(''); // Nothing before recorded request.
    await replay.click('#send'); await expect(replay.locator('#events')).toContainText('finish');
    expect(replayGuard.nodeObservations().transportFrames!.map(({raw,encoding,direction,event})=>({raw,encoding,direction,event}))).toEqual(frames.map(({raw,encoding,direction,event})=>({raw,encoding,direction,event})));
    expect(await streamEventOrder().check({page: replay, step:0, trace:[], ledger:await replayGuard.ledger()})).toBe(true);
    replayGuard.detach(); await replay.close();
  } finally {guard.detach(); await page.close(); await server.close();}
});
for (const [mode, message] of [['order','before start'],['terminal','after terminal'],['duplicate','Duplicate event']] as const) {
 test(`WS demo catches ${mode} violation`, async ({ page }) => {
  const server = await startWebSocketDemo(mode as WsMode); const guard = await Guard.install(page, {webSocket:true});
  try {await page.goto(server.url);await page.waitForSelector('body[data-ready=true]');await page.click('#send');await expect(page.locator('#events')).toContainText('finish');
   const result = await streamEventOrder().check({ page, step:0,trace:[],ledger:await guard.ledger() });expect(result).toMatchObject({ok:false,message:expect.stringContaining(message)});
   await page.screenshot({path:`test-results/ws-${mode}.png`});
  } finally {guard.detach();await server.close();}
 });
}
test('WS frame collection is opt-in', async ({page})=> {const guard=await Guard.install(page);expect(guard.nodeObservations().transportFrames).toBeUndefined();guard.detach();});

test('WS replay preserves binary payloads, rejects mismatched requests and uses no live server', async ({ browser }) => {
 const page = await browser.newPage();
 const frames = [
  {transport:'websocket' as const,connection:0,url:'ws://127.0.0.1:1/binary',direction:'sent' as const,at:0,encoding:'text' as const,raw:'go'},
  {transport:'websocket' as const,connection:0,url:'ws://127.0.0.1:1/binary',direction:'received' as const,at:10,encoding:'base64' as const,raw:Buffer.from([0,255,1,128]).toString('base64')},
 ];
 await replayWebSockets(page, frames, {speed:1});
 const bytes=await page.evaluate(async()=>new Promise<number[]>((resolve,reject)=>{const ws=new WebSocket('ws://127.0.0.1:1/binary');ws.binaryType='arraybuffer';ws.onopen=()=>ws.send('go');ws.onmessage=e=>{resolve([...new Uint8Array(e.data)]);ws.close();};ws.onerror=reject;}));
 expect(bytes).toEqual([0,255,1,128]);await page.close();
 const mismatch=await browser.newPage();await replayWebSockets(mismatch,frames);
 const code=await mismatch.evaluate(async()=>new Promise<number>(resolve=>{const ws=new WebSocket('ws://127.0.0.1:1/binary');ws.onopen=()=>ws.send('wrong');ws.onclose=e=>resolve(e.code);}));
 expect(code).toBe(1008);await mismatch.close();
});
