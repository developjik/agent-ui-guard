# agent-ui-guard

[English](README.md) · 한국어

**스트리밍 AI 에이전트 앱을 위한 속성 기반(property-based) UI · 툴 호출 불변식 테스트.**

[![CI](https://github.com/developjik/agent-ui-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/developjik/agent-ui-guard/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

에이전트 채팅 UI는 평범한 Playwright 테스트가 쳐다보지도 않는 방식으로 망가집니다. 다이얼로그가 동시에 두 개 열리고, 스트림이 `aria-busy`를 끝내 지우지 않고, 툴 호출 스피너가 자기 턴보다 오래 살아남고, UI가 5xx를 삼켜버립니다. 이런 건 *시간적(temporal)* 버그입니다 — 망가진 상태가 40ms만 존재하고 앱이 "복구"되기 때문에 클릭 위주의 테스트는 통과하는데, 사용자는 결국 막힌 채로 남습니다.

`agent-ui-guard`는 카오스 몽키처럼 앱을 돌리면서, 스크립트로 정한 경로의 끝에서만이 아니라 **계속해서** 성립해야 하는 속성을 검사합니다. [Antithesis Bombadil](https://antithesis.com/product/bombadil/)과 속성 기반 테스트에서 착안했고, Playwright 위에 올렸으며, LLM 앱이 실제로 가진 비결정적·스트리밍·툴 호출 UI에 맞춰 설계했습니다.

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

## 설치

```bash
npm install --save-dev agent-ui-guard @playwright/test
```

## 60초 퀵스타트

포함된 픽스처를 띄우고 하네스가 그것을 퍼징하게 하세요:

```bash
npm install
npm run demo            # http://127.0.0.1:5173
npm run fuzz:demo healthy 20 1337
```

`fuzz:demo`는 데모 채팅 앱을 열고 가중치 기반 랜덤 액션 20개를 수행한 뒤 판정을 출력합니다. 대신 망가진 빌드를 겨냥해 보세요:

```bash
npm run fuzz:demo double-modal 12 13     # 두 다이얼로그가 동시에
npm run fuzz:demo orphan-spinner 6        # 절대 끝나지 않는 툴 호출
npm run fuzz:demo stuck-streaming 6       # 절대 끝나지 않는 스트림
npm run fuzz:demo http-500 6              # 모델 게이트웨이의 5xx
```

실패한 실행마다 `.agent-ui-guard/fuzz-<mode>/run-…-failed/`에 재생 가능한 트레이스, 마크다운 리포트, 스크린샷, 바로 수정할 수 있는 `repro.spec.ts`가 남습니다.

## 내 앱에 적용하기

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

테스트 프레임워크가 없어도 되나요? `runExploration`은 결과 객체를 돌려주므로 그냥 Node 스크립트에서 호출해도 됩니다(`scripts/fuzz-demo.ts` 참고).

## DOM 계약

런타임은 셀렉터 기반이라 React, Vue, Svelte, htmx, 바닐라 DOM 어디서든 동작합니다. 기본값은 일반적인 ARIA/data 관례를 따르고, 앱이 다른 이름을 쓴다면 `contract`로 어느 부분이든 덮어쓸 수 있습니다.

| 개념 | 기본 셀렉터 / 속성 | 의미 |
|---|---|---|
| 모달 | `[aria-modal="true"]` (표시 중) | 닫지 않고는 사용자가 벗어날 수 없는 다이얼로그 |
| 스트리밍 | `[data-streaming="true"]`, `[aria-busy="true"]` | 모델 응답이 지금 도착하는 중 |
| 툴 호출 | `[data-tool-call]` | 렌더된 툴 호출 카드 하나 |
| 툴 호출 id | `data-tool-call-id` | 안정적인 id (신뢰할 수 있는 추적에 필수) |
| 툴 호출 이름 | `data-tool-call-name` | 실패 메시지에 표시됨 |
| 툴 호출 상태 | `data-state` | `pending` / `running` / `done` / `error` / `cancelled` |
| 턴 | `[data-turn]` | 어시스턴트 턴 하나 |
| 턴 id | `data-turn-id` | 안정적인 id |
| 턴 상태 | `data-turn-state` | `streaming` / `done` / `error` / `cancelled` |

카드는 자기 턴이 끝나기 **전에 또는 끝나는 시점에** `done`, `error`, `cancelled` 중 하나에 도달해야 합니다. 터미널 상태 없이 카드를 제거하면 고아(orphan)로 집계되므로, 앱이 완료된 툴 호출을 언마운트한다면 먼저 상태를 설정하세요.

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

## 내장 불변식

```ts
import { builtinInvariants } from 'agent-ui-guard';
const invariants = builtinInvariants({
  maxStreamMs: 8_000,      // longest allowed streaming episode
  settleTimeoutMs: 8_000,  // longest a tool call may stay non-terminal
  ignoreErrors: [/ResizeObserver loop/],
});
```

| 불변식 | 실패 조건 |
|---|---|
| `singleModalAtATime` | 같은 순간에 모달이 둘 이상 보였을 때, 한 프레임이라도 |
| `noStuckStreaming` | 스트리밍 구간이 `maxStreamMs`를 넘겼을 때 — 끊긴 SSE/WS 연결이 `aria-busy`를 지우지 않는 경우 |
| `toolCallBalanced` | 툴 호출이 터미널 상태에 도달하지 못했을 때: 턴이 먼저 끝났거나, 카드가 언마운트됐거나, `settleTimeoutMs` 이후에도 `running`인 경우 |
| `noConsoleOrPageErrors` | `console.error`나 잡히지 않은 예외가 발생했을 때 |
| `noHttp5xx` | 상태가 500 이상인 응답이 있을 때 |

각각은 평범한 객체라서 단독으로 쓰거나 조합하거나 감쌀 수 있습니다:

```ts
import { singleModalAtATime, toolCallBalanced } from 'agent-ui-guard';

const invariants = [
  singleModalAtATime({ name: 'settings never stacks' }),
  toolCallBalanced({ settleTimeoutMs: 3_000 }),
];
```

## 나만의 불변식 작성하기

`always`는 매 스텝 후(그리고 시작 시점에) 평가됩니다. `false` 또는 `{ ok: false, message, evidence }`를 반환하면 실행이 실패합니다.

```ts
always('transcript is never empty after a send', async ({ page }) => {
  const turns = page.locator('[data-turn]');
  if ((await turns.count()) === 0) return false;
  return true;
});
```

`eventually`는 속성이 성립할 때까지 폴링합니다. 데드라인은 그 속성이 만족되지 않음을 처음 확인한 시점부터 시작하므로, 몇 초 뒤에 도착하는 결과도 지켜볼 수 있습니다.

```ts
eventually('assistant answer is complete', async ({ page }) => {
  const last = page.locator('[data-role="assistant"]').last();
  return (await last.getAttribute('data-streaming')) === null;
}).within(15_000);
```

검사 함수는 `{ page, step, ledger, trace }`를 받습니다:

- `ledger` — 지금까지 관찰한 모든 것(모달, 스트리밍 구간, 툴 호출, 콘솔 에러, 5xx). 읽는 데 비용이 들지 않으며 페이지 왕복이 없습니다.
- `trace` — 지금까지 실행한 스텝. "스텝 N 이후로는 다시는 일어나지 않는다" 같은 속성에 유용합니다.

## 액션

액션은 사용자가 할 수 있는 일 하나입니다. 드라이버는 가중치로 액션을 고르고, 선택된 파라미터를 기록하며, 트레이스에서 그대로 재생합니다.

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

내장 헬퍼: `sendPrompt`, `clickTarget`, `pressEscape`, `waitRandom`. 예외를 던지는 액션은 기본적으로 no-op으로 기록됩니다(`strictActions: true`면 실행을 실패시킴) — 퍼저는 버튼이 정당하게 비활성화됐다는 이유로 멈춰서는 안 됩니다.

## 결정성, 트레이스, 재생

- 같은 `seed`는 항상 같은 액션 시퀀스를 만듭니다. 파라미터도 같은 시드 PRNG에서 나옵니다.
- 모든 실행은 `trace.json`을 남깁니다: 시드, URL, 뷰포트, 파라미터가 붙은 모든 스텝, 페이지 관찰값, 그리고 위반 내용.
- `replayTrace`는 기록된 스텝을 다시 실행하므로 간헐적 버그가 결정적 버그가 됩니다:

```ts
import { readTraceFile, replayTrace, builtinInvariants } from 'agent-ui-guard';

const trace = await readTraceFile('test-results/…/trace.json');
const replay = await replayTrace({ page, trace, actions, invariants: builtinInvariants() });
expect(replay.violation?.invariant).toBe(trace.violation?.invariant);
```

### 실패 아티팩트

```
run-20261121-132129-seed7-failed/
├── trace.json       # exact steps + observations, replayable
├── report.md        # human-readable summary and step table
├── repro.spec.ts    # Playwright test with the recorded plan filled in
├── dom.html         # DOM at the moment of failure
└── failure.png      # full-page screenshot
```

`repro.spec.ts`에서 고칠 곳은 하나입니다: `ACTIONS` import를 내 액션 정의를 가리키게 바꾸면 됩니다. URL, 시드, 플랜, 기대 불변식 등 나머지는 모두 채워져 있습니다.

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

PR마다 시드 하나를 돌리고, 매일 밤 시드 매트릭스(예: `SEED=$(date +%s)`)를 돌려 새로운 인터리빙을 계속 탐색하세요.

## API 한눈에 보기

| Export | 목적 |
|---|---|
| `runExploration(options)` | 액션 구동, settle, 불변식 검사, 아티팩트 기록 |
| `replayTrace({ page, trace, actions })` | 기록된 트레이스 재실행 |
| `readTraceFile(path)` | `trace.json` 로드 |
| `Guard.install(page)` | 런타임을 직접 부착 (고급) |
| `guard.snapshot()` / `guard.ledger()` / `guard.settle()` | UI 상태 읽기 또는 대기 |
| `builtinInvariants(options)` | 위의 다섯 가지 불변식 |
| `always(name, check)` / `eventually(name, check).within(ms)` | 나만의 불변식 정의 |
| `sendPrompt` / `clickTarget` / `pressEscape` / `waitRandom` / `defineAction` | 액션 헬퍼 |

### `runExploration` 옵션

| 옵션 | 기본값 | 의미 |
|---|---|---|
| `page`, `url`, `actions` | — | 필수 |
| `invariants` | `[]` | 검사할 속성 |
| `seed` | 랜덤 | 트레이스에 기록됨 |
| `steps` | `plan.length` 또는 30 | 액션 개수 |
| `plan` | — | 랜덤 대신 고정 액션 시퀀스 |
| `settleTimeoutMs` | 5000 | 액션 후 UI가 바쁜 상태로 머물 수 있는 시간 |
| `timeBudgetMs` | — | 이 시간을 넘기면 새 스텝을 시작하지 않음 |
| `outputDir` | `.agent-ui-guard` | 아티팩트 상위 폴더 |
| `writeArtifacts` | `true` | trace/report/repro 기록 |
| `screenshotOnFailure` | `true` | `failure.png` 캡처 |
| `strictActions` | `false` | 액션 오류 시 실행 실패 |
| `throwOnViolation` | `false` | `ok: false` 대신 예외 발생 |
| `contract` | 기본값 | DOM 계약 덮어쓰기 |
| `ignoreErrors` | `[]` | 무시할 콘솔 에러 패턴 |

## 데모 픽스처

`demo/`는 의존성 없는 스트리밍 채팅 앱(SSE, 툴 호출, 세션, 모달)으로 계약을 구현합니다. `npm run demo`로 띄우고 모드를 넘겨 알려진 버그를 재현하세요:

| 모드 | 주입되는 버그 | 잡는 불변식 |
|---|---|---|
| `healthy` | 없음 | — |
| `double-modal` | 팔레트를 열어도 Settings가 열린 채 남음 | `singleModalAtATime` |
| `orphan-spinner` | `web.search`가 아직 실행 중인데 턴이 닫힘 | `toolCallBalanced` |
| `stuck-streaming` | 인디케이터를 지우지 않은 채 스트림이 끝남 | `noStuckStreaming` |
| `http-500` | 두 번째 프롬프트가 500을 반환 | `noHttp5xx` |

`npm run test:e2e`는 기록된 트레이스 재생을 포함해 모든 모드에 대해 하네스를 돌립니다.

## 왜 페이지 안의 연속 옵저버인가?

Playwright 어설션은 요청할 때 페이지를 샘플링합니다. 그래서 이 도구가 존재하는 이유인 버그 유형을 놓칩니다: 같은 프레임에 그려진 두 모달, 렌더 한 번만 살아남는 스피너, 마이크로태스크 안에서 켜졌다 꺼지는 플래그. 런타임은 모든 DOM 변경마다 샘플링하고 제한된 이벤트 로그를 유지하므로, 불변식은 *지금 화면에 보이는 것*만이 아니라 *무슨 일이 있었는지*에 대해 평가됩니다.

런타임은 직렬화된 함수가 아니라 소스 텍스트(`buildRuntimeScript`)로 주입되기 때문에 tsx/esbuild, Vitest, Playwright 러너에서 똑같이 동작합니다.

## 한계

- 페이지 하나, 탭 하나입니다. 탭 간 불변식은 아직 다루지 않습니다.
- Shadow DOM: 공개된 `querySelectorAll`은 열린 루트에만 닿습니다.
- 런타임은 관찰만 하고 고치지 않습니다. 위반은 실행을 실패시킬 뿐 앱을 변경하지 않습니다.
- 타이밍 예산(`maxStreamMs`, `settleTimeoutMs`)은 가장 느린 정상 스트림보다 넉넉하게, 특히 CI에서 크게 잡아야 합니다.

## 로드맵

- WebSocket 트랜스포트 트레이싱 및 요청 재생
- Shadow DOM·iframe 관통
- 축소(shrinking): 위반 지점만 잘라내는 것이 아니라 실패한 트레이스를 자동으로 최소화
- 시드 코퍼스를 쓰는 멀티 시드 야간 모드

## 라이선스

MIT © 2026 jungingwon (developjik)

## 개발 기준선 (DEV-128)

개발과 CI는 Node.js 22.12.0(`.nvmrc`) 이상을 사용합니다. Vitest 5.1.1의 공식 지원 범위에는 Node 20.19가 없습니다. 실행이 된다는 이유로 공식 지원이라고 부르지 않습니다. 패키지 사용자의 기존 engines는 유지합니다. Node 20 지원 패키지는 테스트 러너 없이 빌드한 tarball의 운영 의존성만 설치하고 CLI/import를 별도로 검사합니다. 개발 TypeScript 기준은 7.0.2입니다.
