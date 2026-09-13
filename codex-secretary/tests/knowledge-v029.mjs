import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { KnowledgeStore } from '../dist-server/knowledge-store.js';
import { registerKnowledgeRoutes } from '../dist-server/knowledge-routes.js';
import { createSession, verifySession } from '../dist-server/auth.js';

const workspace = await mkdtemp(path.join(os.tmpdir(), 'palm-knowledge-'));
const root = path.join(workspace, 'vault');
const app = Fastify();
try {
  for (const directory of ['主题', '另一处', '.obsidian', '图片']) await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, '首页.md'), '---\ntitle: 我的知识库\ntags: [阅读, 工作]\n---\n# 我的知识库\n中文全文搜索可以找到这句话。\n[[主题/笔记#下一步|继续阅读]]\n![[图片/测试.png]]');
  await writeFile(path.join(root, '主题', '笔记.md'), '# 深入阅读\n## 下一步\n记录自己的思考');
  await writeFile(path.join(root, '另一处', '笔记.md'), '# 同名笔记\n中文全文搜索');
  await writeFile(path.join(root, 'AGENTS.md'), 'private instructions');
  await writeFile(path.join(root, '.obsidian', 'hidden.md'), 'private config');
  await writeFile(path.join(root, 'draft.sync-conflict-2026.md'), 'conflict');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=', 'base64');
  await writeFile(path.join(root, '图片', '测试.png'), png);
  await writeFile(path.join(root, '图片', 'unsafe.svg'), '<svg onload="alert(1)"/>');
  const outside = path.join(workspace, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'secret.md'), 'private outside content');
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const store = new KnowledgeStore(root, 0);
  const index = await store.list();
  assert.equal(index.total, 3);
  assert.ok(!JSON.stringify(index).includes('private'));
  assert.deepEqual((await store.read('首页.md')).tags, ['阅读', '工作']);
  assert.ok(!(await store.read('首页.md')).body.startsWith('---'));
  assert.equal((await store.list('这句话')).notes[0].path, '首页.md');
  assert.equal((await store.list('中文全文 搜索')).notes.length, 2);
  assert.equal((await store.list('不存在')).notes.length, 0);
  assert.deepEqual(await store.resolve('主题/笔记#下一步', '首页.md'), { path: '主题/笔记.md', anchor: '下一步' });
  assert.equal((await store.resolve('../首页', '主题/笔记.md')).path, '首页.md');
  assert.equal((await store.resolve('笔记', '主题/笔记.md')).path, '主题/笔记.md');
  await assert.rejects(store.resolve('笔记', '首页.md'), { statusCode: 409 });
  await assert.rejects(store.resolve('丢失'), { statusCode: 404 });
  assert.deepEqual((await store.image('测试.png', '首页.md')).buffer, png);
  for (const file of ['../outside/secret.md', 'escape/secret.md', '.obsidian/hidden.md', 'AGENTS.md', 'C:/secret.md', 'draft.sync-conflict-2026.md']) await assert.rejects(store.read(file));
  await assert.rejects(store.image('unsafe.svg', '首页.md'));
  await writeFile(path.join(root, '新增.md'), '# 新增内容\n同步新增测试');
  assert.equal((await store.list('同步新增')).notes.length, 1);
  await writeFile(path.join(root, '新增.md'), '# 修改内容\n同步修改测试');
  assert.equal((await store.list('同步修改')).notes.length, 1);
  assert.equal((await store.list('同步新增')).notes.length, 0);
  await rename(path.join(root, '新增.md'), path.join(root, '改名.md'));
  assert.equal((await store.list('同步修改')).notes[0].path, '改名.md');
  await rm(path.join(root, '改名.md'));
  assert.equal((await store.list('同步修改')).notes.length, 0);
  await writeFile(path.join(root, '超大.md'), 'x'.repeat(1024 * 1024 + 1));
  assert.equal((await store.list()).warnings.length, 1);
  await assert.rejects(store.read('超大.md'), { statusCode: 413 });
  const secret = 'knowledge-test-session-secret';
  await app.register(cookie);
  registerKnowledgeRoutes(app, root, (request, reply) => {
    if (!verifySession(request.cookies.palm_session, secret)) { reply.code(401).send({ error: '请先登录' }); return false; }
    if (request.headers.origin && request.headers.origin !== 'http://localhost') { reply.code(403).send({ error: '来源校验失败' }); return false; }
    return true;
  });
  const headers = { cookie: `palm_session=${createSession(secret, 1)}` };
  for (const url of ['/api/knowledge', '/api/knowledge/note?path=首页.md', '/api/knowledge/resolve?target=首页', '/api/knowledge/image?target=测试.png']) {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { ...headers, origin: 'http://evil.example' } })).statusCode, 403);
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  for (const file of ['../outside/secret.md', '.obsidian/hidden.md', 'escape/secret.md', 'AGENTS.md']) {
    assert.ok((await app.inject({ url: `/api/knowledge/note?path=${encodeURIComponent(file)}`, headers })).statusCode >= 400);
  }
  assert.equal((await app.inject({ method: 'POST', url: '/api/knowledge', headers })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/knowledge/note', headers })).statusCode, 400);
  assert.equal(await readFile(path.join(outside, 'secret.md'), 'utf8'), 'private outside content');
  console.log('Knowledge: auth, Chinese search, links, images, sync changes, limits and path isolation passed.');
} finally {
  await app.close();
  // mkdtemp generated this exact dedicated test directory; never touch the real vault.
  await rm(workspace, { recursive: true, force: true });
}
