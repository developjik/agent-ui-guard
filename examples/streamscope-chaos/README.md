# Synthetic stream chaos PoC

This opt-in example connects the real streamscope replay HTTP server to a local Playwright fixture and the existing agent-ui-guard runner. It changes neither package's default command nor API. No real trace importer, hosted service, npm publication, credentials or external app is involved.

## Run

Use Node22.18+ for the companion build and the existing development tools. From the agent-ui-guard checkout:

```sh
npm ci
npm run build
npx playwright install chromium
# Pick a separate directory for the pinned companion checkout.
git clone https://github.com/developjik/streamscope.git ../streamscope-chaos-companion
git -C ../streamscope-chaos-companion checkout 17e5bb642c68d83d0a3f17f05e0fc03e1dbfeb1f
(cd ../streamscope-chaos-companion && npm ci && npm run build)
STREAMSCOPE_ENTRY=../streamscope-chaos-companion/dist/index.js node examples/streamscope-chaos/run.mjs --seed 1337
```

`STREAMSCOPE_ENTRY` is an explicit trusted-code import, not a trace input. Only point it at a companion checkout you control. The loader requires a clean tracked checkout at the fixed commit and the built `dist/index.js` location. Build it as above. It does not authenticate arbitrary built output. `PLAYWRIGHT_CHROMIUM` optionally selects an installed Chromium; otherwise Playwright's installed browser is used.

The script runs four fresh contexts with the same seed, action plan and `noStuckStreaming(maxStreamMs:900)` invariant:

- Recorded control: completes and clears busy.
- `slow(450)`: delayed finish crosses the fixture's900ms limit; the adapter then separately waits for the actual finish and saves a second screenshot proving busy cleared.
- `disconnect_at(0.5)`: no finish arrives, leaving the intentionally buggy fixture busy.
- Identical disconnect repetition: must find the same invariant at the same action step.

The fixture deliberately clears busy only on a finish event. These expected failures demonstrate the wiring, not newly discovered bugs in streamscope, agent-ui-guard or a real product. The action sequence is a fixed one-step replay; the seed is recorded and held equal, not used to claim a wider random exploration. Millisecond timestamps, ephemeral ports and run paths vary. Reproducibility means the same source hash, action parameters, fault settings, invariant and violating step, not byte-identical wall-clock logs.

## Evidence

Each atomic `test-results/streamscope-chaos/case-*` directory starts with `source.jsonl` and `manifest.json` before servers or browser contexts start. The manifest includes source SHA256, trace ID, companion commit, seed, fixed actions, fault scenario, invariant threshold and full matrix rerun command. `replay-plan.json` preserves the actual transformed stream. Completed runs add their verdict and actual actions; unexpected runtime errors mark the manifest as `error` and remain thrown, never a passing result.

The existing guard runner writes trace, report and repro under the same case directory. Expected failures retain a DOM snapshot and screenshot. The generic `repro.spec.ts` is a starting point: its ephemeral fixture URL is not a standalone server. Use the manifest command above to recreate the synthetic fixture and all four cases. CI uploads the entire bundle even when the assertion script fails, retained7days. Do not put actual user traces or secrets in these artifacts. The only inputs here are code-owned synthetic data.

Both servers bind to loopback on ephemeral ports. Browser routing permits only those two origins. Contexts and servers close in a `finally` path. Faults are an allowlisted set for this example; there is no shell evaluation or URL supplied by a trace. Transport disconnect is a real socket close from streamscope, not a fabricated guard ledger.

## Boundary

This PoC does not implement trace shrinking, production capture, automatic repair, a public playground or a real-app safety claim. Real trace use needs separate redaction and retention review under the repository's existing artifact rules.
