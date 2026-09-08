import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { ProjectStore } from '../dist-server/project-store.js';
import { SessionStore } from '../dist-server/session-store.js';
import { createSession, hashPassword } from '../dist-server/auth.js';

const workspace = await mkdtemp(path.join(tmpdir(), 'palm-reliability-'));
let server;
let bridge;
const sockets = [];
try {
  const store = new ProjectStore(workspace);
  await store.initialize();
  const project = await store.createProject('kept');
  const stateFile = path.join(workspace, '.palm', 'state.json');
  const original = await readFile(stateFile, 'utf8');
  for (const invalid of ['{broken', JSON.stringify({ version: 999, projects: [], threads: [] })]) {
    await writeFile(stateFile, invalid);
    await assert.rejects(new ProjectStore(workspace).initialize(), /保留原文件/);
    assert.equal(await readFile(stateFile, 'utf8'), invalid);
  }
  await writeFile(stateFile, original);
  const blocker = `${stateFile}.${process.pid}.tmp`;
  await mkdir(blocker);
  const writes = await Promise.allSettled([store.renameProject(project.id, 'failed'), store.renameProject('default', 'also failed')]);
  assert.ok(writes.every((result) => result.status === 'rejected'));
  assert.equal(store.getProject(project.id).name, 'kept');
  assert.equal(store.getProject('default').name, '默认项目');
  assert.equal(await readFile(stateFile, 'utf8'), original);
  await rm(blocker, { recursive: true });
  await store.renameProject(project.id, 'recovered');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).projects.find((p) => p.id === project.id).name, 'recovered');

  await store.rememberThread('early-thread', project.id, 'early');
  await store.rememberTask('pending:early-request', 'early-thread', project.id, 'early', [], {}, 'early-request');
  await store.finishTask('early-thread', 'actual-turn', 'completed');
  await store.bindTaskTurn('early-thread', 'early-request', 'actual-turn');
  const early = store.findTaskByClientRequestId(project.id, 'early-request');
  assert.equal(early.status, 'completed');
  assert.equal(early.turnId, 'actual-turn');
  await store.rememberTask('pending:uncertain-request', 'early-thread', project.id, 'uncertain', [], {}, 'uncertain-request');
  const restarted = new ProjectStore(workspace);
  await restarted.initialize();
  assert.ok(restarted.findTaskByClientRequestId(project.id, 'uncertain-request'), 'uncertain request survives restart');
  assert.equal(restarted.hasRunningTask(project.id), true, 'uncertain submission blocks new work after restart');
  await restarted.resolveSubmission(project.id, 'pending:uncertain-request');
  assert.equal(restarted.hasRunningTask(project.id), false);
  assert.ok(restarted.findTaskByClientRequestId(project.id, 'uncertain-request'), 'manual resolution must keep the dedupe record');

  const goodFile = path.join(store.outbox(project.id), 'good.txt');
  await writeFile(goodFile, 'safe');
  const handle = await store.openStoredFile(project.id, 'outbox/good.txt');
  assert.equal(await handle.readFile('utf8'), 'safe');
  await handle.close();
  const outside = path.join(workspace, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'private');
  await symlink(outside, path.join(store.outbox(project.id), 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(store.openStoredFile(project.id, 'outbox/escape/secret.txt'));
  await assert.rejects(store.deleteStoredFile(project.id, 'outbox/escape/secret.txt'));
  assert.equal(await readFile(path.join(outside, 'secret.txt'), 'utf8'), 'private');
  await store.deleteStoredFile(project.id, 'outbox/good.txt');

  const secret = 'test-secret-for-reliability-v024';
  const sessionFile = path.join(workspace, '.palm', 'test-sessions.json');
  const sessions = new SessionStore(sessionFile, secret);
  await sessions.initialize();
  const token = createSession(secret, 1);
  assert.equal(sessions.valid(token), true);
  assert.equal(sessions.valid(createSession(secret, -1)), false);
  await sessions.revoke(token);
  const restoredSessions = new SessionStore(sessionFile, secret);
  await restoredSessions.initialize();
  assert.equal(restoredSessions.valid(token), false);
  assert.ok(!(await readFile(sessionFile, 'utf8')).includes(token));

  process.env.SESSION_SECRET = secret;
  process.env.WORKSPACE_ROOT = workspace;
  const { config } = await import('../dist-server/config.js');
  const { CodexBridge } = await import('../dist-server/app-server.js');
  config.codexBin = path.join(workspace, 'nonexistent-binary');
  bridge = new CodexBridge();
  await assert.rejects(bridge.ready());
  await assert.rejects(bridge.ready());
  config.codexBin = process.execPath;
  config.codexArgsPrefix = [path.resolve('tests/mock-app-server.mjs')];
  process.env.MOCK_INITIALIZE_ERROR = '1';
  await assert.rejects(bridge.ready(), /injected initialize failure/);
  delete process.env.MOCK_INITIALIZE_ERROR;
  await bridge.ready();
  assert.ok(await bridge.call('model/list'));
  await bridge.close();
  bridge = undefined;

  const port = 4594;
  const origin = `http://127.0.0.1:${port}`;
  const apiWorkspace = path.join(workspace, 'api');
  const seed = new ProjectStore(apiWorkspace);
  await seed.initialize();
  const uncertainProject = await seed.createProject('uncertain after restart');
  const uncertainId = '123e4567-e89b-42d3-a456-426614174222';
  await seed.rememberThread('uncertain-thread', uncertainProject.id, 'uncertain');
  await seed.rememberTask(`pending:${uncertainId}`, 'uncertain-thread', uncertainProject.id, 'uncertain', [], {}, uncertainId);
  server = spawn(process.execPath, ['dist-server/index.js'], {
    env: { ...process.env, WORKSPACE_ROOT: apiWorkspace, APP_PORT: String(port), APP_HOST: '127.0.0.1', APP_ORIGIN: origin,
      APP_PASSWORD_HASH: await hashPassword('reliability-test'), SESSION_SECRET: secret,
      CODEX_BIN: process.execPath, CODEX_ARGS_PREFIX_JSON: JSON.stringify([path.resolve('tests/mock-app-server.mjs')]),
      MOCK_EARLY_COMPLETION: '1', CODEX_VERSION_CHECK_ENABLED: '0', TASK_STOP_FREE_BYTES: '1', DISK_WARNING_FREE_BYTES: '1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  server.stderr.on('data', (data) => { errors += data; });
  let healthy = false;
  for (let index = 0; index < 100; index++) {
    if ((await fetch(`${origin}/api/health`).catch(() => null))?.ok) { healthy = true; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(healthy, errors);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'reliability-test' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { Origin: origin, Cookie: cookie };
  const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/ws`, { headers });
  sockets.push(socket);
  const messages = [];
  socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  const request = { type: 'turn.start', projectId: 'default', text: 'early completion', clientRequestId: '123e4567-e89b-42d3-a456-426614174111' };
  socket.send(JSON.stringify(request));
  // Retry while the first invocation is still waiting for its delayed response.
  await new Promise((resolve) => setTimeout(resolve, 80));
  socket.send(JSON.stringify(request));
  for (let index = 0; index < 100 && !messages.some((m) => m.type === 'turn.accepted'); index++) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(messages.some((m) => m.type === 'turn.accepted'), JSON.stringify(messages));
  assert.ok(!messages.some((m) => m.type === 'error'), JSON.stringify(messages));
  const tasks = (await (await fetch(`${origin}/api/tasks?projectId=default`, { headers })).json()).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'completed', 'completion before start response must not leave a running task');
  socket.send(JSON.stringify(request));
  for (let index = 0; index < 50 && !messages.some((m) => m.replayed); index++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(messages.some((m) => m.replayed));
  socket.send(JSON.stringify({ ...request, projectId: uncertainProject.id, clientRequestId: uncertainId }));
  for (let index = 0; index < 50 && !messages.some((m) => m.clientRequestId === uncertainId); index++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(messages.some((m) => m.clientRequestId === uncertainId && m.type === 'error' && m.message.includes('核对')));
  const resolveUrl = `${origin}/api/tasks/${encodeURIComponent(`pending:${uncertainId}`)}/resolve-submission?projectId=${uncertainProject.id}`;
  const resolveInit = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } };
  assert.equal((await fetch(resolveUrl, { ...resolveInit, body: '{}' })).status, 400);
  assert.equal((await fetch(resolveUrl, { ...resolveInit, body: JSON.stringify({ confirmNotRunning: true }) })).status, 200);
  const resolvedTasks = (await (await fetch(`${origin}/api/tasks?projectId=${uncertainProject.id}`, { headers })).json()).tasks;
  assert.equal(resolvedTasks.length, 1);
  assert.equal(resolvedTasks[0].submissionPending, undefined);
  assert.equal(resolvedTasks[0].status, 'interrupted');
  const expiring = new WebSocket(`${origin.replace('http', 'ws')}/api/ws`, { headers: { Origin: origin, Cookie: `palm_session=${createSession(secret, 0.00015)}` } });
  sockets.push(expiring);
  await once(expiring, 'open');
  const expiredClosed = once(expiring, 'close');
  await new Promise((resolve) => setTimeout(resolve, 600));
  expiring.send(JSON.stringify({ type: 'thread.subscribe', projectId: 'default', threadId: tasks[0].threadId }));
  assert.equal((await expiredClosed)[0], 1008);
  const closed = once(socket, 'close');
  assert.equal((await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers })).status, 200);
  await closed;
  assert.equal((await fetch(`${origin}/api/projects`, { headers })).status, 401);
  console.log('PALM_V024_RELIABILITY_OK');
} finally {
  for (const socket of sockets) socket.terminate();
  if (bridge) await bridge.close();
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
