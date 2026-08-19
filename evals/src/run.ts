import { readFileSync } from 'node:fs';

import {
  renderEnhancePrompt,
  TEMPLATE_SHA256,
  TEMPLATE_VERSION,
} from '@prompt-enhancer/prompts';

// The runner drives the same adapters the extension ships (§5: the eval runner
// is the third consumer of the prompt). Reaching across into the extension is
// deliberate- an eval that talks to the provider SDKs directly would be
// grading code that does not ship.
import { createClient, detectProvider } from '../../extension/src/providers/registry.js';
import {
  PROVIDER_LABELS,
  type ModelClient,
  type ProviderId,
} from '../../extension/src/providers/types.js';
import { loadGoldens, type Golden } from './goldens.js';
import { scoreGolden, type GoldenScore } from './score.js';

/**
 * The §10 golden runner.
 *
 * ```bash
 * pnpm --filter @prompt-enhancer/evals run eval -- --provider anthropic
 * pnpm --filter @prompt-enhancer/evals run eval -- --provider google --model gemini-...
 * pnpm --filter @prompt-enhancer/evals run eval -- --replay recorded.json   # no key, no tokens
 * ```
 *
 * It reports pass rate against `TEMPLATE_SHA256` **and** the provider and model
 * that produced it, so a result is traceable to exact template bytes and an exact
 * model- which is what makes a golden result mean anything (§10, D10).
 *
 * Not in CI: it needs a real key and spends real tokens (§13).
 */

const KEY_ENV: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_API_KEY',
};

interface Options {
  provider: ProviderId | undefined;
  model: string | undefined;
  filter: string | undefined;
  replay: string | undefined;
  record: string | undefined;
  concurrency: number;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    provider: undefined,
    model: undefined,
    filter: undefined,
    replay: undefined,
    record: undefined,
    concurrency: 3,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--':
        // pnpm forwards the `--` separator through to the script, so tolerating
        // it is the difference between the documented invocation working and not.
        break;
      case '--provider':
        if (value !== 'anthropic' && value !== 'openai' && value !== 'google') {
          throw new Error(`--provider must be anthropic, openai or google (got ${String(value)})`);
        }
        options.provider = value;
        i += 1;
        break;
      case '--model':
        options.model = value;
        i += 1;
        break;
      case '--filter':
        options.filter = value;
        i += 1;
        break;
      case '--replay':
        options.replay = value;
        i += 1;
        break;
      case '--record':
        options.record = value;
        i += 1;
        break;
      case '--concurrency':
        options.concurrency = Number(value);
        i += 1;
        break;
      case '--help':
        printUsage();
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`unknown flag ${String(flag)}`);
    }
  }

  return options;
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: eval [--provider <id>] [--model <id>] [--filter <substring>]',
      '            [--replay <file>] [--record <file>] [--concurrency <n>]',
      '',
      '  --provider   anthropic | openai | google. Reads the matching *_API_KEY.',
      '  --model      Model id. Omitted means the first from listModels().',
      '  --filter     Only run goldens whose id contains this substring.',
      '  --replay     Score a previously recorded run. No key, no tokens.',
      '  --record     Write this run\'s outputs to a file for later replay.',
      '',
    ].join('\n'),
  );
}

/** A recorded run, so a scoring change can be re-checked without re-spending. */
interface Recording {
  templateVersion: string;
  templateSha256: string;
  provider: string;
  model: string;
  outputs: Record<string, string>;
}

async function resolveModel(client: ModelClient, requested: string | undefined): Promise<string> {
  if (requested !== undefined && requested.length > 0) {
    return requested;
  }
  const models = await client.listModels();
  const first = models[0];
  if (first === undefined) {
    throw new Error(`no models available on the ${client.provider} key`);
  }
  // No model ID is hardcoded anywhere in this project (D9), including here.
  process.stdout.write(
    `  no --model given; using the first of ${models.length} from listModels(): ${first.id}\n`,
  );
  return first.id;
}

async function runLive(
  goldens: readonly Golden[],
  options: Options,
): Promise<{ provider: string; model: string; outputs: Map<string, string> }> {
  const provider = options.provider;
  if (provider === undefined) {
    throw new Error('--provider is required unless --replay is given');
  }

  const apiKey = process.env[KEY_ENV[provider]]?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(`${KEY_ENV[provider]} is not set`);
  }
  // Cross-check the env var name against the prefix where the prefix is one we
  // know. `detectProvider` is a hint, not a gate (§6)- an unfamiliar format means
  // trust the variable it was put in.
  const detected = detectProvider(apiKey);
  if (detected !== undefined && detected !== provider) {
    throw new Error(`${KEY_ENV[provider]} looks like a ${detected} key, not a ${provider} one`);
  }

  const client = createClient(provider, apiKey);
  const model = await resolveModel(client, options.model);

  const outputs = new Map<string, string>();
  const queue = [...goldens];
  const workers = Array.from({ length: Math.max(1, options.concurrency) }, async () => {
    for (let golden = queue.shift(); golden !== undefined; golden = queue.shift()) {
      const rendered = renderEnhancePrompt({ roughText: golden.rough, mode: golden.mode });
      try {
        outputs.set(golden.id, await client.enhance(rendered, model));
        process.stdout.write(`  ran ${golden.id}\n`);
      } catch (error) {
        // A failed call is a failed golden, not a crashed run- one provider
        // refusing one input should not cost the other sixteen results.
        outputs.set(
          golden.id,
          `__ERROR__ ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        );
        process.stdout.write(`  FAILED ${golden.id}\n`);
      }
    }
  });
  await Promise.all(workers);

  return { provider, model, outputs };
}

function loadReplay(path: string): {
  provider: string;
  model: string;
  outputs: Map<string, string>;
} {
  const recording = JSON.parse(readFileSync(path, 'utf8')) as Recording;

  if (recording.templateSha256 !== TEMPLATE_SHA256) {
    process.stdout.write(
      `\n  WARNING: this recording was made against template ${recording.templateSha256.slice(0, 12)}…\n` +
        `  and the template is now ${TEMPLATE_SHA256.slice(0, 12)}…. Scores are not comparable.\n\n`,
    );
  }

  return {
    provider: recording.provider,
    model: recording.model,
    outputs: new Map(Object.entries(recording.outputs)),
  };
}

function report(
  scores: readonly GoldenScore[],
  provider: string,
  model: string,
  replayed: boolean,
): boolean {
  const passed = scores.filter((score) => score.passed);
  const rate = scores.length === 0 ? 0 : (passed.length / scores.length) * 100;

  const lines: string[] = ['', '─'.repeat(72)];
  lines.push(`Template   ${TEMPLATE_VERSION} (${TEMPLATE_SHA256.slice(0, 12)}…)`);
  lines.push(`Provider   ${PROVIDER_LABELS[provider as ProviderId] ?? provider}`);
  lines.push(`Model      ${model}`);
  lines.push(`Source     ${replayed ? 'replayed recording (no tokens spent)' : 'live API'}`);
  lines.push(`Pass rate  ${passed.length}/${scores.length} (${rate.toFixed(0)}%)`);
  lines.push('─'.repeat(72));

  for (const score of scores) {
    const failures = score.results.filter((result) => !result.passed);
    const mark = score.passed ? 'PASS' : 'FAIL';
    lines.push(
      `${mark}  ${score.id.padEnd(24)} ${score.mode.padEnd(13)} ${score.inputChars} → ${score.outputChars} chars`,
    );
    for (const failure of failures) {
      lines.push(`        ${failure.name}: ${failure.detail}`);
    }
  }

  lines.push('─'.repeat(72));

  // The regression rule is called out separately because it is the one §10 says
  // matters most: an enhancer that inflates good prompts is worse than none.
  const regressions = scores.filter((score) =>
    score.results.some((result) => result.name.startsWith('regression:') && !result.passed),
  );
  if (regressions.length > 0) {
    lines.push(
      `REGRESSION RULE FAILED on ${regressions.map((score) => score.id).join(', ')}-` +
        ' an already-good prompt came back materially changed.',
    );
    lines.push('─'.repeat(72));
  }
  lines.push('');

  process.stdout.write(lines.join('\n'));
  return passed.length === scores.length;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const all = loadGoldens();
  const goldens =
    options.filter === undefined
      ? all
      : all.filter((golden) => golden.id.includes(options.filter as string));

  if (goldens.length === 0) {
    throw new Error(`no goldens matched --filter ${String(options.filter)}`);
  }

  process.stdout.write(`Running ${goldens.length} golden(s) against ${TEMPLATE_VERSION}\n`);

  const run =
    options.replay === undefined
      ? await runLive(goldens, options)
      : loadReplay(options.replay);

  if (options.record !== undefined) {
    const recording: Recording = {
      templateVersion: TEMPLATE_VERSION,
      templateSha256: TEMPLATE_SHA256,
      provider: run.provider,
      model: run.model,
      outputs: Object.fromEntries(run.outputs),
    };
    const { writeFileSync } = await import('node:fs');
    writeFileSync(options.record, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
    process.stdout.write(`  recorded to ${options.record}\n`);
  }

  const scores = goldens.map((golden) =>
    scoreGolden(golden, run.outputs.get(golden.id) ?? '__MISSING__'),
  );

  const allPassed = report(scores, run.provider, run.model, options.replay !== undefined);
  process.exitCode = allPassed ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`\n${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exitCode = 1;
});
