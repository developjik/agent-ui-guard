# agent-ui-guard

**Property-based UI and tool-call invariant testing for streaming AI agent apps.**

[![CI](https://github.com/developjik/agent-ui-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/agent-ui-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Agent chat UIs fail in ways ordinary Playwright tests never look at: two dialogs open at once, a stream that never clears its `aria-busy`, a tool-call spinner that outlives the turn it belonged to, a 5xx that the UI swallows. These are *temporal* bugs — the broken state exists for 40 ms and then the app "recovers" — so a click-through test passes and the user still ends up stuck.

`agent-ui-guard` runs your app like a chaos monkey and asserts properties that must hold **continuously**, not just at the end of a scripted path. It is inspired by [Antithesis Bombadil](https://antithesis.com/product/bombadil/) and property-based testing, built on Playwright, and shaped for the non-deterministic, streaming, tool-calling UIs that LLM apps actually have.

```
┌────────────────────────── page ───────────────────────────┐
│  in-page runtime (addInitScript)                          │
│  MutationObserver + sampler                               │
│    modals · streaming · tool calls · turns                │
│              │ snapshot()                                 │
└──────────────┼────────────────────────────────────────────┘
               ▼
        ledger (DOM events + console errors + HTTP 5xx)
               ▲
┌──────────────┴────────────────────────────────────────────┐
│  runner (Node, Playwright)                                 │
│  weighted random actions → settle → check invariants       │
│  violation → trace.json + report.md + repro.spec.ts + png │
└───────────────────────────────────────────────────────────┘
```

## Install

```bash
npm install --save-dev agent-ui-guard @playwright/test
```

## 60-second quickstart

Start the included fixture, then let the harness fuzz it:

```bash
npm install
npm run demo            # http://127.0.0.1:5173
npm run fuzz:demo healthy 20 1337
```

`fuzz:demo` opens the demo chat app, performs 20 weighted random actions, and
prints a verdict. Point it at a broken build instead:

```bash
npm run fuzz:demo double-modal 12 13     # two dialogs at once
npm run fuzz:demo orphan-spinner 6        # a tool call that never settles
npm run fuzz:demo stuck-streaming 6       # a stream that never ends
npm run fuzz:demo http-500 6              # a 5xx from the model gateway
```

Each failing run writes `.agent-ui-guard/fuzz-<mode>/run-…-failed/` with a
replayable trace, a Markdown report, a screenshot and a ready-to-edit
`repro.spec.ts`.

## Use it on your app

```ts
import { test, expect } from '@playwright/test';
import {
  always,
  builtinInvariants,
  eventually,
  runExploration,
  sendPrompt,
  type ActionDefinition,
} from 'agent-ui-guard';

const actions: ActionDefinition[] = [
  sendPrompt('#composer-input', ['Summarise this PR', 'What is failing in CI?']),
  // …one entry per user action, see “Actions” below
];

test('agent chat UI survives 40 random actions', async ({ page }) => {
  const result = await runExploration({
    page,
    url: 'http://localhost:3000',
    actions,
    invariants: [
      ...builtinInvariants({ maxStreamMs: 8_000, settleTimeoutMs: 8_000 }),
      always('composer is enabled when idle', async ({ page }) =>
        page.locator('#composer-input').isEnabled(),
      ),
      eventually('the answer settles', async ({ page }) =>
        (await page.locator('[data-turn-state="done"]').count()) > 0,
      ).within(10_000),
    ],
    seed: 1337,
    steps: 40,
  });

  expect(result.violation, result.violation?.message).toBeNull();
});
```

No test framework? `runExploration` returns a result object; you can call it from
a plain Node script (see `scripts/fuzz-demo.ts`).

## The DOM contract

The runtime is selector-driven, so it works with React, Vue, Svelte, htmx or
vanilla DOM. Defaults follow ordinary ARIA/data conventions; override any part
with `contract` when your app names things differently.

| Concept | Default selector / attribute | Meaning |
|---|---|---|
| Modal | `[aria-modal="true"]` (visible) | A dialog the user can't leave without dismissing |
| Streaming | `[data-streaming="true"]`, `[aria-busy="true"]` | A model response is arriving right now |
| Tool call | `[data-tool-call]` | One rendered tool-call card |
| Tool-call id | `data-tool-call-id` | Stable id (required for reliable tracking) |
| Tool-call name | `data-tool-call-name` | Shown in failure messages |
| Tool-call state | `data-state` | `pending` / `running` / `done` / `error` / `cancelled` |
| Turn | `[data-turn]` | One assistant turn |
| Turn id | `data-turn-id` | Stable id |
| Turn state | `data-turn-state` | `streaming` / `done` / `error` / `cancelled` |

A card must reach `done`, `error` or `cancelled` **before or when** its turn
ends. Removing a card without a terminal state counts as an orphan, so if your
app unmounts completed tool calls, set the state first.

```ts
runExploration({
  // …
  contract: {
    streamingSelector: '[data-generating], [aria-busy="true"]',
    toolCallSelector: '.tool-invocation',
    toolCallStateAttr: 'data-status',
  },
});
```

## Built-in invariants

```ts
import { builtinInvariants } from 'agent-ui-guard';
const invariants = builtinInvariants({
  maxStreamMs: 8_000,      // longest allowed streaming episode
  settleTimeoutMs: 8_000,  // longest a tool call may stay non-terminal
  ignoreErrors: [/ResizeObserver loop/],
});
```

| Invariant | Fails when |
|---|---|
| `singleModalAtATime` | More than one modal was visible at the same moment, even for one frame |
| `noStuckStreaming` | A streaming episode outlives `maxStreamMs` — a dropped SSE/WS connection that never clears `aria-busy` |
| `toolCallBalanced` | A tool call never reaches a terminal state: its turn finished first, the card was unmounted, or it is still `running` after `settleTimeoutMs` |
| `noConsoleOrPageErrors` | `console.error` or an uncaught exception fires |
| `noHttp5xx` | Any response has status ≥ 500 |

Each one is a plain object, so you can use it alone, combine it, or wrap it:

```ts
import { singleModalAtATime, toolCallBalanced } from 'agent-ui-guard';

const invariants = [
  singleModalAtATime({ name: 'settings never stacks' }),
  toolCallBalanced({ settleTimeoutMs: 3_000 }),
];
```

## Writing your own invariants

`always` is evaluated after every step (and at startup). Return `false` or
`{ ok: false, message, evidence }` to fail the run.

```ts
always('transcript is never empty after a send', async ({ page }) => {
  const turns = page.locator('[data-turn]');
  if ((await turns.count()) === 0) return false;
  return true;
});
```

`eventually` polls until the property holds. The deadline starts at the first
check that finds it unsatisfied, so you can watch for an outcome that arrives a
few seconds later.

```ts
eventually('assistant answer is complete', async ({ page }) => {
  const last = page.locator('[data-role="assistant"]').last();
  return (await last.getAttribute('data-streaming')) === null;
}).within(15_000);
```

Checks receive `{ page, step, ledger, trace }`:

- `ledger` — everything observed so far (modals, streaming episodes, tool calls,
  console errors, 5xx). Reading it is free; no page round-trip.
- `trace` — the steps executed so far, useful for “this never happens again
  after step N” style properties.

## Actions

An action is one thing a user can do. The driver picks them by weight, records
the chosen parameters, and replays them verbatim on a trace.

```ts
import { defineAction, clickTarget, sendPrompt, pressEscape } from 'agent-ui-guard';

const actions = [
  sendPrompt('#composer-input', ['Summarise this PR']),           // weight 4
  clickTarget('openSettings', '#open-settings', { weight: 2 }),
  pressEscape(),                                                  // weight 1
  defineAction({
    name: 'switchSession',
    weight: 2,
    params: (rng) => ({ slot: rng.int(5) }),
    async run({ page, params }) {
      await page.locator('.session').nth(Number(params.slot)).click({ timeout: 1_000 });
    },
  }),
];
```

Built-in helpers: `sendPrompt`, `clickTarget`, `pressEscape`, `waitRandom`.
Actions that throw are recorded as no-ops by default (`strictActions: true` makes
them fail the run) — a fuzzer should not stop because a button was legitimately
disabled.

## Determinism, traces and replay

- The same `seed` always produces the same action sequence; the parameters come
  from the same seeded PRNG.
- Every run writes a `trace.json`: seed, URL, viewport, every step with its
  parameters, page observations and the violation.
- `replayTrace` re-executes the recorded steps, so a flaky bug becomes a
  deterministic one:

```ts
import { readTraceFile, replayTrace, builtinInvariants } from 'agent-ui-guard';

const trace = await readTraceFile('test-results/…/trace.json');
const replay = await replayTrace({ page, trace, actions, invariants: builtinInvariants() });
expect(replay.violation?.invariant).toBe(trace.violation?.invariant);
```

### Failure artifacts

```
run-20261121-132129-seed7-failed/
├── trace.json       # exact steps + observations, replayable
├── report.md        # human-readable summary and step table
├── repro.spec.ts    # Playwright test with the recorded plan filled in
├── dom.html         # DOM at the moment of failure
└── failure.png      # full-page screenshot
```

`repro.spec.ts` needs one edit: point its `ACTIONS` import at your action
definitions. Everything else — URL, seed, plan, expected invariant — is filled
in.

## CI

```yaml
name: e2e

on: [push, pull_request]

jobs:
  fuzz:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: agent-ui-guard
          path: test-results/
```

Run one seed per PR and a nightly matrix of seeds (e.g. `SEED=$(date +%s)`) to
keep exploring new interleavings.

## API at a glance

| Export | Purpose |
|---|---|
| `runExploration(options)` | Drive actions, settle, check invariants, write artifacts |
| `replayTrace({ page, trace, actions })` | Re-execute a recorded trace |
| `readTraceFile(path)` | Load a `trace.json` |
| `Guard.install(page)` | Attach the runtime yourself (advanced) |
| `guard.snapshot()` / `guard.ledger()` / `guard.settle()` | Read or wait for UI state |
| `builtinInvariants(options)` | The five invariants above |
| `always(name, check)` / `eventually(name, check).within(ms)` | Define your own |
| `sendPrompt` / `clickTarget` / `pressEscape` / `waitRandom` / `defineAction` | Action helpers |

### `runExploration` options

| Option | Default | Meaning |
|---|---|---|
| `page`, `url`, `actions` | — | Required |
| `invariants` | `[]` | Properties to check |
| `seed` | random | Recorded in the trace |
| `steps` | `plan.length` or 30 | Number of actions |
| `plan` | — | Fixed action sequence instead of random |
| `settleTimeoutMs` | 5000 | How long the UI may stay busy after an action |
| `timeBudgetMs` | — | Stop starting new steps after this long |
| `outputDir` | `.agent-ui-guard` | Artifact parent folder |
| `writeArtifacts` | `true` | Write trace/report/repro |
| `screenshotOnFailure` | `true` | Capture `failure.png` |
| `strictActions` | `false` | Fail the run on an action error |
| `throwOnViolation` | `false` | Throw instead of returning `ok: false` |
| `contract` | defaults | DOM contract overrides |
| `ignoreErrors` | `[]` | Console error patterns to ignore |

## The demo fixture

`demo/` is a dependency-free streaming chat app (SSE, tool calls, sessions,
modals) that implements the contract. Start it with `npm run demo` and pass a
mode to reproduce a known bug:

| Mode | Injected bug | Caught by |
|---|---|---|
| `healthy` | none | — |
| `double-modal` | opening the palette leaves Settings open | `singleModalAtATime` |
| `orphan-spinner` | the turn closes while `web.search` is still running | `toolCallBalanced` |
| `stuck-streaming` | the stream ends without clearing the indicator | `noStuckStreaming` |
| `http-500` | the second prompt returns 500 | `noHttp5xx` |

`npm run test:e2e` runs the harness against every mode, including a replay of
the recorded trace.

## Why a continuous in-page observer?

Playwright assertions sample the page when you ask. That misses the bug class
this tool exists for: two modals painted in the same frame, a spinner that
survives one render, a flag flipped and cleared inside a microtask. The runtime
samples on every DOM mutation and keeps a bounded event log, so an invariant is
evaluated against *what happened*, not only against *what is on screen right
now*.

The runtime is injected as source text (`buildRuntimeScript`) rather than as a
serialized function, so it behaves identically under tsx/esbuild, Vitest and the
Playwright runner.

## Limitations

- One page, one tab; cross-tab invariants are not covered yet.
- Shadow DOM: public `querySelectorAll` only reaches open roots.
- The runtime observes; it does not repair. A violation fails the run — it never
  mutates your app.
- Timing budgets (`maxStreamMs`, `settleTimeoutMs`) must be set above the
  slowest legitimate stream, especially on CI.

## Roadmap

- WebSocket transport tracing and request replay
- Shadow DOM and iframe piercing
- Shrinking: automatically minimize a failing trace, not just trim it at the violation
- Multi-seed nightly mode with a seed corpus

## License

MIT © 2026 jungingwon (developjik)
