import assert from 'node:assert/strict';
import { CliVersionChecker, compareCliVersions, parseCliVersion } from '../dist-server/cli-version.js';

assert.equal(parseCliVersion('codex-cli 0.153.4\n'), '0.153.4');
assert.equal(parseCliVersion('v1.2.3-beta.2'), '1.2.3-beta.2');
assert.equal(parseCliVersion('not-a-version'), undefined);
assert.equal(compareCliVersions('0.153.4', '0.154.0'), -1);
assert.equal(compareCliVersions('0.154.0', '0.154.0'), 0);
assert.equal(compareCliVersions('0.155.0', '0.154.0'), 1);
assert.equal(compareCliVersions('1.0.0-beta.2', '1.0.0'), -1);
assert.equal(compareCliVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);

const calls = [];
const run = async (file, args) => {
  calls.push({ file, args });
  if (file === '/opt/codex') return { stdout: 'codex-cli 0.153.4\n', stderr: '' };
  if (file === '/opt/npm') return { stdout: '"0.154.0"\n', stderr: '' };
  throw new Error('unexpected command');
};
const checker = new CliVersionChecker({
  codexBin: '/opt/codex',
  npmBin: '/opt/npm',
  proxyUrl: 'http://127.0.0.1:7897',
  intervalMs: 60_000,
  run,
  now: () => 1_800_000_000_000,
});
const [first, concurrent] = await Promise.all([checker.get(), checker.get()]);
assert.deepEqual(first, concurrent);
assert.equal(first.state, 'update_available');
assert.equal(first.updateAvailable, true);
assert.equal(first.installedVersion, '0.153.4');
assert.equal(first.latestVersion, '0.154.0');
assert.equal(calls.length, 2, '并发检查应合并为同一次执行');
assert.deepEqual(calls[0], { file: '/opt/codex', args: ['--version'] });
assert.deepEqual(calls[1], { file: '/opt/npm', args: ['view', '@openai/codex', 'version', '--json', '--silent'] });
await checker.get();
assert.equal(calls.length, 2, '缓存有效时不应再次执行命令');
await checker.get(true);
assert.equal(calls.length, 4, '手动刷新应跳过缓存');

const failedChecker = new CliVersionChecker({
  codexBin: '/opt/codex',
  npmBin: '/opt/npm',
  run: async () => { throw new Error('network unavailable'); },
});
const failed = await failedChecker.get();
assert.equal(failed.state, 'unavailable');
assert.equal(failed.updateAvailable, false);
assert.match(failed.error ?? '', /暂时无法检查/);

const disabled = new CliVersionChecker({ codexBin: '/opt/codex', npmBin: '/opt/npm', enabled: false });
assert.equal((await disabled.get()).state, 'disabled');

console.log('v0.15.7 CLI version checker tests passed');
