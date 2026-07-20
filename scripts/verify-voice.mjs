import { spawnSync } from 'node:child_process';

const checks = [
  ['npm', ['run', 'lint']],
  ['npm', ['run', 'typecheck']],
  ['npm', ['test']],
  ['npm', ['run', 'build']],
  ['node', ['--check', 'voximplant/scenario.js']],
  ['node', ['--check', 'scripts/voximplant-setup.mjs']],
  ['git', ['diff', '--check']],
];

for (const [command, args] of checks) {
  process.stdout.write(`\n[voice:verify] ${command} ${args.join(' ')}\n`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(
      `[voice:verify] Unable to run ${command}: ${result.error.message}`
    );
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('\n[voice:verify] All checks passed.');
