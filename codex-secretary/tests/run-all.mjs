import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
for (const [name, command] of Object.entries(scripts)) {
  if (name !== 'test:integration' && !/^test:v\d+$/.test(name)) continue;
  // Regression scripts deliberately use a simple Node command, with no shell expansion.
  const [binary, ...args] = command.split(' ');
  if (binary !== 'node') throw new Error(`Unsupported test command: ${name}`);
  console.log(`\nRunning ${name}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
