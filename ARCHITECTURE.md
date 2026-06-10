# Accura — Accuracy-First Browser Agent Architecture

**Stack:** TypeScript · pnpm + Turborepo monorepo · Playwright
**Optimization target:** Task success rate. Latency is explicitly NOT a constraint. Token cost matters only in dev (free models) — final runs use Anthropic Claude.

---

## 1. Design thesis

Research across browser-use (source-level), Stagehand, Magnitude, Skyvern, Playwright MCP, and the 2024–2026 academic literature converges on a ranked list of what actually moves accuracy:

| Rank | Technique | Measured evidence |
|---|---|---|
| 1 | Observation/action-space engineering (clean, enumerated, indexed element list — no raw DOM noise) | AgentOccam: +26.6 pts absolute on WebArena from this change alone |
| 2 | Workflow/skill memory (replay verified site-specific skills deterministically) | AWM: +51% relative WebArena; SkillWeaver: +31.8% relative, transfers to weaker models (+54%) |
| 3 | Separate Planner + Executor with dynamic replanning | Plan-and-Act: +34% relative WebArena-Lite |
| 4 | Test-time scaling at decision points (best-of-N + judge arbiter, simulation before irreversible actions) | Tree search: +28–40% relative (Koh et al.); WebDreamer simulation safe on live sites |
| 5 | Verification: step-level state-diff checks + skeptical trajectory judge gating `done` | WebJudge: ~85% human agreement; Web Bench: #1 failure mode is *completion hallucination* |
| 6 | Hybrid grounding: indexed a11y/DOM elements + screenshot; coordinate-vision fallback | SeeAct: textual-choice grounding beat SoM for web; Magnitude: pure vision viable with Claude-class VLMs for canvas/sliders |
| 7 | Error recovery: bounded retries with *changed* strategy, rollback, loop detection | BacktrackAgent, WebRollback; browser-use prompt rules |

The architecture below is these seven findings turned into packages. Because latency doesn't matter, we spend it everywhere it buys accuracy: re-observe after every action, verify every step, sample multiple candidates at ambiguous decisions, and judge before declaring success.

A second thesis from browser-use's "bitter lesson" posts: **don't build rigid framework abstractions that fight the model** (they deleted their planner/validator *modules* but kept planning/validation as *prompt-structured fields and separate model calls*). So: scaffolds are model calls with structured outputs, not hard-coded state machines — easy to retune as models improve.

---

## 2. Monorepo layout

```
accura/
├── pnpm-workspace.yaml
├── turbo.json
├── packages/
│   ├── shared/          # types, Result<T,E>, logger, config, errors
│   ├── llm/             # provider-agnostic LLM client + model router
│   ├── browser/         # Playwright harness: session, tabs, watchdogs, screenshots
│   ├── perception/      # page → AgentObservation (indexed elements, a11y, vision)
│   ├── actions/         # action registry: Zod schemas + grounded executors
│   ├── agent/           # the loop: planner, executor, step-evaluator, recovery
│   ├── verify/          # step verifier (state-diff) + trajectory judge (gates done)
│   ├── memory/          # trajectory store, skill induction, skill replay w/ self-heal
│   └── evals/           # task suites, runner, LLM judge, regression tracking
├── apps/
│   ├── cli/             # `accura run "task..." --profile dev|final`
│   └── trace-viewer/    # (later) step-by-step trajectory replay UI
└── configs/             # model profiles: dev.json (free models), final.json (Claude)
```

Tooling: pnpm workspaces, Turborepo for build/test pipelines, tsup or tsc builds, Vitest, Zod everywhere as the single schema source (LLM tool schemas are generated from Zod via `zod-to-json-schema`).

Dependency direction (no cycles):
`shared ← llm ← (perception, actions, verify, memory) ← agent ← evals/cli`
`browser` depends only on `shared`; `perception`/`actions` depend on `browser`.

---

## 3. Package specs

### 3.1 `@accura/llm` — provider abstraction + model router

```ts
interface ChatModel {
  id: string;
  caps: { vision: boolean; toolUse: boolean; structured: boolean; coordinateGrounded: boolean };
  generate(req: ChatRequest): Promise<ChatResponse>;
  generateStructured<T>(req: ChatRequest, schema: z.ZodType<T>): Promise<T>;
}
```

- **Providers:** `anthropic` (final runs), `openai-compatible` (covers Ollama, Groq, OpenRouter free tier, Gemini via OpenAI endpoint — one adapter handles all free dev models).
- **Structured output strategy:** tool-calling with `strict` JSON schema where supported; constrained-decode via Ollama `format`; fallback = JSON-mode + Zod parse + one repair-reprompt on validation failure. The agent NEVER consumes unvalidated model text.
- **Model router:** roles → models, from a profile file. Roles: `planner`, `executor`, `judge`, `extractor`, `skill-inductor`.
  - `configs/dev.json`: e.g. executor = `qwen2.5-vl` (Ollama) or Gemini Flash free tier; judge = a *different* free model (judge ≠ actor matters — judges are gameable by their own model family).
  - `configs/final.json`: executor = `claude-sonnet-4-6` (Anthropic's own guidance: Sonnet 4.6 is the most mechanically precise at UI interaction), planner/judge = `claude-opus-4-x`, extractor = Sonnet.
- **Capability degradation:** if `caps.vision=false` (some free models), perception runs DOM-only and the vision verifier is skipped — the same codepath, fewer signals. This is what makes "free models in dev, Claude at the end" a config change, not a code change.
- Retries with exponential backoff, request/response logging into the trace.

### 3.2 `@accura/browser` — Playwright harness

Playwright (as required) with the lessons browser-use/Stagehand learned baked in at the *usage* level:

- One `BrowserSession` owns a `BrowserContext`; persistent profiles supported (`launchPersistentContext`) for authenticated sessions.
- **Stability gate before every observation:** wait for `domcontentloaded` → network quiet (no >2 inflight for 500ms, capped) → two consecutive equal DOM mutation counts (MutationObserver via init script). Stale observations are a top silent accuracy killer.
- **CDP escape hatch:** `context.newCDPSession(page)` is wrapped and available to `perception` (for `Accessibility.getFullAXTree`, paint-order data) and to recovery (crash detection via `Inspector.targetCrashed`). The Playwright dependency is isolated behind a `BrowserDriver` interface so a CDP-native driver could be swapped in later without touching the agent.
- **Watchdogs (event-driven, browser-use pattern):** popup/new-tab adoption, JS dialog auto-handling (reported into the observation), download capture, crash detection → session restart with state restore (re-navigate to last URL).
- Screenshot service: viewport screenshots, resized for the model with **exact dimension bookkeeping** — the size reported to Claude must equal the bytes sent (mismatch = systematic click offset; the #1 silent killer for coordinate actions per Anthropic docs).
- Frame handling: iframe tree walked; per-frame locators; element records carry their frame path.

### 3.3 `@accura/perception` — the observation builder (highest-leverage package)

Produces one `AgentObservation` per step:

```ts
interface AgentObservation {
  url: string; title: string; tabs: TabInfo[];
  elements: IndexedElement[];     // the enumerated action space
  elementsText: string;           // serialized tree the LLM sees (≤40k chars)
  pageStats: PageStats;           // counts + "page looks empty/skeleton" warnings
  scrollContext: ScrollInfo;      // "0.5 pages above, 2.3 below"
  newElementIndices: number[];    // diff vs previous step → marked with `*`
  screenshot?: Buffer;            // when vision model in play
  pendingDialogs: string[]; downloads: string[];
}
```

Pipeline (distilled from browser-use's serializer, the strongest open implementation):
1. **Collect:** Playwright `ariaSnapshot` + CDP `Accessibility.getFullAXTree` + DOM snapshot per frame; JS-click-listener detection via injected script (catches React/Vue/Angular handlers with no semantic markup).
2. **Interactivity detection (layered):** AX properties (focusable/editable/checked/expanded) → tag whitelist → interactive ARIA roles → onclick/tabindex attrs → `cursor:pointer` fallback → icon-size heuristic. Labels with `for=` excluded (double-activation bug).
3. **Noise removal:** occluded-element filtering (paint order), bounding-box containment (don't list 5 spans inside one button; keep form controls and aria-labeled children), SVG collapse, attribute dedup + 100-char caps, viewport-window with 1000px lookahead and "N more below — scroll to reveal" hints.
4. **Stable indexing:** elements keyed by **backendNodeId** (stable across steps), not re-numbered ordinals — the model's references don't shift under it. `*[id]` marks elements new since last step (drives "a suggestion dropdown appeared → click it" behavior).
5. **Form truth:** read values from the AX tree (actual typed value), never the DOM `value` attribute. Date inputs get injected `format=YYYY-MM-DD` hints instead of compound children (known hallucination fix). Password values never serialized.
6. **Vision channel:** plain screenshot by default (NOT set-of-marks by default — SeeAct/OSWorld evidence says dense SoM boxes hurt; the indexed text list already provides grounding). SoM overlay available as a per-step option when the executor asks for it.

### 3.4 `@accura/actions` — registry + grounded execution

Every action = Zod param schema + executor + metadata:

```ts
defineAction({
  name: 'click',
  params: z.object({ index: z.number().describe('backendNodeId from elements list') }),
  terminatesSequence: false,
  irreversible: false,
  async run(ctx, p) { /* resolve index → frame-scoped Playwright locator → click */ },
});
```

- **Grounding rule:** the model may only reference enumerated indices (anti-hallucination — the Playwright-MCP/Stagehand insight: choose from valid targets, never free-generate selectors). Resolution: backendNodeId → frame → Playwright locator (role/text-based first, position fallback) with `scrollIntoViewIfNeeded`, leveraging Playwright's actionability checks.
- **Coordinate fallback:** `clickAt(x,y)` exists but is gated to coordinate-grounded models (Claude) and only offered when index-based interaction failed or the target is canvas/slider/drag — the Magnitude lesson scoped to where it wins.
- Core set: `navigate, click, input, selectOption, scroll, sendKeys, switchTab, goBack, wait, extract (separate extractor model + Zod schema over markdown-ified page), findText, screenshot, readFile/writeFile (todo.md + results.md persistent scratchpad), evaluateJs (escape hatch), done(success, payload)`.
- **Multi-action batching with stale-DOM protection:** up to 3 actions/step; abort remaining queue if URL or focused target changed after any action (browser-use's two-layer guard); the skipped tail is reported so the model re-issues it.
- `done` is special: it does not end the run — it *requests* termination, which `verify` must approve (§3.6).

### 3.5 `@accura/agent` — the loop

Plan-and-Act structure (evidence #3) with browser-use's structured self-evaluation:

```
PLANNER (strong model, every K steps or on deviation):
  task + history summary + current observation → plan: 3–10 checklist items, updated todo.md

EXECUTOR (each step) — structured output, Zod-validated:
  { evaluationPreviousGoal: 'success'|'failure'|'uncertain' + why,
    memory,                 // facts gathered, approaches tried (loop-breaker)
    nextGoal,
    actions: Action[] }     // 1–3 actions

POST-ACTION: re-observe → step verifier (§3.6) → next step
```

Accuracy spends (we have the latency budget):
- **Decision-point best-of-N:** when the executor self-reports `uncertain`, or the step verifier flagged the last action, sample N=3 candidate steps at temperature, semantically dedup, and have the judge-role model pick. Modest N with an arbiter is what the test-time-scaling literature supports (naive large-N hurts).
- **Pre-flight simulation for irreversible actions** (submit/purchase/delete/send, flagged via `irreversible` metadata): a WebDreamer-style "predict the outcome of this action; does it match the plan?" model call before executing. Live sites can't be rewound — simulate, don't explore.
- **Recovery policy (explicit, in code not just prompt):** same action failing 2× → forbid it, force strategy change; same URL 3 steps without plan progress → trigger replan; element-not-found → re-observe once, then alternate grounding (text search → coordinate fallback if capable); crash → session restore. Budget rule: at 75% of maxSteps, replan toward highest-value remaining items.
- **Context discipline:** full observation only for the current step; prior steps compressed to (goal, actions, verdict, memory). Last 2 screenshots max. Anthropic-specific: instruction text placed *before* images in content blocks; prompt caching on the static system prompt + tool defs.
- System prompt encodes the battle-tested behavioral rules mined from browser-use: combobox protocol (type → wait for `*new` suggestions → click, don't press Enter), cookie-banners first, never trust an action succeeded without observed evidence, data-grounding rule (every value in the final answer must appear verbatim in an observation — anti-fabrication), 403/captcha → don't hammer the same URL.

### 3.6 `@accura/verify` — the accuracy backstop

Two layers, both separate model calls from the executor:

1. **Step verifier (cheap, every step):** deterministic state-diff first (URL change, new/removed elements, form values, dialogs) → compact "what changed" summary appended to history (Agent-E's change-observation, measured win). If the executor's stated `nextGoal` and the observed diff disagree (e.g. "clicked Add to cart" but no cart change), inject a contradiction warning into the next step.
2. **Trajectory judge (gates `done`):** WebJudge-method — (a) derive the task's *key points* up front from the task statement; (b) select key screenshots/observations across the trajectory (not just the final one); (c) skeptical judge prompt with auto-fail conditions: captcha-blocked, fabricated values (spot-check final answer values against observation text), done-before-complete, wrong format. Verdict `{ verdict: boolean, failureReason, missingKeyPoints }`. On reject → failure reason injected, agent resumes with remaining step budget. Two rejects → return failure honestly (Web Bench: completion hallucination is failure mode #1; an honest failure beats a confident lie).
- The judge runs on a different model than the executor in dev (cross-family), and on Opus with the Sonnet executor in final runs.

### 3.7 `@accura/memory` — skills (the compounding accuracy term)

- **Trajectory store:** every run persisted as JSONL (observations, actions, verdicts, screenshots) — also feeds evals and the trace viewer.
- **Skill induction (AWM/SkillWeaver):** after each *judge-confirmed* success, the skill-inductor model distills: URL pattern + parameterized step recipe + preconditions ("to search flights on site X: click #search, fill origin, …"). Stored per-domain.
- **Skill replay with self-healing (Stagehand's production pattern):** on a new task, matching skills are (a) injected into the planner prompt as known workflows, and (b) replayable deterministically — each cached step re-grounds by role/text; any step that fails falls back to the live executor from that point. Deterministic replay of a verified path removes entire classes of per-step grounding error.
- Skills carry a success/failure score; consistently failing skills auto-retire (browser-use's −3 rule).

### 3.8 `@accura/evals` — you can't claim accuracy without this

- Task suites as data: start with a 20–30 task custom suite over stable public sites + a WebVoyager/Online-Mind2Web subset later. Each task: instruction, optional ground truth, max steps.
- Runner executes N seeds per task per config, stores trajectories, applies the trajectory judge + optional ground-truth check; outputs success rate with bootstrap error bars.
- **Regression gate in CI (Turborepo task):** PRs to perception/prompts/actions run the eval suite on the dev profile. Accuracy work without regression evals is guesswork — browser-use's single biggest infra lesson.
- Failure mining: failed-run `failureReason`s clustered weekly by a model into actionable buckets.

---

## 4. The step, end to end

```
┌────────────────────────────────────────────────────────────────────┐
│  task ──► PLANNER ──► todo.md / plan items                        │
│                                                                    │
│  loop:                                                             │
│   browser ──stability gate──► PERCEPTION ──► AgentObservation      │
│   skills(memory) ─ injected ─┐                                     │
│   EXECUTOR (structured out) ─┴─► {eval, memory, goal, actions}     │
│        │ uncertain/flagged? ──► best-of-3 + judge arbiter          │
│        │ irreversible? ──────► simulate-then-act                   │
│   ACTIONS (grounded, batched, stale-DOM guard) ──► browser         │
│   STEP VERIFIER (state diff + contradiction check)                 │
│   recovery policy (retry-with-change / replan / restore)           │
│                                                                    │
│  done(…) ──► TRAJECTORY JUDGE ──reject──► resume with reason       │
│                  │ approve                                         │
│  result + trajectory ──► MEMORY (skill induction) + EVALS          │
└────────────────────────────────────────────────────────────────────┘
```

---

## 5. Dev (free) vs final (Claude) profiles

| Role | dev.json (free) | final.json (Anthropic) |
|---|---|---|
| Executor | Qwen2.5-VL 32B/72B via Ollama, or Gemini Flash free tier | Claude Sonnet 4.6 (adaptive thinking, effort high) |
| Planner | Llama 3.3 70B (Groq free) / Gemini Flash | Claude Opus |
| Judge | different family than executor | Claude Opus (skeptical prompt) |
| Extractor | any free JSON-mode model | Claude Sonnet |
| Vision | on if model supports, else DOM-only | on; coordinate fallback enabled; exact-dimension screenshots |

Same code, same prompts, same evals — the profile is the only difference. Free-model runs will score lower; that's fine, they exercise the *machinery* (grounding, verification, recovery, replay), and the eval suite tells you exactly how much headroom the final Claude run gains.

---

## 6. Build order

1. **M0 — skeleton:** monorepo scaffolding, `shared`, `llm` (openai-compatible + anthropic), `browser` (session + stability gate + screenshots).
2. **M1 — perceive/act:** `perception` (indexed elements, serialization) + `actions` (core set, grounded execution) + minimal ReAct loop in `agent`. *First end-to-end task completes here.*
3. **M2 — accuracy layer:** structured executor output, step verifier, trajectory judge gating done, recovery policy, multi-action batching with guards.
4. **M3 — evals:** task suite + runner + judge agreement spot-check. From here on, every change is measured.
5. **M4 — scaffolds:** planner/replanning, best-of-N at flagged decisions, irreversible-action simulation.
6. **M5 — memory:** trajectory store → skill induction → replay with self-healing.
7. **M6 — final-run hardening:** Claude profile tuning (resolution/coordinates, zoom, prompt-before-image, caching), coordinate fallback, benchmark run.

---

## 7. Key risks & mitigations

- **Playwright vs CDP:** browser-use and Stagehand both left Playwright (frame routing, crash handling, screenshot limits). Mitigation: `BrowserDriver` interface + CDP session escape hatch; revisit only if evals show frame/crash failures clustering.
- **Free-model structured output flakiness:** repair-reprompt + schema-constrained decode (Ollama `format`); the Zod boundary means bad output degrades to a retry, never a crash.
- **Judge false approvals:** judge ≠ executor family; data-grounding spot-checks are deterministic code, not model opinion; periodically hand-label 30 trajectories and track judge agreement (browser-use: 87% is achievable).
- **Live-site nondeterminism in evals:** multiple seeds + bootstrap error bars; prefer stable sites; treat single-run deltas as noise.
