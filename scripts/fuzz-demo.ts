import { chromium } from '@playwright/test';
import { demoActions } from '../demo/actions.js';
import { DEMO_MODES, startDemoServer, type DemoMode } from '../demo/server.js';
import {
  always,
  builtinInvariants,
  eventually,
  formatMs,
  runExploration,
} from '../src/index.js';

const args = process.argv.slice(2).filter(arg => arg !== '--shrink');
const mode = (args[0] ?? 'healthy') as DemoMode;
const steps = Number(args[1] ?? 30);
const seed = Number(args[2] ?? 20261121);

if (!DEMO_MODES.includes(mode)) {
  console.error(`Unknown mode "${mode}". Use one of: ${DEMO_MODES.join(', ')}`);
  process.exit(1);
}

const demo = await startDemoServer({ mode });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1120, height: 780 } });

const result = await runExploration({
  page,
  url: demo.url,
  actions: demoActions,
  invariants: [
    ...builtinInvariants({ maxStreamMs: 4_000, settleTimeoutMs: 4_000 }),
    always('composer enabled when idle', async ({ page: p }) =>
      p.locator('#composer-input').isEnabled(),
    ),
    eventually('assistant answer completes', async ({ page: p }) => {
      const last = p.locator('[data-role="assistant"] .content').last();
      if (await last.count() === 0) return true;
      return ((await last.innerText()) ?? '').length > 20;
    }).within(6_000),
  ],
  shrink: process.argv.includes('--shrink'),
  seed,
  steps,
  settleTimeoutMs: 4_000,
  outputDir: `.agent-ui-guard/fuzz-${mode}`,
  onStep: (info) => {
    console.log(
      `step ${String(info.index).padStart(2, '0')}  ${info.action.padEnd(19)} ${info.durationMs}ms ${
        info.ok ? '' : `(no-op: ${info.error ?? 'failed'})`
      }`,
    );
  },
});

if (result.shrink) console.log(`shrink: ${result.shrink.status} (${result.shrink.originalSteps} -> ${result.shrink.reducedSteps} steps, ${result.shrink.attempts} attempts)${result.shrink.reason ? ': ' + result.shrink.reason : ''}`);
if (result.shrink?.artifacts) console.log(`shrunk repro: ${result.shrink.artifacts.repro}`);

await browser.close();
await demo.close();

console.log('');
console.log(`mode=${mode} seed=${result.seed} steps=${result.steps.length} ${formatMs(result.durationMs)}`);
console.log(`result: ${result.ok ? 'PASS' : 'FAIL'}`);
if (result.violation) {
  console.log(`invariant: ${result.violation.invariant} (step ${result.violation.step})`);
  console.log(`  ${result.violation.message}`);
}
if (result.artifacts) {
  console.log(`trace: ${result.artifacts.trace}`);
  console.log(`report: ${result.artifacts.report}`);
  console.log(`repro: ${result.artifacts.repro}`);
}
process.exit(result.ok ? 0 : 1);
