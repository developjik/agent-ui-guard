import { expect, test } from 'vitest';
import { normalizeStreamEvent, streamEventViolation } from '../src/transport.js';
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
