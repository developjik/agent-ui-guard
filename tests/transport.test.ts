import { expect, test } from 'vitest';
import { normalizeStreamEvent, streamEventViolation, replayWebSockets } from '../src/transport.js';
import { parseTrace, TraceRecorder } from '../src/trace.js';
test('mapper handles text/binary JSON and ignores unknown protocols',()=>{
 expect(normalizeStreamEvent(Buffer.from('{"type":"delta","runId":"r","delta":"hi"}'))).toMatchObject({type:'delta',delta:'hi'});
 for(const value of ['not JSON','null','{}','{"type":"delta"}']) expect(normalizeStreamEvent(value)).toBeUndefined();
});
test('ordering check handles separate runs, duplicate sequence and terminal errors',()=>{
 expect(streamEventViolation([{type:'start',runId:'r',seq:1},{type:'delta',runId:'r',seq:1}])).toContain('Out-of-order');
 expect(streamEventViolation([{type:'start',runId:'r'},{type:'start',runId:'r'}])).toContain('Duplicate start');
 expect(streamEventViolation([{type:'start',runId:'r'},{type:'error',runId:'r'},{type:'finish',runId:'r'}])).toContain('terminal');
 expect(streamEventViolation([{type:'start',runId:'r'},{type:'finish',runId:'r'},{type:'start',runId:'s'},{type:'finish',runId:'s'}])).toBeUndefined();
});
test('trace round-trip preserves opt-in transport frames and loads legacy traces',()=>{
 const recorder=new TraceRecorder({url:'http://local',seed:1,viewport:null});
 const frame={transport:'websocket' as const,connection:0,url:'ws://local',direction:'received' as const,at:0,encoding:'text' as const,raw:'hello'};
 const trace=recorder.toJSON({consoleErrors:[],pageErrors:[],http5xx:[],transportFrames:[frame]});
 expect(parseTrace(JSON.parse(JSON.stringify(trace))).observations.transportFrames).toEqual([frame]);
 delete trace.observations.transportFrames;expect(parseTrace(trace).observations.transportFrames).toBeUndefined();
});

test('replay validates before installing routes',async()=>{
 const page={routeWebSocket:()=>{throw new Error('should not install')}} as never;
 await expect(replayWebSockets(page,[],{speed:-1})).rejects.toThrow('speed');
 await expect(replayWebSockets(page,[{transport:'websocket',connection:0,url:'ws://local',direction:'received',at:-1,encoding:'text',raw:''}])).rejects.toThrow('Invalid');
});

test('binary mapper cannot mutate recorded wire bytes', async () => {
 const { EventEmitter } = await import('node:events');
 const { recordWebSockets } = await import('../src/transport.js');
 const page = new EventEmitter(); const socket = Object.assign(new EventEmitter(), {url:()=> 'ws://local'});
 const frames: unknown[]=[];
 const detach=recordWebSockets(page as never,{map:payload=>{if(Buffer.isBuffer(payload)) payload.fill(0);return undefined;},onFrame:frame=>frames.push(frame)});
 page.emit('websocket',socket);const bytes=Buffer.from([1,2,255]);socket.emit('framereceived',{payload:bytes});
 expect(frames).toMatchObject([{raw:bytes.toString('base64')}]);expect([...bytes]).toEqual([1,2,255]);detach();
});
