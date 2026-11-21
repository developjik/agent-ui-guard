import { startDemoServer, DEMO_MODES, type DemoMode } from './server.js';

const modeArg = (process.argv[2] ?? 'healthy') as DemoMode;
if (!DEMO_MODES.includes(modeArg)) {
  console.error(`Unknown mode "${modeArg}". Use one of: ${DEMO_MODES.join(', ')}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 5173);
const demo = await startDemoServer({ mode: modeArg, port });
console.log(`chat-desk fixture (${demo.mode}) listening on ${demo.url}`);
console.log('Open it in a browser and click around; Ctrl+C stops the server.');
