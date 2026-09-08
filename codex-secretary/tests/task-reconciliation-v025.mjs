import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { submissionEvidence, reconcileTurn } from '../dist-server/task-reconciliation.js';
import { ProjectStore } from '../dist-server/project-store.js';
import { TaskReconciler } from '../dist-server/task-reconciler.js';

const history = (...turns) => ({ thread: { id: 'thread', turns } });
const turn = (id, status = 'completed', text = 'input') => ({ id, status, items: [{ type: 'userMessage', content: [{ type: 'text', text }] }] });
const evidence = submissionEvidence(history(turn('old')), 'thread', 'input');
const pending = { threadId: 'thread', turnId: 'pending:request', submissionEvidence: evidence };
assert.equal(reconcileTurn(pending, history(turn('old'), turn('new'))).id, 'new');
assert.equal(reconcileTurn(pending, history(turn('old'))), undefined);
assert.equal(reconcileTurn(pending, history(turn('a'), turn('b'))), undefined);
assert.equal(reconcileTurn(pending, history(turn('new', 'unknown'))), undefined);
assert.equal(reconcileTurn(pending, history(turn('new', 'completed', 'different'))), undefined);
assert.equal(reconcileTurn(pending, { thread: { id: 'other', turns: [turn('new')] } }), undefined);
assert.equal(reconcileTurn({ ...pending, submissionEvidence: undefined }, history(turn('new'))), undefined);
assert.equal(reconcileTurn({ ...pending, turnId: 'known' }, history(turn('known', 'inProgress'))).status, 'running');
assert.equal(reconcileTurn({ ...pending, turnId: 'known' }, history({ ...turn('known', 'failed'), error: { message: 'failure' } })).errorMessage, 'failure');
assert.throws(() => submissionEvidence({}, 'thread', 'input'));

const workspace = await mkdtemp(path.join(tmpdir(), 'palm-reconciliation-'));
try {
  let store = new ProjectStore(workspace);
  await store.initialize();
  await store.rememberThread('thread', 'default', 'test');
  await writeFile(path.join(store.outbox('default'), 'old.txt'), 'old');
  await store.rememberTask('pending:request', 'thread', 'default', 'input', [], await store.outputBaseline('default'), 'request', undefined, evidence);
  store = new ProjectStore(workspace);
  await store.initialize();
  assert.equal(store.hasRunningTask('default'), true);
  assert.equal(store.listCompletedTasksSince('1970-01-01T00:00:00.000Z').length, 0);
  assert.equal(store.listTasks('default')[0].submissionEvidence, undefined, 'private evidence must not leak');
  await writeFile(path.join(store.outbox('default'), 'new.txt'), 'new');
  let reads = 0;
  let unblock;
  let block = true;
  const changes = [];
  const reconciler = new TaskReconciler(store, async () => { reads++; await new Promise(resolve => { unblock = resolve; }); return history(turn('old'), turn('new')); }, () => block, task => changes.push(task));
  assert.equal((await reconciler.run('default', true)).checked, 0);
  block = false;
  const first = reconciler.run('default', true);
  const second = reconciler.run('default', true);
  assert.equal(reads, 1, 'concurrent reads coalesce');
  unblock();
  assert.equal((await first).recovered, 1);
  await second;
  assert.equal(changes.length, 1);
  const result = store.findTaskByClientRequestId('default', 'request');
  assert.equal(result.status, 'completed');
  assert.equal(result.turnId, 'new');
  assert.deepEqual(result.outputPaths, ['outbox/new.txt']);
  assert.ok(result.reconciledAt);
  assert.equal(store.hasRunningTask('default'), false);
  assert.equal(await store.applyReconciliation('default', 'new', { id: 'new', status: 'failed', items: [] }), undefined);

  await store.rememberTask('pending:manual', 'thread', 'default', 'input', [], {}, 'manual', undefined, evidence);
  let late;
  const racing = new TaskReconciler(store, () => new Promise(resolve => { late = resolve; }), () => false, () => assert.fail('manual resolution overwritten'));
  const poll = racing.run('default', true);
  await store.resolveSubmission('default', 'pending:manual');
  late(history(turn('other')));
  assert.equal((await poll).recovered, 0);
  assert.equal(store.findTaskByClientRequestId('default', 'manual').status, 'interrupted');

  await store.rememberTask('known', 'thread', 'default', 'input', [], {}, 'known-request');
  await store.interruptRunningTasks('connection lost');
  const missing = new TaskReconciler(store, async () => history(), () => false, () => assert.fail('missing history guessed'));
  assert.equal((await missing.run('default', true)).unresolved, 1);
  assert.equal(store.hasRunningTask('default'), true);
  assert.equal((await missing.run('default')).checked, 0, 'cooldown avoids repeated reads');
  const failed = new TaskReconciler(store, async () => history({ ...turn('known', 'failed'), error: { message: 'actual failure' } }), () => false, () => {});
  assert.equal((await failed.run('default', true)).recovered, 1);
  assert.equal(store.findTaskByClientRequestId('default', 'known-request').errorMessage, 'actual failure');
  store = new ProjectStore(workspace);
  await store.initialize();
  assert.equal(store.findTaskByClientRequestId('default', 'request').status, 'completed');
  console.log('v025 task reconciliation regressions passed');
} finally {
  await rm(workspace, { recursive: true, force: true });
}

// Exercise the authenticated HTTP/WS flow with a missing start receipt and
// missing terminal event. History is the only source of the final result.
const { spawn } = await import('node:child_process');
const { once } = await import('node:events');
const { readFile } = await import('node:fs/promises');
const { default: WebSocket } = await import('ws');
const { hashPassword } = await import('../dist-server/auth.js');
const apiWorkspace = await mkdtemp(path.join(tmpdir(), 'palm-reconcile-api-'));
const origin = 'http://127.0.0.1:4595';
const logFile = path.join(apiWorkspace, 'calls.jsonl');
let server;
let socket;
try {
  server = spawn(process.execPath, ['dist-server/index.js'], {
    env: { ...process.env, WORKSPACE_ROOT: apiWorkspace, APP_PORT: '4595', APP_HOST: '127.0.0.1', APP_ORIGIN: origin,
      APP_PASSWORD_HASH: await hashPassword('reconciliation-test'), SESSION_SECRET: 'reconciliation-test-secret',
      CODEX_BIN: process.execPath, CODEX_ARGS_PREFIX_JSON: JSON.stringify([path.resolve('tests/mock-app-server.mjs')]),
      MOCK_LOST_START_RESPONSE: '1', MOCK_SKIP_TERMINAL: '1', MOCK_LOG: logFile,
      CODEX_VERSION_CHECK_ENABLED: '0', TASK_STOP_FREE_BYTES: '1', DISK_WARNING_FREE_BYTES: '1', LOG_LEVEL: 'error' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  const until = async (predicate) => { for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); } assert.fail(logs || 'timed out'); };
  await until(async () => (await fetch(`${origin}/api/health`).catch(() => null))?.ok);
  assert.equal((await fetch(`${origin}/api/tasks/reconcile`, { method: 'POST', headers: { Origin: origin } })).status, 401);
  const login = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'reconciliation-test' }) });
  assert.equal(login.status, 200);
  const headers = { Origin: origin, Cookie: login.headers.get('set-cookie').split(';')[0] };
  socket = new WebSocket('ws://127.0.0.1:4595/api/ws', { headers });
  const messages = [];
  socket.on('message', data => messages.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  const request = { type: 'turn.start', projectId: 'default', text: 'recover missing receipt', clientRequestId: '123e4567-e89b-42d3-a456-426614174555' };
  socket.send(JSON.stringify(request));
  await until(() => messages.some(message => message.type === 'error' && message.clientRequestId === request.clientRequestId));
  await new Promise(resolve => setTimeout(resolve, 100));
  const response = await fetch(`${origin}/api/tasks/reconcile?projectId=default`, { method: 'POST', headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).recovered, 1);
  const tasks = (await (await fetch(`${origin}/api/tasks?projectId=default`, { headers })).json()).tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].status, 'completed');
  assert.equal(tasks[0].submissionPending, undefined);
  assert.equal(tasks[0].submissionEvidence, undefined);
  assert.equal(tasks[0].outputPaths.length, 2);
  socket.send(JSON.stringify(request));
  await until(() => messages.some(message => message.type === 'turn.accepted' && message.replayed));
  const calls = (await readFile(logFile, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.method === 'turn/start').length, 1, 'reconciliation/replay must not execute twice');
  console.log('v025 missing receipt HTTP/WS recovery passed');
} finally {
  socket?.terminate();
  if (server && server.exitCode === null) { const exited = once(server, 'exit'); server.kill('SIGTERM'); await exited; }
  await rm(apiWorkspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
