import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const root = process.cwd();
const workspace = path.join(root, '.test-workspace-v02');
const logFile = path.join(workspace, 'mock.jsonl');
await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
await mkdir(workspace, { recursive: true });
await writeFile(logFile, '');
await mkdir(path.join(workspace, '.palm'), { recursive: true });
const seededAt = new Date().toISOString();
await writeFile(path.join(workspace, '.palm', 'state.json'), `${JSON.stringify({ version: 2, projects: [{ id: 'default', name: '默认项目', directory: 'default', createdAt: seededAt, updatedAt: seededAt }], threads: [] }, null, 2)}\n`);
const seededInbox = path.join(workspace, 'projects', 'default', 'inbox');
await mkdir(seededInbox, { recursive: true });
const stalePart = path.join(seededInbox, '.upload-323e4567-e89b-42d3-a456-426614174000.part');
const freshPart = path.join(seededInbox, '.upload-423e4567-e89b-42d3-a456-426614174000.part');
await writeFile(stalePart, 'stale'); await writeFile(freshPart, 'fresh');
const old = new Date(Date.now() - 25 * 60 * 60 * 1000); await utimes(stalePart, old, old);

const port = 4591;
const commonHeaders = { Origin: `http://127.0.0.1:${port}`, 'Tailscale-User-Login': 'test@example.com' };
const child = spawn(process.execPath, ['dist-server/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    APP_HOST: '127.0.0.1', APP_PORT: String(port), APP_ORIGIN: `http://127.0.0.1:${port}`,
    SESSION_SECRET: 'test-secret-that-is-long-enough-for-v02', TAILSCALE_OWNER_LOGIN: 'test@example.com',
    WORKSPACE_ROOT: workspace, CODEX_BIN: process.execPath,
    CODEX_ARGS_PREFIX_JSON: JSON.stringify([path.join(root, 'tests', 'mock-app-server.mjs')]), MOCK_LOG: logFile,
    TASK_STOP_FREE_BYTES: '1', DISK_WARNING_FREE_BYTES: '1', MAX_UPLOAD_BYTES: '32', LOG_LEVEL: 'error',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

async function api(url, init = {}) {
  return fetch(`http://127.0.0.1:${port}${url}`, { ...init, headers: { ...commonHeaders, ...(init.headers ?? {}) } });
}

try {
  for (let index = 0; index < 60; index += 1) {
    if ((await fetch(`http://127.0.0.1:${port}/api/health`).catch(() => null))?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (await stat(stalePart).catch(() => null)) throw new Error('过期上传分片未在启动时清理');
  if (!(await stat(freshPart).catch(() => null))) throw new Error('未过期上传分片被错误清理');
  const createdResponse = await api('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '附件测试项目' }) });
  if (createdResponse.status !== 201) throw new Error(`创建项目失败: ${createdResponse.status}`);
  const project = (await createdResponse.json()).project;
  const models = (await (await api('/api/models')).json()).models;
  if (models.length !== 2 || !models.some((model) => model.model === 'mock-deep')) throw new Error('模型列表错误');
  const status = await (await api('/api/status')).json();
  if (typeof status.sudo?.available !== 'boolean') throw new Error('sudo 运行态自检状态缺失');
  const modelResponse = await api(`/api/projects/${encodeURIComponent(project.id)}/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-deep', reasoningEffort: 'high' }) });
  if (!modelResponse.ok) throw new Error('模型切换失败');

  const uploadId = '123e4567-e89b-42d3-a456-426614174000';
  const textForm = new FormData(); textForm.append('file', new Blob(['hello attachment']), 'read-me.txt');
  const textFile = (await (await api(`/api/files/upload?projectId=${encodeURIComponent(project.id)}`, { method: 'POST', headers: { 'X-Upload-Id': uploadId }, body: textForm })).json()).file;
  const retryForm = new FormData(); retryForm.append('file', new Blob(['hello attachment']), 'read-me.txt');
  const retriedFile = (await (await api(`/api/files/upload?projectId=${encodeURIComponent(project.id)}`, { method: 'POST', headers: { 'X-Upload-Id': uploadId }, body: retryForm })).json()).file;
  if (retriedFile.path !== textFile.path) throw new Error('上传重试产生了重复文件');
  const imageForm = new FormData(); imageForm.append('file', new Blob([new Uint8Array([137, 80, 78, 71])]), 'photo.png');
  const imageFile = (await (await api(`/api/files/upload?projectId=${encodeURIComponent(project.id)}`, { method: 'POST', body: imageForm })).json()).file;
  const largeForm = new FormData(); largeForm.append('file', new Blob([new Uint8Array(64)]), 'too-large.bin');
  const largeResponse = await api(`/api/files/upload?projectId=${encodeURIComponent(project.id)}`, { method: 'POST', body: largeForm });
  if (largeResponse.status !== 413 || (await largeResponse.json()).error !== '文件超过上传上限') throw new Error('超限文件未返回明确的 413 错误');
  const chunkId = '223e4567-e89b-42d3-a456-426614174000';
  const chunkHeaders = { 'X-Upload-Id': chunkId, 'X-File-Name': encodeURIComponent('断点文件.txt'), 'X-File-Size': '24' };
  const firstChunk = await api(`/api/files/upload-chunk?projectId=${encodeURIComponent(project.id)}`, { method: 'PUT', headers: { ...chunkHeaders, 'X-Upload-Offset': '0', 'Content-Type': 'application/octet-stream' }, body: Buffer.from('abcdefghijkl') });
  if (!firstChunk.ok || (await firstChunk.json()).uploaded !== 12) throw new Error('首个上传分片失败');
  const resumed = await api(`/api/files/upload-session?projectId=${encodeURIComponent(project.id)}`, { headers: chunkHeaders });
  if (!resumed.ok || (await resumed.json()).uploaded !== 12) throw new Error('断点位置没有恢复');
  const secondChunk = await api(`/api/files/upload-chunk?projectId=${encodeURIComponent(project.id)}`, { method: 'PUT', headers: { ...chunkHeaders, 'X-Upload-Offset': '12', 'Content-Type': 'application/octet-stream' }, body: Buffer.from('mnopqrstuvwx') });
  if (!secondChunk.ok) throw new Error('续传分片失败');
  const chunkComplete = await api(`/api/files/upload-complete?projectId=${encodeURIComponent(project.id)}`, { method: 'POST', headers: chunkHeaders });
  if (!chunkComplete.ok || (await chunkComplete.json()).file?.name !== '断点文件.txt') throw new Error('分片上传完成失败');
  const abortId = '523e4567-e89b-42d3-a456-426614174000';
  const abortHeaders = { 'X-Upload-Id': abortId, 'X-File-Name': encodeURIComponent('取消上传.txt'), 'X-File-Size': '24' };
  await api(`/api/files/upload-chunk?projectId=${encodeURIComponent(project.id)}`, { method: 'PUT', headers: { ...abortHeaders, 'X-Upload-Offset': '0', 'Content-Type': 'application/octet-stream' }, body: Buffer.from('abcdefghijkl') });
  const aborted = await api(`/api/files/upload-session?projectId=${encodeURIComponent(project.id)}`, { method: 'DELETE', headers: abortHeaders });
  if (!aborted.ok) throw new Error('上传会话取消失败');
  const abortedSession = await api(`/api/files/upload-session?projectId=${encodeURIComponent(project.id)}`, { headers: abortHeaders });
  if (!abortedSession.ok || (await abortedSession.json()).uploaded !== 0) throw new Error('取消后分片仍然存在');

  const events = [];
  const firstRequestId = crypto.randomUUID();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: commonHeaders });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket 测试超时')), 5000);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()); events.push(message);
      if (message.type === 'ready') socket.send(JSON.stringify({ type: 'turn.start', clientRequestId: firstRequestId, projectId: project.id, text: '读取两个附件并回复', attachments: [textFile.path, imageFile.path] }));
      if (message.type === 'codex.event' && message.payload?.method === 'turn/completed') { clearTimeout(timeout); resolve(); }
    });
    socket.on('error', reject);
  });
  socket.close();
  const accepted = events.find((event) => event.type === 'turn.accepted');
  if (!accepted?.threadId) throw new Error('未收到 threadId');

  const duplicateSocket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: commonHeaders });
  const duplicateAccepted = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('幂等重放测试超时')), 5000);
    duplicateSocket.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ready') duplicateSocket.send(JSON.stringify({ type: 'turn.start', clientRequestId: firstRequestId, projectId: project.id, text: '重复请求不应再次执行' }));
      if (message.type === 'turn.accepted') { clearTimeout(timeout); resolve(message); }
    });
    duplicateSocket.on('error', reject);
  });
  duplicateSocket.close();
  if (!duplicateAccepted.replayed || duplicateAccepted.payload?.turn?.id !== accepted.payload?.turn?.id) throw new Error('重复请求未返回原任务');

  const invalidModel = await api(`/api/projects/${encodeURIComponent(project.id)}/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'not-available', reasoningEffort: 'high' }) });
  if (invalidModel.status !== 400) throw new Error('不可用模型未被拒绝');
  const switched = await api(`/api/projects/${encodeURIComponent(project.id)}/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-fast', reasoningEffort: 'low' }) });
  if (!switched.ok) throw new Error('已有对话模型切换失败');
  const socket2 = new WebSocket(`ws://127.0.0.1:${port}/api/ws`, { headers: commonHeaders });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('已有对话模型切换超时')), 5000);
    socket2.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ready') socket2.send(JSON.stringify({ type: 'turn.start', clientRequestId: crypto.randomUUID(), projectId: project.id, threadId: accepted.threadId, text: '继续对话' }));
      if (message.type === 'codex.event' && message.payload?.method === 'turn/completed') { clearTimeout(timeout); resolve(); }
    });
    socket2.on('error', reject);
  });
  socket2.close();

  let tasks = [];
  for (let index = 0; index < 20; index += 1) {
    tasks = (await (await api(`/api/tasks?projectId=${encodeURIComponent(project.id)}`)).json()).tasks;
    if (tasks.length === 2 && tasks.every((task) => task.status === 'completed')) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (tasks.length !== 2 || !tasks.every((task) => task.status === 'completed')) throw new Error('任务中心未持久记录完成状态');
  if (!tasks.every((task) => task.outputPaths.length >= 1 && task.attachments instanceof Array)) {
    throw new Error(`任务成果或附件关联未持久化: ${JSON.stringify(tasks.map((task) => ({ status: task.status, outputPaths: task.outputPaths, attachments: task.attachments, clientRequestId: task.clientRequestId })))}`);
  }
  const restoredThread = await (await api(`/api/threads/${encodeURIComponent(accepted.threadId)}?projectId=${encodeURIComponent(project.id)}`)).json();
  const restoredTurns = restoredThread.thread?.turns ?? [];
  if (restoredTurns.length !== 2 || !restoredTurns.every((turn) => turn.items?.some((item) => item.type === 'agentMessage' && item.text?.includes('MOCK_OK')))) throw new Error('任务结束后无法重新同步完整对话');
  const exportedThread = await api(`/api/threads/${encodeURIComponent(accepted.threadId)}/export?projectId=${encodeURIComponent(project.id)}`);
  if (!exportedThread.ok || !exportedThread.headers.get('content-disposition')?.includes('.md') || !(await exportedThread.text()).includes('## 掌心助理')) throw new Error('Markdown 对话导出失败');
  const defaultTasks = (await (await api('/api/tasks?projectId=default')).json()).tasks;
  if (defaultTasks.length !== 0) throw new Error('任务记录跨项目泄露');
  const migratedState = JSON.parse(await readFile(path.join(workspace, '.palm', 'state.json'), 'utf8'));
  if (migratedState.version !== 8 || !Array.isArray(migratedState.tasks)) throw new Error('旧状态未迁移为 v8');

  const requests = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const threadStart = requests.find((request) => request.method === 'thread/start');
  const turnStarts = requests.filter((request) => request.method === 'turn/start');
  if (turnStarts.length !== 2) throw new Error('重复 clientRequestId 触发了额外任务');
  const turnStart = turnStarts[0];
  if (threadStart.params.approvalPolicy !== 'never' || threadStart.params.sandbox !== 'danger-full-access') throw new Error('thread/start 权限配置错误');
  if (!threadStart.params.developerInstructions?.includes('用户不需要知道目录约定') || !threadStart.params.developerInstructions?.includes('outbox/')) throw new Error('自动成果规则未注入');
  if (threadStart.params.model !== 'mock-deep' || threadStart.params.config?.model_reasoning_effort !== 'high') throw new Error('thread/start 模型配置错误');
  if (turnStart.params.approvalPolicy !== 'never' || turnStart.params.sandboxPolicy?.type !== 'dangerFullAccess') throw new Error('turn/start 权限配置错误');
  if (turnStart.params.model !== 'mock-deep' || turnStart.params.effort !== 'high') throw new Error('turn/start 模型配置错误');
  if (turnStarts.at(-1).params.model !== 'mock-fast' || turnStarts.at(-1).params.effort !== 'low') throw new Error('已有对话未切换模型');
  if (!turnStart.params.cwd.endsWith(path.join('projects', project.id))) throw new Error('项目 cwd 未隔离');
  if (!turnStart.params.input[0].text.includes(path.basename(textFile.path)) || !turnStart.params.input[0].text.includes('务必先用文件工具读取')) throw new Error('附件路径未交给 Codex');
  if (!turnStart.params.input.some((input) => input.type === 'localImage' && input.path.endsWith(imageFile.path.replaceAll('/', path.sep)))) throw new Error('图片未作为 localImage 输入');

  const files = (await (await api(`/api/files?projectId=${encodeURIComponent(project.id)}`)).json()).files;
  if (files.length < 4) throw new Error('项目文件列表不正确');
  if (!files.some((file) => file.name === 'read-me.txt') || !files.some((file) => file.name === 'photo.png')) throw new Error('文件显示名称错误');
  const downloadResponse = await api(`/api/files/download?projectId=${encodeURIComponent(project.id)}&path=${encodeURIComponent(textFile.path)}`);
  if (!downloadResponse.headers.get('content-disposition')?.includes('read-me.txt') || downloadResponse.headers.get('content-disposition')?.includes(uploadId)) throw new Error('下载文件名泄露内部 UUID');
  const previewResponse = await api(`/api/files/preview?projectId=${encodeURIComponent(project.id)}&path=${encodeURIComponent(textFile.path)}`);
  if (!previewResponse.ok || !previewResponse.headers.get('content-type')?.startsWith('text/plain')) throw new Error('文本文件预览失败');
  if (!previewResponse.headers.get('content-disposition')?.startsWith('inline') || previewResponse.headers.get('content-disposition')?.includes(uploadId)) throw new Error('预览文件名或 disposition 错误');
  if (await previewResponse.text() !== 'hello attachment') throw new Error('预览内容不正确');
  const defaultFiles = (await (await api('/api/files?projectId=default')).json()).files;
  if (defaultFiles.length !== 0) throw new Error('文件跨项目泄露');
  const apiUnit = await readFile(path.join(root, 'deploy', 'palm-secretary-api.service'), 'utf8');
  if (!apiUnit.includes('NoNewPrivileges=false') || !apiUnit.includes('RestrictSUIDSGID=false')) throw new Error('API systemd 单元仍阻止 sudo 提权');
  if (/^CapabilityBoundingSet=/m.test(apiUnit) || !apiUnit.includes('ProtectSystem=false') || !apiUnit.includes('ProtectHome=false')) throw new Error('API systemd 单元仍限制完整 root 运维');

  const renamedThread = await api(`/api/threads/${encodeURIComponent(accepted.threadId)}?projectId=${encodeURIComponent(project.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '已重命名对话' }) });
  if (!renamedThread.ok || (await renamedThread.json()).thread?.title !== '已重命名对话') throw new Error('对话重命名失败');
  const favoriteThread = await api(`/api/threads/${encodeURIComponent(accepted.threadId)}?projectId=${encodeURIComponent(project.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ favorite: true }) });
  if (!favoriteThread.ok || !(await favoriteThread.json()).thread?.favorite) throw new Error('对话收藏失败');
  const search = await api(`/api/search?projectId=${encodeURIComponent(project.id)}&q=${encodeURIComponent('MOCK_OK')}`);
  const searchResults = (await search.json()).results;
  if (!search.ok || !searchResults.some((item) => item.threadId === accepted.threadId)) throw new Error('助手回复全文搜索失败');
  const attachmentSearch = await api(`/api/search?projectId=${encodeURIComponent(project.id)}&q=${encodeURIComponent('hello attachment')}`);
  if (!(await attachmentSearch.json()).results.some((item) => item.kind === 'file' && item.title === 'read-me.txt')) throw new Error('附件全文搜索失败');
  const archivedThread = await api(`/api/threads/${encodeURIComponent(accepted.threadId)}?projectId=${encodeURIComponent(project.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true }) });
  if (!archivedThread.ok) throw new Error('对话归档失败');
  const activeThreads = (await (await api(`/api/threads?projectId=${encodeURIComponent(project.id)}`)).json()).threads;
  const archivedThreads = (await (await api(`/api/threads?projectId=${encodeURIComponent(project.id)}&archived=1`)).json()).threads;
  if (activeThreads.some((thread) => thread.threadId === accepted.threadId) || !archivedThreads.some((thread) => thread.threadId === accepted.threadId)) throw new Error('归档筛选失败');
  const restoredRecord = await api(`/api/threads/${encodeURIComponent(accepted.threadId)}?projectId=${encodeURIComponent(project.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: false }) });
  if (!restoredRecord.ok) throw new Error('归档恢复失败');
  const deletedRecord = await api(`/api/threads/${encodeURIComponent(accepted.threadId)}?projectId=${encodeURIComponent(project.id)}`, { method: 'DELETE' });
  if (deletedRecord.status !== 204) throw new Error('对话记录删除失败');
  if (((await (await api(`/api/tasks?projectId=${encodeURIComponent(project.id)}`)).json()).tasks).some((task) => task.threadId === accepted.threadId)) throw new Error('删除对话后关联任务仍残留');
  const css = await readFile(path.join(root, 'app', 'globals.css'), 'utf8');
  if (!css.includes('--sticky-context-offset') || !css.includes('--mobile-tabs-height') || !css.includes('top: var(--sticky-context-offset)')) throw new Error('冻结栏未使用统一偏移变量');
  console.log('PALM_V012_INTEGRATION_OK');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  if (stderr) process.stderr.write(stderr);
}
