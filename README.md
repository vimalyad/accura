# Accura

An accuracy-first browser agent. TypeScript, Playwright, model-agnostic —
develop on free models, run on Claude.

Accura optimizes one metric: **task success rate**. Latency is explicitly not
a constraint, so the architecture spends time wherever it buys correctness:
it re-observes after every action, verifies every step, samples multiple
candidates at uncertain decisions, simulates irreversible actions before
running them, and refuses to declare success it cannot prove.

## Quickstart

```sh
pnpm install
pnpm --filter @accura/browser exec playwright install chromium
pnpm build

# run a task (dev profile: local/free models)
node apps/cli/dist/main.js "Find the price of the Super Widget" --url https://example.com --profile dev

# run the eval suite
node apps/cli/dist/main.js eval packages/evals/suites/fixtures.json --profile dev --seeds 3
```

Profiles live in `configs/`. `dev.json` targets free models (Ollama
`qwen2.5vl`, Groq, Gemini free tier); `final.json` targets Claude
(Sonnet 4.6 executor with adaptive thinking, Opus 4.8 planner/judge) and
needs `ANTHROPIC_API_KEY`. Same code, same prompts — the profile is the
only difference.

## How it works

```
task ─► PLANNER (checklist, trigger-driven replanning)
loop:  browser ──stability gate──► PERCEPTION ─► indexed elements + page text
       skills(memory) injected ─► EXECUTOR (structured output, zod-validated)
            ├─ flagged decision? ─► best-of-3 candidates + judge arbiter
            ├─ irreversible action? ─► simulate outcome, block on mismatch
       ACTIONS (enumerated ids only — no selector hallucination; batched
                with stale-DOM guards; recovery policy hard-blocks repeats)
       STEP VERIFIER (state diff + "nothing changed" contradiction check)
done ─► GROUNDING CHECK (claimed values must exist in observations)
     ─► TRAJECTORY JUDGE (skeptical, key-point based) ─reject─► resume
approve ─► result + skill induction ─► memory ─► faster, more reliable reruns
```

Key design decisions and the research behind them are in
[ARCHITECTURE.md](./ARCHITECTURE.md).

## Packages

| Package | What it does |
|---|---|
| `@accura/shared` | Result type, errors, logging, zod-validated model profiles |
| `@accura/llm` | Provider-agnostic ChatModel (Anthropic SDK + any OpenAI-compatible endpoint), structured output with repair reprompts, role-based model router |
| `@accura/browser` | Playwright session: stability gate, exact-dimension screenshots, popup/dialog/download/crash watchdogs, CDP escape hatch |
| `@accura/perception` | In-page walker → enumerated interactive elements with stable ids, new-element diffing, id→element resolution |
| `@accura/actions` | Zod-validated action registry, 16 core actions, multi-action batching with stale-DOM guards |
| `@accura/verify` | State-diff step verifier, deterministic data-grounding check, skeptical trajectory judge |
| `@accura/agent` | The loop: planner, best-of-N arbiter, simulation gate, recovery policy, done gating, JSONL traces |
| `@accura/memory` | Cross-run skills: induction from verified successes, deterministic replay with live fallback, scoring/retirement |
| `@accura/evals` | Task suites, multi-seed runner, bootstrap CIs, judge-agreement harness, failure clustering |
| `apps/cli` | `accura "<task>"` and `accura eval <suite>` |

## Status

All 8 build phases are implemented and tested (140+ tests, including
browser-integration tests against real Chromium and full-pipeline e2e runs
with scripted oracle models). Pending items that require live model access:

- dev-profile baseline numbers (`packages/evals/REPORTS/README.md`)
- final-profile benchmark on Claude (`--profile final`, needs `ANTHROPIC_API_KEY`)

## Development

```sh
pnpm build      # turbo build across the workspace
pnpm test       # unit + browser integration tests
pnpm lint       # eslint
pnpm typecheck  # tsc --noEmit
```

One branch per phase, merged to `main` after its exit criteria pass; see git
history.
