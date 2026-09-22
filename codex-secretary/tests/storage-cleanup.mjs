import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const helper = await readFile(new URL('../deploy/palm-storage-cleanup.mjs', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/storage-cleanup.ts', import.meta.url), 'utf8');
const routes = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');

assert.match(helper, /path\.dirname\(target\) !== await realpath\(releasesRoot\)/, '执行前必须阻止越界路径');
assert.match(helper, /target === await realpath\(currentLink\)/, '执行前必须再次保护 current');
assert.match(helper, /await inUse\(target\)/, '删除前必须检查运行进程');
assert.match(helper, /rollback = entries\.find/, '必须保留完整回滚版本');
assert.doesNotMatch(server, /request\.body.*path/, '接口不得接收客户端文件路径');
assert.match(routes, /confirmed: z\.literal\(true\)/, '执行接口必须要求明确确认');
assert.match(page, /确认并清理/, '界面必须有人工作出的最终确认');

console.log('storage cleanup safety checks passed');
