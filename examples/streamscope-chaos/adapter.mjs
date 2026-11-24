/** Synthetic-only streamscope + agent-ui-guard integration. No real trace import. */
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {runExploration,noStuckStreaming} from '../../dist/index.js';
export const STREAMSCOPE_COMMIT='17e5bb642c68d83d0a3f17f05e0fc03e1dbfeb1f';
export function syntheticTrace(){
 const events=[{type:'run-start'},{type:'text-delta',delta:'Synthetic answer, '},{type:'text-delta',delta:'complete.'},{type:'finish',reason:'stop'}];
 return {meta:{v:1,kind:'meta',session:'synthetic-chaos-v1',adapter:'ndjson',framing:'ndjson',protocol:'generic',startedAt:'2026-01-01T00:00:00Z'},frames:events.map((event,seq)=>({seq,t_ms:seq*10,raw:JSON.stringify(event)+'\n',event}))};
}
export async function runCase({browser,streamscope,scenario='',seed=1337,outputDir='test-results/streamscope-chaos'}){
 if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw new Error('seed must be a uint32');
 if(!['','disconnect_at(0.5)','slow(450)'].includes(scenario))throw new Error('Only the documented synthetic scenarios are supported');
 const trace=syntheticTrace();const jsonl=[trace.meta,...trace.frames].map(x=>JSON.stringify(x)).join('\n')+'\n';
 await mkdir(outputDir,{recursive:true});const dir=await mkdtemp(path.join(outputDir,'case-'));
 const manifest={schema:'streamscope-guard-poc/v1',syntheticOnly:true,traceId:trace.meta.session,sha256:createHash('sha256').update(jsonl).digest('hex'),streamscopeCommit:STREAMSCOPE_COMMIT,seed,scenario,actions:[{action:'replay',params:{label:'synthetic'}}],invariants:[{name:'noStuckStreaming',maxStreamMs:900}],reproduce:`STREAMSCOPE_ENTRY=/absolute/path/to/streamscope/dist/index.js node examples/streamscope-chaos/run.mjs --seed ${seed}`,status:'started'};
 await writeFile(path.join(dir,'source.jsonl'),jsonl);await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));
 let replay,app,context;
 try{
  replay=await streamscope.startReplayServer({trace,inject:scenario,host:'127.0.0.1',port:0,html:false});
  await writeFile(path.join(dir,'replay-plan.json'),JSON.stringify(replay.plan,null,2));
  // Deliberately buggy fixture: only finish clears busy. Disconnect and late finish expose it.
  const html=`<!doctype html><html lang="en"><meta charset="UTF-8"><title>Synthetic stream chaos fixture</title><style>body{font:18px system-ui;padding:40px;background:#142019;color:#d5efdf}button{padding:12px}pre{white-space:pre-wrap}</style><h1>Synthetic stream fixture</h1><p>This intentionally buggy client clears busy only on a finish event.</p><button id="replay">Replay synthetic turn</button><section id="turn" data-streaming="false"><pre id="text"></pre><p id="status">Idle</p></section><script>document.querySelector('#replay').onclick=async()=>{const turn=document.querySelector('#turn');turn.dataset.streaming='true';document.querySelector('#status').textContent='Streaming';try{const response=await fetch(${JSON.stringify(replay.streamUrl)});const reader=response.body.getReader();const decoder=new TextDecoder();let rest='';while(true){const {done,value}=await reader.read();if(done)break;rest+=decoder.decode(value,{stream:true});let at;while((at=rest.indexOf('\\n'))!==-1){const line=rest.slice(0,at);rest=rest.slice(at+1);if(!line.trim())continue;const event=JSON.parse(line);if(event.type==='text-delta')document.querySelector('#text').textContent+=event.delta;if(event.type==='finish'){turn.dataset.streaming='false';document.querySelector('#status').textContent='Complete';}}}}catch{document.querySelector('#status').textContent='Disconnected but busy (intentional fixture bug)';}};</script></html>`;
  app=createServer((req,res)=>{if(req.url==='/favicon.ico'){res.writeHead(204);res.end();return;}if(req.url!=='/'){res.writeHead(404);res.end();return;}res.setHeader('content-type','text/html');res.end(html);});
  await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${app.address().port}/`;
  context=await browser.newContext({viewport:{width:960,height:720}});const page=await context.newPage();
  // Block everything except the two owned loopback servers, even in this synthetic fixture.
  await page.route('**/*',route=>{const u=new URL(route.request().url());return (u.origin===new URL(url).origin||u.origin===new URL(replay.streamUrl).origin)?route.continue():route.abort();});
  const result=await runExploration({page,url,actions:[{name:'replay',async run({page}){await page.locator('#replay').click();}}],plan:manifest.actions,invariants:[noStuckStreaming({maxStreamMs:900})],seed,settleTimeoutMs:1200,activityGraceMs:100,outputDir:dir,screenshotOnFailure:true});
  Object.assign(manifest,{status:'complete',ok:result.ok,violation:result.violation,guardArtifacts:result.artifacts?path.relative(dir,result.artifacts.dir):null,actualActions:result.steps.map(({action,params,ok})=>({action,params,ok})),outcome:replay.plan.outcome});
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  return {dir,manifest,result};
 }catch(error){Object.assign(manifest,{status:'error',error:String(error)});await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest,null,2));throw error;
 }finally{await context?.close();if(app){app.closeAllConnections();await new Promise(r=>app.close(r));}await replay?.close();}
}
export async function loadStreamscope(){if(!process.env.STREAMSCOPE_ENTRY)throw new Error('Build the pinned streamscope companion and set STREAMSCOPE_ENTRY to its dist/index.js');const entry=path.resolve(process.env.STREAMSCOPE_ENTRY);const root=path.dirname(path.dirname(entry));if(path.basename(entry)!=='index.js'||path.basename(path.dirname(entry))!=='dist')throw new Error('Expected the built dist/index.js in the pinned checkout');const commit=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();const dirty=execFileSync('git',['-C',root,'status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim();if(commit!==STREAMSCOPE_COMMIT||dirty)throw new Error('Companion must be the clean pinned commit '+STREAMSCOPE_COMMIT);return import(pathToFileURL(entry).href);}
