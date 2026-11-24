import {chromium} from '@playwright/test';
import {readFile,access} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {runCase,loadStreamscope} from './adapter.mjs';
const args=process.argv.slice(2);let seed=1337;
if(args.length){if(args.length!==2||args[0]!=='--seed'||!/^\d+$/.test(args[1]))throw new Error('Usage: node examples/streamscope-chaos/run.mjs [--seed 1337]');seed=Number(args[1]);}
const executablePath=process.env.PLAYWRIGHT_CHROMIUM;
const env={...process.env};
const streamscope=await loadStreamscope();const browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{}),args:['--no-sandbox','--disable-dev-shm-usage'],env});
try{
 const control=await runCase({browser,streamscope,seed});assert.equal(control.result.ok,true);
 const delayed=await runCase({browser,streamscope,seed,scenario:'slow(450)'});assert.equal(delayed.result.violation?.invariant,'noStuckStreaming');assert.equal(delayed.manifest.eventualFinish,true);assert.equal(delayed.manifest.finalBusy,'false');await access(path.join(delayed.dir,'delayed-complete.png'));
 const broken=await runCase({browser,streamscope,seed,scenario:'disconnect_at(0.5)'});const repeat=await runCase({browser,streamscope,seed,scenario:'disconnect_at(0.5)'});
 for(const run of [delayed,broken,repeat]){
  assert.equal(run.result.ok,false);assert.equal(run.result.violation?.invariant,'noStuckStreaming');assert.equal(run.result.violation?.step,0);
  for(const f of ['manifest.json','source.jsonl','replay-plan.json'])await access(path.join(run.dir,f));
  for(const f of ['trace','report','repro','dom','screenshot']){assert.ok(run.result.artifacts[f],f);await access(run.result.artifacts[f]);}
  const saved=JSON.parse(await readFile(path.join(run.dir,'manifest.json'),'utf8'));assert.equal(saved.status,'complete');assert.equal(saved.ok,false);
 }
 assert.equal(broken.manifest.sha256,repeat.manifest.sha256);assert.deepEqual(broken.manifest.actualActions,repeat.manifest.actualActions);assert.deepEqual(control.manifest.actualActions,broken.manifest.actualActions);
 assert.equal(broken.result.violation.invariant,repeat.result.violation.invariant);assert.equal(broken.result.violation.step,repeat.result.violation.step);
 console.log(JSON.stringify({seed,control:{ok:control.result.ok,dir:control.dir},delayed:{invariant:delayed.result.violation.invariant,dir:delayed.dir},disconnect:{invariant:broken.result.violation.invariant,dir:broken.dir},repeat:{invariant:repeat.result.violation.invariant,dir:repeat.dir}},null,2));
 console.log('Synthetic integration acceptance passed. Expected fixture failures are preserved, not product bug claims.');
}finally{await browser.close();}
