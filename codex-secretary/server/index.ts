import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { z } from 'zod';
import { config } from './config.js';
import { createSession, verifyPassword, verifySession } from './auth.js';
import { CodexBridge } from './app-server.js';
import { ProjectStore } from './project-store.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: '127.0.0.1' });
const bridge = new CodexBridge();
type SocketLike = { send: (value: string) => void; close: (code?: number, reason?: string) => void; readyState: number };
const sockets = new Set<SocketLike>();
const threadSockets = new Map<string, Set<SocketLike>>();
const socketThreads = new Map<SocketLike, string>();
const loadedThreads = new Set<string>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
type TurnAcceptance = { threadId: string; payload: { turn?: { id?: string } }; replayed?: boolean; clientRequestId: string };
const pendingTurnRequests = new Map<string, Promise<TurnAcceptance | undefined>>();
const projects = new ProjectStore(config.workspace);
const execFileAsync = promisify(execFile);
const OUTPUT_INSTRUCTIONS = `你运行在掌心助理的独立项目工作区。用户不需要知道目录约定。只要任务产生可下载成果（文档、表格、演示文稿、PDF、图片、压缩包、代码包或其他文件），你必须主动把最终版本保存到当前工作目录的 outbox/，使用清晰中文文件名，并在最终回复中说明文件名。若成果是需要直接查看或扫码的图片，最终回复中还必须单独写一行 Markdown 图片语法：![图片说明](outbox/实际文件名.png)，路径必须与真实文件完全一致；掌心助理会在聊天中直接显示该图片。不要要求用户说出 outbox，也不要只在聊天中声称已生成而不实际写入。纯问答无需强行创建文件。用户上传的附件位于 inbox/。`;
type CodexModel = { id: string; model: string; displayName: string; description: string; isDefault: boolean; hidden?: boolean; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>; defaultReasoningEffort: string };
let modelCache: { expiresAt: number; models: CodexModel[] } | undefined;

function threadMarkdown(value: unknown, title: string): string {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const thread = root.thread && typeof root.thread === 'object' ? root.thread as Record<string, unknown> : root;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const sections = [`# ${title}`, '', `导出时间：${new Date().toISOString()}`, ''];
  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;
    const items = Array.isArray((turn as Record<string, unknown>).items) ? (turn as Record<string, unknown>).items as unknown[] : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? '');
      if (!['userMessage', 'agentMessage'].includes(type)) continue;
      const content = record.content;
      const text = String(record.text ?? record.message ?? '') || (Array.isArray(content)
        ? content.map((part) => part && typeof part === 'object' ? String((part as Record<string, unknown>).text ?? '') : '').filter(Boolean).join('\n')
        : '');
      if (!text.trim()) continue;
      sections.push(type === 'userMessage' ? '## 我' : '## 掌心助理', '', text.trim(), '');
    }
  }
  return `${sections.join('\n').trim()}\n`;
}

await mkdir(config.workspace, { recursive: true });
await projects.initialize();

await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: config.maxUploadBytes, files: 1, fields: 4 },
  throwFileSizeLimit: false,
});
await app.register(websocket);
app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 9 * 1024 * 1024 }, (_request, body, done) => done(null, body));

function authenticated(request: FastifyRequest): boolean {
  const tailscaleLogin = request.headers['tailscale-user-login'];
  const trustedTailscaleOwner = config.tailscaleOwnerLogin
    && typeof tailscaleLogin === 'string'
    && tailscaleLogin.trim().toLowerCase() === config.tailscaleOwnerLogin;
  return Boolean(trustedTailscaleOwner) || verifySession(request.cookies.palm_session, config.sessionSecret);
}

function originAllowed(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  return !origin || origin === config.origin;
}

function requireOwner(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!originAllowed(request)) {
    void reply.code(403).send({ error: '来源校验失败' });
    return false;
  }
  if (!authenticated(request)) {
    void reply.code(401).send({ error: '请先登录' });
    return false;
  }
  return true;
}

function loginRateLimitKey(request: FastifyRequest): string {
  const cloudflareIp = request.headers['cf-connecting-ip'];
  if (typeof cloudflareIp === 'string' && isIP(cloudflareIp.trim())) return cloudflareIp.trim();
  return request.ip;
}

async function diskInfo() {
  const info = await statfs(config.workspace);
  const freeBytes = Number(info.bavail) * Number(info.bsize);
  const totalBytes = Number(info.blocks) * Number(info.bsize);
  return {
    freeBytes,
    totalBytes,
    usedPercent: Math.round((1 - freeBytes / totalBytes) * 1000) / 10,
    warning: freeBytes < config.diskWarningFreeBytes,
    tasksPaused: freeBytes < config.taskStopFreeBytes,
  };
}

async function sudoInfo(): Promise<{ available: boolean }> {
  return new Promise((resolve) => {
    execFile('/usr/bin/sudo', ['-n', '/usr/bin/id', '-u'], { timeout: 3_000 }, (error, stdout) => {
      resolve({ available: !error && stdout.trim() === '0' });
    });
  });
}

function broadcast(value: unknown): void {
  const encoded = JSON.stringify(value);
  for (const socket of sockets) {
    if (socket.readyState === 1) socket.send(encoded);
  }
}

function sendToThread(threadId: string, value: unknown): void {
  const encoded = JSON.stringify(value);
  for (const socket of threadSockets.get(threadId) ?? []) {
    if (socket.readyState === 1) socket.send(encoded);
  }
}

function detachSocketFromThread(socket: SocketLike): void {
  const previousThreadId = socketThreads.get(socket);
  if (!previousThreadId) return;
  const attached = threadSockets.get(previousThreadId);
  attached?.delete(socket);
  if (attached?.size === 0) threadSockets.delete(previousThreadId);
  socketThreads.delete(socket);
}

function setSocketThread(socket: SocketLike, threadId: string): void {
  if (socketThreads.get(socket) === threadId) return;
  detachSocketFromThread(socket);
  const attached = threadSockets.get(threadId) ?? new Set<SocketLike>();
  attached.add(socket);
  threadSockets.set(threadId, attached);
  socketThreads.set(socket, threadId);
}

bridge.on('message', async (message: Record<string, unknown>) => {
  if (typeof message.id === 'number' && typeof message.method === 'string') {
    if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
      bridge.respond(message.id, { decision: 'acceptForSession' });
    } else if (message.method === 'item/permissions/requestApproval') {
      const params = message.params as { permissions?: unknown } | undefined;
      bridge.respond(message.id, { permissions: params?.permissions ?? {}, scope: 'session', strictAutoReview: false });
    }
  }
  const params = message.params as { threadId?: unknown } | undefined;
  const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined;
  if (threadId && typeof message.method === 'string' && ['turn/completed', 'turn/failed', 'turn/interrupted'].includes(message.method)) {
    const turn = params && typeof (params as Record<string, unknown>).turn === 'object' ? (params as Record<string, unknown>).turn as Record<string, unknown> : undefined;
    const turnId = typeof turn?.id === 'string' ? turn.id : typeof (params as Record<string, unknown> | undefined)?.turnId === 'string' ? (params as Record<string, unknown>).turnId as string : undefined;
    const status = message.method === 'turn/completed' ? 'completed' : message.method === 'turn/interrupted' ? 'interrupted' : 'failed';
    const failure = params && typeof (params as Record<string, unknown>).error === 'object'
      ? (params as Record<string, unknown>).error as Record<string, unknown> : undefined;
    const errorMessage = typeof failure?.message === 'string' ? failure.message : undefined;
    try { await projects.finishTask(threadId, turnId, status, errorMessage); }
    catch (error) { app.log.warn({ err: error }, '任务状态写入失败'); }
  }
  if (threadId) sendToThread(threadId, { type: 'codex.event', payload: message });
  else if (typeof message.id !== 'number') broadcast({ type: 'codex.event', payload: message });
});
bridge.on('offline', async (details) => {
  const interrupted = await projects.interruptRunningTasks('Codex App Server 意外退出，请确认结果后重新执行').catch(() => 0);
  pendingTurnRequests.clear();
  broadcast({ type: 'codex.offline', payload: { ...details, interrupted } });
  broadcast({ type: 'tasks.changed', payload: { interrupted } });
});
bridge.on('diagnostic', (details) => app.log.info(details));

app.get('/api/health', async () => ({ ok: true }));

app.post('/api/auth/login', async (request, reply) => {
  if (!originAllowed(request)) return reply.code(403).send({ error: '来源校验失败' });
  if (!config.passwordHash) return reply.code(403).send({ error: '密码登录未启用，请通过 Tailscale 私网访问' });
  const ip = loginRateLimitKey(request);
  const now = Date.now();
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.resetAt > now && attempt.count >= 8) {
    return reply.code(429).send({ error: '尝试次数过多，请稍后再试' });
  }
  const parsed = z.object({ password: z.string().min(1).max(256) }).safeParse(request.body);
  const valid = parsed.success && await verifyPassword(parsed.data.password, config.passwordHash);
  if (!valid) {
    const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + 15 * 60_000 };
    current.count += 1;
    loginAttempts.set(ip, current);
    return reply.code(401).send({ error: '密码不正确' });
  }
  loginAttempts.delete(ip);
  reply.setCookie('palm_session', createSession(config.sessionSecret, config.sessionHours), {
    path: '/', httpOnly: true, secure: config.origin.startsWith('https://'), sameSite: 'strict',
    maxAge: config.sessionHours * 60 * 60,
  });
  return { ok: true };
});

app.post('/api/auth/logout', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  reply.clearCookie('palm_session', { path: '/' });
  return { ok: true };
});

app.get('/api/session', async (request) => ({ authenticated: authenticated(request) }));

app.get('/api/status', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const [disk, sudo] = await Promise.all([diskInfo(), sudoInfo()]);
  return { disk, sudo, codex: { configured: true, approvalPolicy: 'never', sandbox: 'danger-full-access', osUser: 'codex' }, proxy: { host: '127.0.0.1', port: 7897 } };
});

app.get('/api/usage', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  await bridge.ready();
  const [rateLimits, usage] = await Promise.allSettled([
    bridge.call('account/rateLimits/read'),
    bridge.call('account/usage/read'),
  ]);
  return {
    rateLimits: rateLimits.status === 'fulfilled' ? rateLimits.value : null,
    usage: usage.status === 'fulfilled' ? usage.value : null,
  };
});

async function availableModels(force = false): Promise<CodexModel[]> {
  if (!force && modelCache && modelCache.expiresAt > Date.now()) return modelCache.models;
  await bridge.ready();
  const response = await bridge.call('model/list', { limit: 100, includeHidden: false }) as { data?: CodexModel[] };
  const models = (response.data ?? []).filter((model) => model && typeof model.model === 'string' && !model.hidden);
  modelCache = { expiresAt: Date.now() + 5 * 60_000, models };
  return models;
}

app.get<{ Querystring: { refresh?: string } }>('/api/models', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try { return { models: await availableModels(request.query.refresh === '1') }; }
  catch { return reply.code(503).send({ error: '暂时无法读取可用模型，请稍后刷新' }); }
});

app.get<{ Querystring: { projectId?: string; archived?: string } }>('/api/threads', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const projectId = request.query.projectId ?? 'default';
  return { threads: projects.listThreads(projectId, request.query.archived === '1') };
});

app.patch<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/threads/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.object({ title: z.string().min(1).max(80).optional(), archived: z.boolean().optional(), favorite: z.boolean().optional() }).refine((value) => value.title !== undefined || value.archived !== undefined || value.favorite !== undefined).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: '对话更新内容无效' });
  try { return { thread: await projects.updateThread(request.params.id, request.query.projectId ?? 'default', parsed.data) }; }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '对话更新失败' }); }
});

app.delete<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/threads/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try { await projects.deleteThread(request.params.id, request.query.projectId ?? 'default'); return reply.code(204).send(); }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '对话删除失败' }); }
});

app.get<{ Querystring: { projectId?: string } }>('/api/tasks', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  return { tasks: projects.listTasks(request.query.projectId ?? 'default') };
});

function searchableText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(searchableText).join('\n');
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => item && typeof item === 'object' ? searchableText(item) : ['text', 'content', 'title', 'message', 'output', 'name'].includes(key) ? searchableText(item) : '')
    .filter(Boolean).join('\n');
}

app.get<{ Querystring: { q?: string; projectId?: string; all?: string } }>('/api/search', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const query = request.query.q?.trim().toLocaleLowerCase('zh-CN') ?? '';
  if (query.length < 2) return { results: [] };
  if (query.length > 120) return reply.code(400).send({ error: '搜索内容过长' });
  const projectId = request.query.all === '1' ? undefined : request.query.projectId ?? 'default';
  const candidates = projects.allThreads(projectId).slice(0, 80);
  const results: Array<{ kind: 'thread' | 'task' | 'file'; projectId: string; threadId?: string; path?: string; title: string; snippet: string; updatedAt?: string }> = [];
  await bridge.ready();
  for (const thread of candidates) {
    if (results.length >= 60) break;
    let text = thread.title;
    try { text += `\n${searchableText(await bridge.call('thread/read', { threadId: thread.threadId, includeTurns: true }))}`; } catch { /* stale thread */ }
    const folded = text.toLocaleLowerCase('zh-CN');
    const index = folded.indexOf(query);
    if (index >= 0) results.push({ kind: 'thread', projectId: thread.projectId, threadId: thread.threadId, title: thread.title, snippet: text.slice(Math.max(0, index - 48), index + query.length + 88).replace(/\s+/g, ' ').trim(), updatedAt: thread.updatedAt });
  }
  const projectIds = projectId ? [projectId] : projects.listProjects().map((project) => project.id);
  const textExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log', '.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.yml', '.yaml']);
  for (const id of projectIds.slice(0, 30)) {
    for (const task of projects.listTasks(id)) {
      if (results.length >= 80) break;
      const index = task.title.toLocaleLowerCase('zh-CN').indexOf(query);
      if (index >= 0) results.push({ kind: 'task', projectId: id, threadId: task.threadId, title: task.title, snippet: task.errorMessage ?? task.title, updatedAt: task.updatedAt });
    }
    for (const folder of ['inbox', 'outbox'] as const) {
      const root = folder === 'inbox' ? projects.inbox(id) : projects.outbox(id);
      for (const entry of (await readdir(root, { withFileTypes: true }).catch(() => [])).slice(0, 200)) {
        if (!entry.isFile() || results.length >= 100) continue;
        const fullPath = path.join(root, entry.name);
        const displayName = displayFileName(entry.name);
        let text = displayName;
        const details = await stat(fullPath).catch(() => null);
        if (details && details.size <= 512 * 1024 && textExtensions.has(path.extname(entry.name).toLowerCase())) text += `\n${await readFile(fullPath, 'utf8').catch(() => '')}`;
        const index = text.toLocaleLowerCase('zh-CN').indexOf(query);
        if (index >= 0) results.push({ kind: 'file', projectId: id, path: `${folder}/${entry.name}`, title: displayName, snippet: text.slice(Math.max(0, index - 48), index + query.length + 88).replace(/\s+/g, ' ').trim(), updatedAt: details?.mtime.toISOString() });
      }
    }
  }
  return { results };
});

app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/threads/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const projectId = request.query.projectId ?? 'default';
  projects.assertThreadProject(request.params.id, projectId);
  await bridge.ready();
  return bridge.call('thread/read', { threadId: request.params.id, includeTurns: true });
});

app.get<{ Params: { id: string }; Querystring: { projectId?: string } }>('/api/threads/:id/export', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const projectId = request.query.projectId ?? 'default';
  projects.assertThreadProject(request.params.id, projectId);
  const thread = projects.listThreads(projectId).find((item) => item.threadId === request.params.id)
    ?? projects.listThreads(projectId, true).find((item) => item.threadId === request.params.id);
  await bridge.ready();
  const content = threadMarkdown(await bridge.call('thread/read', { threadId: request.params.id, includeTurns: true }), thread?.title ?? '掌心助理对话');
  const filename = `${(thread?.title ?? '掌心助理对话').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60)}.md`;
  return reply.header('Content-Type', 'text/markdown; charset=utf-8').header('Cache-Control', 'no-store')
    .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`).send(content);
});

app.get('/api/projects', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  return { projects: projects.listProjects() };
});

app.post('/api/projects', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.object({ name: z.string().min(1).max(50) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: '项目名称无效' });
  return reply.code(201).send({ project: await projects.createProject(parsed.data.name) });
});

app.patch<{ Params: { id: string } }>('/api/projects/:id', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.object({ name: z.string().min(1).max(50).optional(), archived: z.boolean().optional() }).refine((value) => value.name !== undefined || value.archived !== undefined).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: '项目名称无效' });
  try { return { project: parsed.data.name !== undefined ? await projects.renameProject(request.params.id, parsed.data.name) : await projects.archiveProject(request.params.id, Boolean(parsed.data.archived)) }; }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '项目更新失败' }); }
});

app.post<{ Params: { id: string } }>('/api/projects/:id/duplicate', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.object({ name: z.string().min(1).max(50) }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: '副本名称无效' });
  try {
    if (projects.hasRunningTask(request.params.id)) throw new Error('Codex 正在处理该项目，暂时禁止复制');
    return reply.code(201).send({ project: await projects.duplicateProject(request.params.id, parsed.data.name) });
  }
  catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '项目复制失败' }); }
});

app.put<{ Params: { id: string } }>('/api/projects/:id/model', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.object({ model: z.string().min(1).max(120), reasoningEffort: z.string().min(1).max(32).optional() }).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: '模型设置无效' });
  const model = (await availableModels()).find((item) => item.model === parsed.data.model || item.id === parsed.data.model);
  if (!model) return reply.code(400).send({ error: '该模型不在当前账户的可用列表中' });
  const effort = parsed.data.reasoningEffort ?? model.defaultReasoningEffort;
  if (!model.supportedReasoningEfforts.some((item) => item.reasoningEffort === effort)) return reply.code(400).send({ error: '该推理强度不受模型支持' });
  return { project: await projects.setProjectModel(request.params.id, model.model, effort) };
});

async function projectGitRoot(projectId: string): Promise<string | undefined> {
  const root = projects.projectWorkdir(projectId);
  for (const candidate of [root]) {
    if ((await stat(path.join(candidate, '.git')).catch(() => null))?.isDirectory()) return candidate;
  }
  return undefined;
}

async function git(projectId: string, args: string[], timeout = 60_000): Promise<string> {
  const cwd = await projectGitRoot(projectId);
  if (!cwd) throw new Error('当前项目还没有 Git 仓库');
  const { stdout, stderr } = await execFileAsync('/usr/bin/git', ['-C', cwd, ...args], { timeout, maxBuffer: 2 * 1024 * 1024 });
  return `${stdout}${stderr}`.trim();
}

app.get<{ Params: { id: string } }>('/api/projects/:id/git', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try {
    const root = await projectGitRoot(request.params.id);
    if (!root) return { repository: false, changes: [], diff: '' };
    const [branch, statusText, unstagedDiff, stagedDiff] = await Promise.all([
      git(request.params.id, ['branch', '--show-current']), git(request.params.id, ['status', '--porcelain=v1']),
      git(request.params.id, ['diff', '--no-ext-diff', '--unified=3']), git(request.params.id, ['diff', '--cached', '--no-ext-diff', '--unified=3']),
    ]);
    const changes = statusText.split('\n').filter(Boolean).map((line) => ({ status: line.slice(0, 2).trim() || '?', path: line.slice(3) }));
    const untracked = changes.filter((change) => change.status === '??').map((change) => change.path);
    return { projectId: request.params.id, repository: true, branch: branch || 'detached', changes, untracked, unstagedDiff: unstagedDiff.slice(0, 1_000_000), stagedDiff: stagedDiff.slice(0, 1_000_000) };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git 状态读取失败' }); }
});

app.post<{ Params: { id: string } }>('/api/projects/:id/git', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.discriminatedUnion('action', [
    z.object({ action: z.literal('pull') }), z.object({ action: z.literal('push') }),
    z.object({ action: z.literal('commit'), message: z.string().min(1).max(160) }),
    z.object({ action: z.literal('discard'), path: z.string().min(1).max(500) }),
  ]).safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: 'Git 操作参数无效' });
  try {
    const project = projects.getProject(request.params.id);
    if (project.archivedAt) throw new Error('项目已归档，请先恢复后再执行 Git 写操作');
    if (projects.hasRunningTask(request.params.id)) throw new Error('Codex 正在处理该项目，暂时禁止 Git 写操作');
    if (parsed.data.action === 'pull') return { ok: true, output: await git(request.params.id, ['pull', '--ff-only'], 120_000) };
    if (parsed.data.action === 'push') return { ok: true, output: await git(request.params.id, ['push'], 120_000) };
    if (parsed.data.action === 'commit') {
      await git(request.params.id, ['add', '--all']);
      return { ok: true, output: await git(request.params.id, ['commit', '-m', parsed.data.message], 120_000) };
    }
    if (path.isAbsolute(parsed.data.path) || parsed.data.path.split(/[\\/]/).includes('..')) throw new Error('文件路径无效');
    return { ok: true, output: await git(request.params.id, ['restore', '--worktree', '--', parsed.data.path]) };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : 'Git 操作失败' }); }
});

app.post('/api/projects/github', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const parsed = z.object({ name: z.string().min(1).max(50), url: z.string().url().max(500) }).safeParse(request.body);
  if (!parsed.success || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(parsed.data.url)) return reply.code(400).send({ error: '请输入有效的 GitHub HTTPS 仓库地址' });
  const project = await projects.createProject(parsed.data.name);
  try {
    const destination = path.join(projects.projectRoot(project.id), 'repository');
    await execFileAsync('/usr/bin/git', ['clone', '--depth=1', '--', parsed.data.url, destination], { timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
    return reply.code(201).send({ project: await projects.setProjectWorkdir(project.id, 'repository') });
  } catch (error) {
    await projects.deleteProject(project.id).catch(() => undefined);
    return reply.code(400).send({ error: error instanceof Error ? `Clone 失败，未保留空项目：${error.message}` : 'GitHub 导入失败' });
  }
});

async function listFiles(root: string, prefix: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.slice(0, 500)) {
    if (!entry.isFile() || entry.name.startsWith('.upload-')) continue;
    const fullPath = path.join(root, entry.name);
    const details = await stat(fullPath);
    const displayName = displayFileName(entry.name);
    files.push({ name: displayName || entry.name, path: `${prefix}/${entry.name}`, size: details.size, modifiedAt: details.mtime.toISOString() });
  }
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

function displayFileName(name: string): string {
  return name
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-/i, '')
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, '') || name;
}

function previewContentType(name: string): string | undefined {
  const extension = path.extname(name).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/plain; charset=utf-8',
    '.json': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  } as Record<string, string>)[extension];
}

app.get<{ Querystring: { projectId?: string } }>('/api/files', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const projectId = request.query.projectId ?? 'default';
  return { files: [...await listFiles(projects.inbox(projectId), 'inbox'), ...await listFiles(projects.outbox(projectId), 'outbox')] };
});

app.post<{ Querystring: { projectId?: string } }>('/api/files/upload', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  const projectId = request.query.projectId ?? 'default';
  if (projects.getProject(projectId).archivedAt) return reply.code(409).send({ error: '项目已归档，请先恢复后再上传' });
  const inbox = projects.inbox(projectId);
  const disk = await diskInfo();
  if (disk.tasksPaused) return reply.code(507).send({ error: '磁盘可用空间低于安全线，已暂停上传' });
  const file = await request.file();
  if (!file) return reply.code(400).send({ error: '没有收到文件' });
  const originalName = path.basename(file.filename).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 160) || 'upload.bin';
  const suppliedUploadId = request.headers['x-upload-id'];
  const uploadId = typeof suppliedUploadId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedUploadId)
    ? suppliedUploadId.toLowerCase()
    : randomUUID();
  const storedName = `${uploadId}-${originalName}`;
  const destination = path.join(inbox, storedName);
  const existing = await stat(destination).catch(() => null);
  if (existing?.isFile()) {
    file.file.resume();
    return { file: { name: originalName, storedName, path: `inbox/${storedName}`, size: existing.size } };
  }
  const temporary = `${destination}.part-${randomUUID()}`;
  try {
    await pipeline(file.file, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
    if (file.file.truncated) {
      await rm(temporary, { force: true });
      return reply.code(413).send({ error: '文件超过上传上限' });
    }
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  const details = await stat(destination);
  return { file: { name: originalName, storedName, path: `inbox/${storedName}`, size: details.size } };
});

const uploadSessionHeaders = z.object({
  uploadId: z.string().uuid(), fileName: z.string().min(1).max(200), totalSize: z.coerce.number().int().positive().max(config.maxUploadBytes),
});

function chunkSession(request: FastifyRequest, projectId: string) {
  const parsed = uploadSessionHeaders.safeParse({ uploadId: request.headers['x-upload-id'], fileName: request.headers['x-file-name'], totalSize: request.headers['x-file-size'] });
  if (!parsed.success) throw new Error('上传会话参数无效');
  const originalName = path.basename(decodeURIComponent(parsed.data.fileName)).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 160) || 'upload.bin';
  return { ...parsed.data, originalName, part: path.join(projects.inbox(projectId), `.upload-${parsed.data.uploadId}.part`) };
}

const UPLOAD_PART_TTL_MS = 24 * 60 * 60 * 1000;
async function cleanupExpiredUploadParts(): Promise<number> {
  let removed = 0;
  const cutoff = Date.now() - UPLOAD_PART_TTL_MS;
  for (const project of projects.listProjects()) {
    const entries = await readdir(projects.inbox(project.id), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !/^\.upload-[0-9a-f-]{36}\.part$/i.test(entry.name)) continue;
      const target = path.join(projects.inbox(project.id), entry.name);
      const details = await stat(target).catch(() => null);
      if (details && details.mtimeMs < cutoff) { await rm(target, { force: true }); removed += 1; }
    }
  }
  return removed;
}
await cleanupExpiredUploadParts();

async function uploadAllowed(reply: FastifyReply): Promise<boolean> {
  if (!(await diskInfo()).tasksPaused) return true;
  await reply.code(507).send({ error: '磁盘可用空间低于安全线，已暂停上传' });
  return false;
}

app.get<{ Querystring: { projectId?: string } }>('/api/files/upload-session', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try {
    if (!await uploadAllowed(reply)) return;
    await cleanupExpiredUploadParts();
    const projectId = request.query.projectId ?? 'default';
    if (projects.getProject(projectId).archivedAt) return reply.code(409).send({ error: '项目已归档，请先恢复后再上传' });
    const session = chunkSession(request, projectId);
    const details = await stat(session.part).catch(() => null);
    return { uploaded: details?.size ?? 0, totalSize: session.totalSize };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '上传会话无效' }); }
});

app.put<{ Querystring: { projectId?: string }; Body: Buffer }>('/api/files/upload-chunk', { bodyLimit: 9 * 1024 * 1024 }, async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try {
    if (!await uploadAllowed(reply)) return;
    const projectId = request.query.projectId ?? 'default';
    if (projects.getProject(projectId).archivedAt) return reply.code(409).send({ error: '项目已归档，请先恢复后再上传' });
    const session = chunkSession(request, projectId);
    const offset = Number(request.headers['x-upload-offset']);
    const body = request.body;
    if (!Buffer.isBuffer(body) || !Number.isSafeInteger(offset) || offset < 0 || body.length > 8 * 1024 * 1024) throw new Error('分片参数无效');
    const current = (await stat(session.part).catch(() => null))?.size ?? 0;
    if (current !== offset) return reply.code(409).send({ error: '上传位置已变化', uploaded: current });
    if (current + body.length > session.totalSize) throw new Error('分片超过文件大小');
    await appendFile(session.part, body, { mode: 0o600 });
    return { uploaded: current + body.length, totalSize: session.totalSize };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '分片上传失败' }); }
});

app.post<{ Querystring: { projectId?: string } }>('/api/files/upload-complete', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try {
    if (!await uploadAllowed(reply)) return;
    const projectId = request.query.projectId ?? 'default';
    const session = chunkSession(request, projectId);
    const details = await stat(session.part);
    if (details.size !== session.totalSize) return reply.code(409).send({ error: '文件尚未上传完整', uploaded: details.size });
    const storedName = `${session.uploadId}-${session.originalName}`;
    const destination = path.join(projects.inbox(projectId), storedName);
    await rename(session.part, destination);
    return { file: { name: session.originalName, storedName, path: `inbox/${storedName}`, size: details.size } };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '完成上传失败' }); }
});

app.delete<{ Querystring: { projectId?: string } }>('/api/files/upload-session', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  try {
    const session = chunkSession(request, request.query.projectId ?? 'default');
    await rm(session.part, { force: true });
    return { ok: true };
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : '上传会话无效' }); }
});

app.get<{ Querystring: { path?: string; projectId?: string } }>('/api/files/download', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  if (!request.query.path) return reply.code(400).send({ error: '缺少文件路径' });
  try {
    const filePath = projects.safeStoredPath(request.query.projectId ?? 'default', request.query.path);
    const details = await stat(filePath);
    if (!details.isFile()) return reply.code(404).send({ error: '文件不存在' });
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayFileName(path.basename(filePath)))}`);
    reply.header('X-Content-Type-Options', 'nosniff');
    return reply.send(createReadStream(filePath));
  } catch {
    return reply.code(404).send({ error: '文件不存在' });
  }
});

app.get<{ Querystring: { path?: string; projectId?: string } }>('/api/files/preview', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  if (!request.query.path) return reply.code(400).send({ error: '缺少文件路径' });
  try {
    const filePath = projects.safeStoredPath(request.query.projectId ?? 'default', request.query.path);
    const details = await stat(filePath);
    const contentType = previewContentType(filePath);
    if (!details.isFile() || !contentType) return reply.code(415).send({ error: '该文件类型暂不支持在线预览' });
    reply.header('Content-Type', contentType);
    reply.header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(displayFileName(path.basename(filePath)))}`);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'");
    return reply.send(createReadStream(filePath));
  } catch {
    return reply.code(404).send({ error: '文件不存在' });
  }
});

app.delete<{ Querystring: { path?: string; projectId?: string } }>('/api/files', async (request, reply) => {
  if (!requireOwner(request, reply)) return;
  if (!request.query.path) return reply.code(400).send({ error: '缺少文件路径' });
  try {
    if (projects.getProject(request.query.projectId ?? 'default').archivedAt) return reply.code(409).send({ error: '项目已归档，请先恢复后再删除文件' });
    const filePath = projects.safeStoredPath(request.query.projectId ?? 'default', request.query.path);
    const details = await stat(filePath);
    if (!details.isFile()) throw new Error('不是文件');
    await rm(filePath);
    return { ok: true };
  } catch {
    return reply.code(404).send({ error: '文件不存在' });
  }
});

const clientMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal('turn.start'), clientRequestId: z.string().uuid().optional(), projectId: z.string().min(1).max(64), threadId: z.string().optional(), text: z.string().min(1).max(50_000), attachments: z.array(z.string()).max(10).optional() }),
  z.object({ type: z.literal('turn.interrupt'), threadId: z.string(), turnId: z.string() }),
  z.object({ type: z.literal('thread.subscribe'), projectId: z.string().min(1).max(64), threadId: z.string() }),
]);

app.get('/api/ws', { websocket: true }, (socket, request) => {
  if (!originAllowed(request) || !authenticated(request)) {
    socket.close(1008, 'unauthorized');
    return;
  }
  sockets.add(socket);
  socket.send(JSON.stringify({ type: 'ready' }));

  socket.on('message', async (raw) => {
    let clientRequestId: string | undefined;
    try {
      const parsed = clientMessage.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) throw new Error('消息格式无效');
      const message = parsed.data;
      clientRequestId = message.type === 'turn.start' ? message.clientRequestId : undefined;
      app.log.info({ event: message.type }, '收到已认证的 WebSocket 操作');
      if (message.type === 'thread.subscribe') {
        projects.assertThreadProject(message.threadId, message.projectId);
        setSocketThread(socket, message.threadId);
        return;
      }
      await bridge.ready();
      app.log.info({ event: message.type }, 'Codex App Server 已就绪');
      if (message.type === 'turn.interrupt') {
        await bridge.call('turn/interrupt', { threadId: message.threadId, turnId: message.turnId });
        return;
      }
      const requestId = message.clientRequestId ?? randomUUID();
      clientRequestId = requestId;
      const requestKey = `${message.projectId}:${requestId}`;
      const completedRequest = projects.findTaskByClientRequestId(message.projectId, requestId);
      if (completedRequest) {
        setSocketThread(socket, completedRequest.threadId);
        socket.send(JSON.stringify({
          type: 'turn.accepted', clientRequestId: requestId, replayed: true,
          threadId: completedRequest.threadId, payload: { turn: { id: completedRequest.turnId } },
        }));
        return;
      }
      const pendingRequest = pendingTurnRequests.get(requestKey);
      if (pendingRequest) {
        const accepted = await pendingRequest;
        if (!accepted) throw new Error('原请求执行失败，请检查任务记录后再试');
        setSocketThread(socket, accepted.threadId);
        socket.send(JSON.stringify({ type: 'turn.accepted', ...accepted, replayed: true }));
        return;
      }
      let settlePending!: (value: TurnAcceptance | undefined) => void;
      pendingTurnRequests.set(requestKey, new Promise<TurnAcceptance | undefined>((resolve) => { settlePending = resolve; }));
      try {
      const disk = await diskInfo();
      if (disk.tasksPaused) throw new Error('磁盘可用空间低于安全线，已暂停新任务');
      let threadId = message.threadId;
      const projectRoot = projects.projectWorkdir(message.projectId);
      const project = projects.getProject(message.projectId);
      if (project.archivedAt) throw new Error('项目已归档，请先恢复后再执行任务');
      if (!threadId) {
        const started = await bridge.call('thread/start', {
          cwd: projectRoot, model: project.model, config: project.reasoningEffort ? { model_reasoning_effort: project.reasoningEffort } : undefined,
          developerInstructions: OUTPUT_INSTRUCTIONS,
          approvalPolicy: 'never', sandbox: 'danger-full-access', serviceName: 'palm_secretary',
        }) as { thread?: { id?: string } };
        threadId = started.thread?.id;
        app.log.info({ event: 'thread.started', ok: Boolean(threadId) }, 'Codex 对话创建完成');
      } else {
        projects.assertThreadProject(threadId, message.projectId);
        if (!loadedThreads.has(threadId)) {
          await bridge.call('thread/resume', { threadId, cwd: projectRoot, developerInstructions: OUTPUT_INSTRUCTIONS, approvalPolicy: 'never', sandbox: 'danger-full-access' });
        }
      }
      if (!threadId) throw new Error('无法创建 Codex 对话');
      setSocketThread(socket, threadId);
      loadedThreads.add(threadId);
      await projects.rememberThread(threadId, message.projectId, message.text);
      const attachmentPaths = (message.attachments ?? []).map((value) => projects.safeStoredPath(message.projectId, value));
      const attachmentDetails = await Promise.all(attachmentPaths.map(async (filePath) => ({ filePath, details: await stat(filePath) })));
      const attachmentNote = attachmentDetails.length
        ? `\n\n【本次附件】这些文件已经真实保存在当前项目工作区。请务必先用文件工具读取，再执行用户任务；不要只回复“上传成功”。\n${attachmentDetails.map(({ filePath, details }) => `- ${filePath}（${details.size} 字节）`).join('\n')}`
        : '';
      const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
      const input: Array<Record<string, unknown>> = [{ type: 'text', text: `${message.text}${attachmentNote}` }];
      for (const { filePath } of attachmentDetails) {
        if (imageExtensions.has(path.extname(filePath).toLowerCase())) input.push({ type: 'localImage', path: filePath, detail: 'auto' });
      }
      const outputBaseline = await projects.outputBaseline(message.projectId);
      const turn = await bridge.call('turn/start', {
        threadId,
        input,
        cwd: projectRoot,
        model: project.model,
        effort: project.reasoningEffort,
        approvalPolicy: 'never',
        sandboxPolicy: { type: 'dangerFullAccess' },
      }) as { turn?: { id?: string } };
      if (turn.turn?.id) await projects.rememberTask(turn.turn.id, threadId, message.projectId, message.text, message.attachments ?? [], outputBaseline, requestId);
      const accepted: TurnAcceptance = { threadId, payload: turn, clientRequestId: requestId };
      settlePending(accepted);
      socket.send(JSON.stringify({ type: 'turn.accepted', ...accepted }));
      } catch (error) {
        settlePending(undefined);
        throw error;
      } finally {
        pendingTurnRequests.delete(requestKey);
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', clientRequestId, message: error instanceof Error ? error.message : '任务执行失败' }));
    }
  });
  socket.on('close', () => {
    sockets.delete(socket);
    detachSocketFromThread(socket);
  });
});

const shutdown = async () => {
  await bridge.close();
  await app.close();
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await app.listen({ host: config.host, port: config.port });
app.log.info({ event: 'sudo.self-test', ...(await sudoInfo()) }, 'Codex sudo 权限自检');
