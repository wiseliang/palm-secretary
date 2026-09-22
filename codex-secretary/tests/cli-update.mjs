import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const script = await readFile(new URL('../deploy/update-codex-cli.sh', import.meta.url), 'utf8');
assert.match(script, /VERSION=.*\nif \[\[ ! \$\{VERSION\} =~ \^\[0-9\]/, '更新脚本必须限制精确 semver');
assert.match(script, /mktemp .*codex-proxy/, '代理切换必须使用同目录临时文件');
assert.match(script, /mv -f -- "\$\{PROXY_TMP\}" "\$\{PROXY_PATH\}"/, '代理切换必须原子替换');
assert.match(script, /INSTALLED_VERSION/, '切换前必须验证新二进制版本');
assert.doesNotMatch(script, /sudo/, '更新脚本不得提权');
assert.doesNotMatch(script, /curl[^\n]*\|[^\n]*(sh|bash)/, '更新脚本不得执行远程管道脚本');
console.log('Codex CLI one-click update safety tests passed');
