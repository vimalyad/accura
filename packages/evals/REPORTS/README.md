# Eval reports

Runs are produced with:

```
pnpm --filter @accura/cli build
node apps/cli/dist/main.js eval packages/evals/suites/fixtures.json --profile final --seeds 3
```

The profile decides which external API is called: `final.json` needs
`ANTHROPIC_API_KEY`, `openrouter.json` needs `OPENROUTER_API_KEY`. Reports land
in `eval-reports/` as markdown + JSON with bootstrap 95% CIs.

The harness itself is verified in CI by `packages/evals/tests/runner.test.ts`,
which runs the full fixture-suite pipeline against the local fixture server with
deterministic oracle models (including a ground-truth override of a confidently
wrong answer) on every PR via `turbo test`.
