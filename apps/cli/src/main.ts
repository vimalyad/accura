#!/usr/bin/env node
import { resolve } from 'node:path';
import { loadProfile } from '@accura/shared';
import { ModelRouter } from '@accura/llm';
import { BrowserSession } from '@accura/browser';
import { buildCoreRegistry } from '@accura/actions';
import { Agent } from '@accura/agent';

interface CliArgs {
  task: string;
  profile: string;
  url?: string;
  maxSteps?: number;
  vision?: boolean;
  headed: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { task: '', profile: 'dev', headed: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case '--profile':
        args.profile = argv[++i] ?? 'dev';
        break;
      case '--url':
        args.url = argv[++i];
        break;
      case '--max-steps':
        args.maxSteps = Number(argv[++i]);
        break;
      case '--no-vision':
        args.vision = false;
        break;
      case '--headed':
        args.headed = true;
        break;
      default:
        positional.push(arg);
    }
  }
  args.task = positional.join(' ').trim();
  return args;
}

function usage(): void {
  console.log(
    `Usage: accura "<task>" [options]\n\n` +
      `Options:\n` +
      `  --profile <name|path>  Model profile (configs/<name>.json). Default: dev\n` +
      `  --url <url>            Start URL\n` +
      `  --max-steps <n>        Override profile step budget\n` +
      `  --no-vision            Disable screenshots even for vision models\n` +
      `  --headed               Run the browser with a visible window`,
  );
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    usage();
    return 2;
  }

  const profilePath = args.profile.includes('.json')
    ? resolve(args.profile)
    : resolve('configs', `${args.profile}.json`);
  const profileResult = await loadProfile(profilePath);
  if (!profileResult.ok) {
    console.error(profileResult.error.message);
    return 2;
  }
  const profile = profileResult.value;
  if (args.headed) profile.browser.headless = false;

  const router = new ModelRouter(profile);
  const session = await BrowserSession.launch(profile.browser);
  try {
    const agent = new Agent({
      session,
      registry: buildCoreRegistry(),
      executorModel: router.modelFor('executor'),
      extractorModel: router.modelFor('extractor'),
      maxSteps: args.maxSteps ?? profile.maxSteps,
      ...(args.vision !== undefined ? { useVision: args.vision } : {}),
      ...(args.url ? { startUrl: args.url } : {}),
    });

    console.log(`Task: ${args.task}\nProfile: ${profile.name} (${profilePath})\n`);
    const result = await agent.run(args.task);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Success: ${result.success}`);
    console.log(`Steps:   ${result.stepsTaken}`);
    console.log(`Result:  ${result.result}`);
    return result.success ? 0 : 1;
  } finally {
    await session.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
