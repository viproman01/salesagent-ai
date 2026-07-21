import { readFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import {
  formatReadinessResults,
  readinessExitCode,
  runProductionReadiness,
  type ProductionReadinessOptions,
  type ReadinessCheckResult,
} from './production';

export type ReadinessCliOptions = Readonly<{
  envFile?: string;
  envFileExplicit: boolean;
  publicUrl?: string;
  timeoutMs: number;
  format: 'text' | 'json';
  billing: boolean;
  strict: boolean;
}>;

export type ReadinessCliRuntime = Readonly<{
  cwd: string;
  environment: NodeJS.ProcessEnv;
  readEnvironmentFile(filePath: string): Promise<Buffer>;
  runReadiness(
    options: ProductionReadinessOptions
  ): Promise<readonly ReadinessCheckResult[]>;
  writeOutput(output: string): void;
}>;

export const MIN_READINESS_TIMEOUT_MS = 250;
export const MAX_READINESS_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export async function executeProductionReadinessCli(
  args: readonly string[],
  runtime: ReadinessCliRuntime
): Promise<0 | 1 | 2 | 3> {
  let cli: ReadinessCliOptions;
  try {
    cli = parseProductionReadinessArguments(args);
  } catch {
    emitSyntheticResult(
      runtime,
      'cli.arguments',
      'invalid_arguments',
      inferredFormat(args)
    );
    return 2;
  }

  let environment: NodeJS.ProcessEnv;
  try {
    environment = await loadEnvironment(cli, runtime);
  } catch {
    emitSyntheticResult(
      runtime,
      'cli.config',
      'env_file_unavailable',
      cli.format
    );
    return 2;
  }

  try {
    const results = await runtime.runReadiness({
      environment,
      publicUrl: cli.publicUrl,
      timeoutMs: cli.timeoutMs,
      billing: cli.billing,
    });
    runtime.writeOutput(`${formatReadinessResults(results, cli.format)}\n`);
    return readinessExitCode(results, cli.strict);
  } catch {
    emitSyntheticResult(
      runtime,
      'cli.internal',
      'internal_failure',
      cli.format
    );
    return 3;
  }
}

export function parseProductionReadinessArguments(
  args: readonly string[]
): ReadinessCliOptions {
  let envFile: string | undefined;
  let envFileExplicit = false;
  let publicUrl: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let format: 'text' | 'json' = 'text';
  let billing = false;
  let strict = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--billing') {
      billing = true;
      continue;
    }
    if (argument === '--strict') {
      strict = true;
      continue;
    }

    const [name, inlineValue] = splitArgument(argument);
    if (
      name !== '--env-file' &&
      name !== '--public-url' &&
      name !== '--timeout-ms' &&
      name !== '--format'
    ) {
      throw new Error('unknown argument');
    }
    const value = inlineValue ?? args[++index];
    if (!value || value.startsWith('--')) throw new Error('missing value');

    if (name === '--env-file') {
      envFile = value;
      envFileExplicit = true;
    } else if (name === '--public-url') {
      publicUrl = value;
    } else if (name === '--timeout-ms') {
      if (!/^\d+$/.test(value)) throw new Error('invalid timeout');
      timeoutMs = Number(value);
      if (
        timeoutMs < MIN_READINESS_TIMEOUT_MS ||
        timeoutMs > MAX_READINESS_TIMEOUT_MS
      ) {
        throw new Error('timeout out of range');
      }
    } else if (name === '--format') {
      if (value !== 'text' && value !== 'json') {
        throw new Error('invalid format');
      }
      format = value;
    }
  }

  return {
    envFile,
    envFileExplicit,
    publicUrl,
    timeoutMs,
    format,
    billing,
    strict,
  };
}

function splitArgument(argument: string): readonly [string, string | undefined] {
  const separator = argument.indexOf('=');
  return separator === -1
    ? [argument, undefined]
    : [argument.slice(0, separator), argument.slice(separator + 1)];
}

async function loadEnvironment(
  cli: ReadinessCliOptions,
  runtime: ReadinessCliRuntime
): Promise<NodeJS.ProcessEnv> {
  const envFile = path.resolve(runtime.cwd, cli.envFile ?? '.env');
  let fileEnvironment: Record<string, string> = {};
  try {
    fileEnvironment = dotenv.parse(await runtime.readEnvironmentFile(envFile));
  } catch {
    if (cli.envFileExplicit) throw new Error('environment file unavailable');
  }
  return { ...fileEnvironment, ...runtime.environment };
}

function emitSyntheticResult(
  runtime: Pick<ReadinessCliRuntime, 'writeOutput'>,
  id: string,
  code: string,
  format: 'text' | 'json'
): void {
  const result: ReadinessCheckResult = {
    id,
    status: 'fail',
    code,
    duration_ms: 0,
  };
  runtime.writeOutput(`${formatReadinessResults([result], format)}\n`);
}

function inferredFormat(args: readonly string[]): 'text' | 'json' {
  return args.some(
    (argument, index) =>
      argument === '--format=json' ||
      (argument === '--format' && args[index + 1] === 'json')
  )
    ? 'json'
    : 'text';
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const runtime: ReadinessCliRuntime = {
    cwd: process.cwd(),
    environment: process.env,
    readEnvironmentFile: filePath => readFile(filePath),
    runReadiness: options => runProductionReadiness(options),
    writeOutput: output => process.stdout.write(output),
  };
  const interrupt = (): never => {
    emitSyntheticResult(runtime, 'cli.signal', 'interrupted', inferredFormat(args));
    process.exit(130);
  };
  process.once('SIGINT', interrupt);
  void executeProductionReadinessCli(args, runtime)
    .then(exitCode => {
      process.removeListener('SIGINT', interrupt);
      process.exitCode = exitCode;
    })
    .catch(() => {
      process.removeListener('SIGINT', interrupt);
      emitSyntheticResult(runtime, 'cli.internal', 'internal_failure', 'text');
      process.exitCode = 3;
    });
}
