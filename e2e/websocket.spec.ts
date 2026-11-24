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
  try {await page.goto(server.url);await page.waitForSelector('body[data-ready=true]');await page.click('#send');await expect(page.locator('#events')).toContainText(mode === 'terminal' ? 'late' : 'finish');
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

test('same-URL connections replay by opening order even when second sends first', async ({page})=>{
 const url='ws://127.0.0.1:1/same';
 const make=(connection:number,direction:'sent'|'received',raw:string,at:number)=>({transport:'websocket' as const,connection,url,direction,raw,at,encoding:'text' as const});
 await replayWebSockets(page,[make(1,'sent','second',0),make(1,'received','reply-two',1),make(0,'sent','first',2),make(0,'received','reply-one',3)]);
 const result=await page.evaluate(async url=>{
  const a=new WebSocket(url);const b=new WebSocket(url);
  await Promise.all([a,b].map(ws=>new Promise<void>(resolve=>ws.onopen=()=>resolve())));
  const answer=(ws:WebSocket)=>new Promise<string>((resolve,reject)=>{ws.onmessage=e=>resolve(e.data);ws.onclose=e=>reject(new Error(String(e.code)));});
  const pa=answer(a),pb=answer(b);b.send('second');a.send('first');const result=await Promise.all([pa,pb]);a.close();b.close();return result;
 },url);
 expect(result).toEqual(['reply-one','reply-two']);
});

test('saved WS violation replays through replayTrace and generated repro',async({browser})=>{
 const {readFile} = await import('node:fs/promises');
 const {runExploration,replayTrace,parseTrace,generateReproSpec,builtinInvariants}=await import('../src/index.js');
 const server=await startWebSocketDemo('terminal');const page=await browser.newPage();
 const actions=[{name:'send',run:async({page}:{page:import('@playwright/test').Page})=>{await page.waitForSelector('body[data-ready=true]');await page.click('#send');await expect(page.locator('#events')).toContainText('late');}}];
 try {
  const result=await runExploration({page,url:server.url,actions,plan:[{action:'send'}],invariants:builtinInvariants(),webSocket:true,outputDir:'test-results/ws-recorded-violation'});
  expect(result.violation?.invariant).toBe('streamEventOrder');
  const trace=parseTrace(JSON.parse(await readFile(result.artifacts!.trace,'utf8')));expect(generateReproSpec(trace)).toContain('transportReplay:');
  const replay=await browser.newPage();const again=await replayTrace({page:replay,trace,actions,invariants:builtinInvariants(),outputDir:'test-results/ws-replayed-violation'});
  expect(again.violation?.invariant).toBe('streamEventOrder');await replay.close();
 }finally{await page.close();await server.close();}
});
