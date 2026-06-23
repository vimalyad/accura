import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadProfile } from '@accura/shared';
import { ModelRouter } from '@accura/llm';
import {
  EvalSuiteSchema,
  renderMarkdown,
  runSuite,
  startFixtureServer,
  type FixtureServer,
} from '@accura/evals';

export interface EvalArgs {
  suitePath: string;
  profile: string;
  seeds: number;
  excludeTags: string[];
  outDir: string;
}

export function parseEvalArgs(argv: string[]): EvalArgs | undefined {
  const args: EvalArgs = {
    suitePath: '',
    profile: 'final',
    seeds: 1,
    excludeTags: [],
    outDir: 'eval-reports',
  };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--profile':
        args.profile = argv[++i] ?? 'final';
        break;
      case '--seeds':
        args.seeds = Number(argv[++i] ?? 1);
        break;
      case '--exclude-tags':
        args.excludeTags = (argv[++i] ?? '').split(',').filter(Boolean);
        break;
      case '--out':
        args.outDir = argv[++i] ?? 'eval-reports';
        break;
      default:
        positional.push(arg);
    }
  }
  args.suitePath = positional[0] ?? '';
  return args.suitePath ? args : undefined;
}

export async function evalCommand(argv: string[]): Promise<number> {
  const args = parseEvalArgs(argv);
  if (!args) {
    console.log(
      'Usage: accura eval <suite.json> [--profile final] [--seeds N] [--exclude-tags live] [--out dir]',
    );
    return 2;
  }

  const suiteRaw = await readFile(resolve(args.suitePath), 'utf8');
  const suite = EvalSuiteSchema.parse(JSON.parse(suiteRaw));

  const profilePath = args.profile.includes('.json')
    ? resolve(args.profile)
    : resolve('configs', `${args.profile}.json`);
  const profileResult = await loadProfile(profilePath);
  if (!profileResult.ok) {
    console.error(profileResult.error.message);
    return 2;
  }
  const profile = profileResult.value;
  const router = new ModelRouter(profile);

  let fixtures: FixtureServer | undefined;
  if (suite.tasks.some((task) => task.startUrl?.startsWith('fixture:'))) {
    fixtures = await startFixtureServer();
  }

  try {
    console.log(`Suite: ${suite.name} (${suite.tasks.length} tasks, ${args.seeds} seed(s))`);
    const report = await runSuite({
      suite,
      modelsFor: () => ({
        executor: router.modelFor('executor'),
        judge: router.modelFor('judge'),
        extractor: router.modelFor('extractor'),
      }),
      browserConfig: profile.browser,
      seeds: args.seeds,
      excludeTags: args.excludeTags,
      ...(fixtures ? { fixtureServer: fixtures } : {}),
      traceDir: join(args.outDir, 'traces'),
    });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = resolve(args.outDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${suite.name}-${stamp}.json`), JSON.stringify(report, null, 2));
    await writeFile(join(dir, `${suite.name}-${stamp}.md`), renderMarkdown(report));

    console.log(
      `\nSuccess rate: ${(report.successRate * 100).toFixed(1)}% ` +
        `(${report.successes}/${report.totalRuns}, ` +
        `95% CI ${(report.ci95.low * 100).toFixed(1)}-${(report.ci95.high * 100).toFixed(1)}%)`,
    );
    console.log(`Report written to ${dir}`);
    return 0;
  } finally {
    await fixtures?.close();
  }
}
