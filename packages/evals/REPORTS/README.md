# Eval reports

Baseline runs are produced with:

```
pnpm --filter @accura/cli build
node apps/cli/dist/main.js eval packages/evals/suites/fixtures.json --profile dev --seeds 3
```

Requirements for the `dev` profile: Ollama running `qwen2.5vl:32b` locally
(executor), `GROQ_API_KEY` (planner) and `GEMINI_API_KEY` (judge). Reports
land in `eval-reports/` as markdown + JSON with bootstrap 95% CIs.

Status:
- **baseline-dev**: PENDING — no local model/API keys were available on the
  dev machine at Phase 4 completion. The harness itself is verified in CI by
  `packages/evals/tests/runner.test.ts`, which runs the full fixture suite
  pipeline with deterministic oracle models (including a ground-truth
  override of a confidently wrong answer).
- The CI smoke gate is the evals test suite: it executes the runner against
  the local fixture server on every PR via `turbo test`.
