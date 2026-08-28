'use client';

import { DragEvent, FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from 'react';

type ChatMessage = { id: string; role: 'user' | 'assistant'; text: string; pending?: boolean; attachments?: UploadedFile[] };
type UploadedFile = { name: string; path: string; size?: number; modifiedAt?: string };
type Project = { id: string; name: string; createdAt: string; updatedAt: string; model?: string; reasoningEffort?: string };
type ProjectThread = { threadId: string; title: string; updatedAt: string };
type ProjectTask = { taskId: string; turnId: string; threadId: string; projectId: string; title: string; status: 'running' | 'completed' | 'failed' | 'interrupted'; startedAt: string; updatedAt: string; completedAt?: string; attachments: string[]; outputPaths: string[]; errorMessage?: string };
type CodexModel = { id: string; model: string; displayName: string; description: string; isDefault: boolean; defaultReasoningEffort: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }> };
type ServerStatus = { disk?: { freeBytes: number; usedPercent: number; warning: boolean; tasksPaused: boolean }; sudo?: { available: boolean } };
type View = 'chat' | 'history' | 'files';
type UploadResponse = { status: number; body?: { file?: UploadedFile; error?: string } };
type UploadFeedback = { uploadId: string; file: File; progress: number; status: 'uploading' | 'retrying' | 'success' | 'error'; message?: string; retryable: boolean };
type UsageWindow = { id: string; label: string; usedPercent: number; remainingPercent: number; resetAt?: number; windowMinutes?: number };
type NativeSharedFile = { id: string; name: string; mimeType?: string; size?: number };
type PendingTurn = { clientRequestId: string; projectId: string; threadId?: string; text: string; attachments: UploadedFile[] };
type DeliveryState = 'idle' | 'sending' | 'accepted';

declare global {
  interface Window {
    __PALM_SHARED_FILES__?: NativeSharedFile[];
  }
}

const starterTasks = ['整理当前项目的文件', '把这份 PDF 提炼成要点', '检查服务器运行状态'];
const SAFE_UPLOAD_BYTES = 95 * 1024 ** 2;

function usageWindowsFrom(value: unknown): UsageWindow[] {
  const candidates: Array<{ path: string; value: Record<string, unknown> }> = [];
  const visited = new Set<object>();
  const walk = (node: unknown, currentPath = 'rateLimits') => {
    if (!node || typeof node !== 'object' || visited.has(node as object)) return;
    visited.add(node as object);
    const record = node as Record<string, unknown>;
    if (typeof record.usedPercent === 'number') candidates.push({ path: currentPath, value: record });
    for (const [key, child] of Object.entries(record)) walk(child, `${currentPath}.${key}`);
  };
  walk(value);
  const windows = candidates.map(({ path, value }, index) => {
    const minutes = [value.windowDurationMins, value.windowDurationMinutes, value.windowMinutes, value.limitWindowMinutes]
      .find((item) => typeof item === 'number') as number | undefined;
    const resetRaw = [value.resetsAt, value.resetAt, value.resetAtMs].find((item) => typeof item === 'number') as number | undefined;
    const key = path.split('.').at(-1)?.toLowerCase() ?? '';
    const label = minutes && minutes <= 360 ? '5 小时' : minutes && minutes >= 6 * 24 * 60 ? '每周' : key.includes('primary') ? '5 小时' : key.includes('secondary') ? '每周' : `窗口 ${index + 1}`;
    const usedPercent = Math.max(0, Math.min(100, Number(value.usedPercent)));
    return { id: `${path}-${minutes ?? index}`, label, usedPercent, remainingPercent: Math.max(0, Math.round(100 - usedPercent)), resetAt: resetRaw ? (resetRaw < 10_000_000_000 ? resetRaw * 1000 : resetRaw) : undefined, windowMinutes: minutes };
  });
  return windows.filter((window, index) => windows.findIndex((item) => item.label === window.label) === index)
    .sort((a, b) => (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) - (b.windowMinutes ?? Number.MAX_SAFE_INTEGER));
}

function resetLabel(resetAt?: number): string {
  if (!resetAt) return '重置时间待同步';
  const remainingMs = resetAt - Date.now();
  if (remainingMs <= 0) return '即将重置';
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.ceil((remainingMs % 3_600_000) / 60_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
  return `${hours ? `${hours} 小时 ` : ''}${minutes} 分钟后重置`;
}

function uploadOnce(file: File, url: string, uploadId: string, onProgress: (percent: number) => void): Promise<UploadResponse> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open('POST', url);
    request.withCredentials = true;
    request.timeout = 15 * 60_000;
    request.setRequestHeader('X-Upload-Id', uploadId);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
    };
    request.onload = () => {
      let body: UploadResponse['body'];
      try { body = JSON.parse(request.responseText) as UploadResponse['body']; } catch { body = undefined; }
      resolve({ status: request.status, body });
    };
    request.onerror = () => resolve({ status: 0 });
    request.ontimeout = () => resolve({ status: 408 });
    request.onabort = () => resolve({ status: 0 });
    const form = new FormData();
    form.append('file', file);
    request.send(form);
  });
}

function uploadErrorMessage(result: UploadResponse): string {
  if (result.body?.error) return result.body.error;
  if (result.status === 0) return '网络连接中断，请检查网络后重试';
  if (result.status === 401) return '登录已过期，请重新进入工作台';
  if (result.status === 413) return '文件过大，公网上传请控制在 95MB 以内';
  if (result.status === 429) return '上传过于频繁，请稍后重试';
  if (result.status === 507) return '服务器可用空间不足，已暂停上传';
  if (result.status >= 500) return '服务器暂时无法保存文件，请稍后重试';
  return `文件上传失败（HTTP ${result.status || '网络错误'}）`;
}

function bytes(value?: number) {
  if (value === undefined) return '暂无';
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function fileMark(name: string): string {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(extension)) return '图';
  if (['pdf'].includes(extension)) return 'PDF';
  if (['doc', 'docx', 'txt', 'md', 'rtf'].includes(extension)) return '文';
  if (['xls', 'xlsx', 'csv'].includes(extension)) return '表';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)) return '包';
  return '档';
}

function canPreview(name: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf', 'txt', 'md', 'csv', 'json', 'log'].includes(name.split('.').pop()?.toLowerCase() ?? '');
}

function isImageFile(name: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(name.split('.').pop()?.toLowerCase() ?? '');
}

function safeServerFilePath(value: string): string | undefined {
  const cleaned = value.trim().replace(/^<|>$/g, '').replaceAll('\\', '/').split(/[?#]/, 1)[0];
  let normalized = cleaned.replace(/^\.\//, '');
  const stored = normalized.match(/(?:^|\/)(inbox|outbox)\/(.+)$/i);
  if (stored) normalized = `${stored[1].toLowerCase()}/${stored[2]}`;
  if (!/^(inbox|outbox)\/.+/i.test(normalized) || normalized.split('/').includes('..') || !isImageFile(normalized)) return undefined;
  return normalized;
}

function fileUrl(projectId: string, path: string, action: 'preview' | 'download' = 'preview'): string {
  return `/api/files/${action}?${new URLSearchParams({ projectId, path })}`;
}

function displayFileName(name: string): string {
  return name
    .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-/i, '')
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i, '') || name;
}

function parseUserMessage(text: string): { text: string; attachments: UploadedFile[] } {
  const marker = '\n\n【本次附件】';
  const markerAt = text.indexOf(marker);
  if (markerAt < 0) return { text, attachments: [] };
  const attachments = text.slice(markerAt + marker.length).split('\n').flatMap((line) => {
    const match = line.match(/^- (.+?)（(\d+) 字节）$/);
    if (!match) return [];
    const normalized = match[1].replaceAll('\\', '/');
    const stored = normalized.match(/\/(inbox|outbox)\/(.+)$/);
    if (!stored) return [];
    return [{ name: displayFileName(stored[2]), path: `${stored[1]}/${stored[2]}`, size: Number(match[2]) }];
  });
  return { text: text.slice(0, markerAt), attachments };
}

function inlineContent(text: string): ReactNode[] {
  return text.split(/(`[^`\n]+`|https?:\/\/[^\s]+)/g).filter(Boolean).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    if (/^https?:\/\//.test(part)) return <a key={index} href={part} target="_blank" rel="noreferrer">{part}</a>;
    return part;
  });
}

function ServerImage({ path, name, projectId }: { path: string; name: string; projectId: string }) {
  const previewUrl = fileUrl(projectId, path);
  return <figure className="inline-server-image">
    <a href={previewUrl} target="_blank" rel="noreferrer" aria-label={`打开图片 ${name}`}>
      <img src={previewUrl} alt={name} loading="lazy" />
    </a>
    <figcaption><span>{name}</span><a href={fileUrl(projectId, path, 'download')}>下载原图</a></figcaption>
  </figure>;
}

function MessageContent({ text, projectId, files }: { text: string; projectId: string; files: UploadedFile[] }) {
  const nodes: ReactNode[] = [];
  const renderedPaths = new Set<string>();
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let code: string[] | null = null;
  let codeLanguage = '';
  lines.forEach((line, index) => {
    if (line.startsWith('```')) {
      if (code) {
        nodes.push(<pre key={`code-${index}`}><code data-language={codeLanguage}>{code.join('\n')}</code></pre>);
        code = null; codeLanguage = '';
      } else { code = []; codeLanguage = line.slice(3).trim(); }
      return;
    }
    if (code) { code.push(line); return; }
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (image) {
      const path = safeServerFilePath(image[2]);
      if (path) {
        renderedPaths.add(path);
        nodes.push(<ServerImage key={`image-${index}`} path={path} name={image[1].trim() || displayFileName(path.split('/').pop() ?? path)} projectId={projectId} />);
      } else nodes.push(<p key={index}>{inlineContent(line)}</p>);
    } else if (heading) {
      const Tag = `h${heading[1].length + 2}` as 'h3' | 'h4' | 'h5';
      nodes.push(<Tag key={index}>{inlineContent(heading[2])}</Tag>);
    } else if (unordered || ordered) {
      nodes.push(<div className="rich-list-item" key={index}><b>{ordered ? `${line.match(/^\d+/)?.[0]}.` : '•'}</b><span>{inlineContent((unordered ?? ordered)?.[1] ?? '')}</span></div>);
    } else if (!line.trim()) nodes.push(<span className="rich-spacer" key={index} />);
    else nodes.push(<p key={index}>{inlineContent(line)}</p>);
  });
  if (code) nodes.push(<pre key="code-final"><code data-language={codeLanguage}>{code.join('\n')}</code></pre>);
  files.filter((file) => isImageFile(file.name) && !renderedPaths.has(file.path) && (text.includes(file.path) || text.includes(file.name)))
    .forEach((file) => nodes.push(<ServerImage key={`mentioned-${file.path}`} path={file.path} name={file.name} projectId={projectId} />));
  return <div className="rich-message">{nodes}</div>;
}

function taskDuration(task: ProjectTask): string {
  const start = new Date(task.startedAt).getTime();
  const end = new Date(task.completedAt ?? task.updatedAt).getTime();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes} 分 ${seconds % 60} 秒` : `${minutes} 分钟`;
}

function UploadCard({ item, onRetry, onDismiss }: { item: UploadFeedback; onRetry: () => void; onDismiss: () => void }) {
  const active = item.status === 'uploading' || item.status === 'retrying';
  const status = item.status === 'retrying' ? '网络波动，正在重试…' : item.status === 'uploading' ? `正在上传 · ${item.progress}%` : item.status === 'success' ? '上传成功，已添加到对话' : item.message ?? '上传失败';
  return <article className={`attachment-card upload-card ${item.status}`} role="status" aria-live="polite">
    <span className="attachment-icon">{fileMark(item.file.name)}</span>
    <div className="attachment-copy"><strong title={item.file.name}>{item.file.name}</strong><span>{status} · {bytes(item.file.size)}</span>{active && <span className="upload-track" aria-hidden="true"><i style={{ width: `${item.progress}%` }} /></span>}</div>
    {item.status === 'error' ? <div className="upload-actions">{item.retryable && <button type="button" onClick={onRetry}>重试</button>}<button type="button" aria-label="关闭上传提示" onClick={onDismiss}>×</button></div> : item.status === 'success' ? <button type="button" className="upload-success" aria-label="关闭上传成功提示" onClick={onDismiss}>✓</button> : <span className="upload-spinner" aria-hidden="true" />}
  </article>;
}

function AttachedFileCard({ file, onRemove }: { file: UploadedFile; onRemove: () => void }) {
  return <article className="attachment-card attached-card">
    <span className="attachment-icon">{fileMark(file.name)}</span>
    <div className="attachment-copy"><strong title={file.name}>{file.name}</strong><span><b>✓ 已上传</b> · {bytes(file.size)} · 发送时自动附带</span></div>
    <button type="button" className="attachment-remove" aria-label={`移除附件 ${file.name}`} onClick={onRemove}>×</button>
  </article>;
}

function SentFileCard({ file, projectId }: { file: UploadedFile; projectId: string }) {
  const query = new URLSearchParams({ projectId, path: file.path });
  const preview = canPreview(file.name);
  return <article className="message-file-card">
    <a className="message-file-main" href={`/api/files/${preview ? 'preview' : 'download'}?${query}`} target={preview ? '_blank' : undefined} rel={preview ? 'noreferrer' : undefined}>
      <span className="attachment-icon">{fileMark(file.name)}</span>
      <span><strong title={file.name}>{file.name}</strong><small>{bytes(file.size)} · {preview ? '点击预览' : '点击下载'}</small></span>
    </a>
    <a className="message-file-download" href={`/api/files/download?${query}`} aria-label={`下载 ${file.name}`}>↓</a>
  </article>;
}

function effortLabel(value: string) {
  return ({ none: '极速', low: '较低', medium: '标准', high: '深入', xhigh: '很深入', max: '最大' } as Record<string, string>)[value] ?? value;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((item) => {
    if (!item || typeof item !== 'object') return '';
    const record = item as Record<string, unknown>;
    return String(record.text ?? record.inputText ?? record.outputText ?? '');
  }).filter(Boolean).join('\n');
}

function messagesFromThread(value: unknown): ChatMessage[] {
  const root = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const thread = (root.thread && typeof root.thread === 'object' ? root.thread : root) as Record<string, unknown>;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const result: ChatMessage[] = [];
  for (const turn of turns) {
    const items = turn && typeof turn === 'object' && Array.isArray((turn as Record<string, unknown>).items) ? (turn as Record<string, unknown>).items as unknown[] : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? '');
      const text = String(record.text ?? record.message ?? '') || textFromContent(record.content);
      if (!text) continue;
      if (type === 'userMessage') {
        const parsed = parseUserMessage(text);
        result.push({ id: crypto.randomUUID(), role: 'user', text: parsed.text, attachments: parsed.attachments });
      }
      if (type === 'agentMessage') result.push({ id: crypto.randomUUID(), role: 'assistant', text });
    }
  }
  return result;
}

export default function Home() {
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [view, setView] = useState<View>('chat');
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [projectId, setProjectId] = useState('default');
  const [threads, setThreads] = useState<ProjectThread[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [recordSearch, setRecordSearch] = useState('');
  const [fileSearch, setFileSearch] = useState('');
  const [fileKind, setFileKind] = useState<'all' | 'inbox' | 'outbox'>('all');
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [status, setStatus] = useState<ServerStatus>({});
  const [usageWindows, setUsageWindows] = useState<UsageWindow[]>([]);
  const [usageOpen, setUsageOpen] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [threadId, setThreadId] = useState<string>();
  const [turnId, setTurnId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [deliveryState, setDeliveryState] = useState<DeliveryState>('idle');
  const [connection, setConnection] = useState<'连接中' | '已连接' | '正在重连'>('连接中');
  const [notice, setNotice] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadFeedbacks, setUploadFeedbacks] = useState<UploadFeedback[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const threadIdRef = useRef<string>();
  const projectIdRef = useRef(projectId);
  const runningRef = useRef(false);
  const pendingTurnRef = useRef<PendingTurn>();
  const reconnectRef = useRef<number>();
  const reconnectNowRef = useRef<() => void>(() => undefined);
  const fileRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((project) => project.id === projectId);
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const activeModel = models.find((model) => model.model === activeProject?.model) ?? defaultModel;
  const activeEffort = activeProject?.reasoningEffort ?? activeModel?.defaultReasoningEffort ?? '';
  const recentOutputs = files.filter((file) => file.path.startsWith('outbox/')).slice(0, 3);
  const matchingTasks = tasks.filter((task) => task.title.toLowerCase().includes(recordSearch.trim().toLowerCase()));
  const matchingThreads = threads.filter((thread) => thread.title.toLowerCase().includes(recordSearch.trim().toLowerCase()));
  const visibleThreads = recordSearch.trim() ? matchingThreads : matchingThreads.slice(0, 3);
  const matchingFiles = files.filter((file) => (fileKind === 'all' || file.path.startsWith(`${fileKind}/`)) && file.name.toLowerCase().includes(fileSearch.trim().toLowerCase()));

  useEffect(() => { threadIdRef.current = threadId; }, [threadId]);
  useEffect(() => { projectIdRef.current = projectId; }, [projectId]);
  useEffect(() => { runningRef.current = running; }, [running]);
  useEffect(() => {
    if (view !== 'chat' || !focusedMessageId) return;
    let clearTimer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focusedMessageId)}"]`);
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target) clearTimer = window.setTimeout(() => setFocusedMessageId(undefined), 2400);
    });
    return () => { window.cancelAnimationFrame(frame); if (clearTimer) window.clearTimeout(clearTimer); };
  }, [focusedMessageId, messages, view]);

  const loadDashboard = useCallback(async () => {
    const [statusResponse, usageResponse] = await Promise.allSettled([
      fetch('/api/status').then((response) => response.ok ? response.json() : Promise.reject()),
      fetch('/api/usage').then((response) => response.ok ? response.json() : Promise.reject()),
    ]);
    if (statusResponse.status === 'fulfilled') setStatus(statusResponse.value as ServerStatus);
    if (usageResponse.status === 'fulfilled') {
      const value = usageResponse.value as { rateLimits?: unknown; usage?: unknown };
      setUsageWindows(usageWindowsFrom(value.rateLimits ?? value.usage));
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const response = await fetch('/api/projects');
    if (!response.ok) return;
    const body = await response.json() as { projects: Project[] };
    setProjects(body.projects);
    if (!body.projects.some((project) => project.id === projectId)) setProjectId(body.projects[0]?.id ?? 'default');
  }, [projectId]);

  const loadModels = useCallback(async (refresh = false) => {
    const response = await fetch(`/api/models${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) { setNotice('模型列表暂时不可用，请稍后刷新'); return; }
    setModels(((await response.json()) as { models: CodexModel[] }).models);
  }, []);

  const loadProjectData = useCallback(async (id: string): Promise<ProjectTask[]> => {
    const encoded = encodeURIComponent(id);
    const [threadResponse, taskResponse, fileResponse] = await Promise.all([
      fetch(`/api/threads?projectId=${encoded}`), fetch(`/api/tasks?projectId=${encoded}`), fetch(`/api/files?projectId=${encoded}`),
    ]);
    if (threadResponse.ok) setThreads(((await threadResponse.json()) as { threads: ProjectThread[] }).threads);
    let loadedTasks: ProjectTask[] = [];
    if (taskResponse.ok) {
      loadedTasks = ((await taskResponse.json()) as { tasks: ProjectTask[] }).tasks;
      setTasks(loadedTasks);
      const activeTask = loadedTasks.find((task) => task.threadId === threadIdRef.current && task.status === 'running');
      if (activeTask) { runningRef.current = true; setRunning(true); setTurnId(activeTask.turnId); }
      else if (threadIdRef.current) { runningRef.current = false; setRunning(false); setTurnId(undefined); }
    }
    if (fileResponse.ok) setFiles(((await fileResponse.json()) as { files: UploadedFile[] }).files);
    return loadedTasks;
  }, []);

  const refreshThreadMessages = useCallback(async (targetThreadId: string, targetProjectId: string, force = false, taskRunning = runningRef.current) => {
    const response = await fetch(`/api/threads/${encodeURIComponent(targetThreadId)}?projectId=${encodeURIComponent(targetProjectId)}`).catch(() => null);
    if (!response?.ok) return false;
    const restored = messagesFromThread(await response.json());
    if (!restored.length || threadIdRef.current !== targetThreadId || projectIdRef.current !== targetProjectId) return false;
    const synced = taskRunning
      ? restored.some((item) => item.role === 'assistant')
        ? restored.map((item, index) => index === restored.length - 1 && item.role === 'assistant' ? { ...item, pending: true } : item)
        : [...restored, { id: crypto.randomUUID(), role: 'assistant' as const, text: '', pending: true }]
      : restored;
    setMessages((current) => (!force && (runningRef.current || current.some((item) => item.pending))) ? current : synced);
    return true;
  }, []);

  useEffect(() => {
    fetch('/api/session').then((response) => response.json()).then((data: { authenticated?: boolean }) => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setNotice('暂时无法连接服务器')).finally(() => setBooting(false));
    if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setTimeout(() => { void loadDashboard(); void loadProjects(); void loadModels(); }, 0);
    return () => window.clearTimeout(timer);
  }, [authenticated, loadDashboard, loadModels, loadProjects]);

  useEffect(() => {
    if (!authenticated || !projectId) return;
    const timer = window.setTimeout(() => {
      void loadProjectData(projectId);
      setDraft(window.localStorage.getItem(`palm:draft:${projectId}`) ?? '');
      runningRef.current = false;
      setThreadId(undefined); setMessages([]); setAttachments([]); setUploadFeedbacks([]); setRunning(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [authenticated, projectId, loadProjectData]);

  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    const connect = () => {
      setConnection(socketRef.current ? '正在重连' : '连接中');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socketHost = location.hostname === 'localhost' && location.port === '3000' ? `${location.hostname}:4511` : location.host;
      const socket = new WebSocket(`${protocol}//${socketHost}/api/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        setConnection('已连接');
        if (threadIdRef.current) {
          socket.send(JSON.stringify({ type: 'thread.subscribe', projectId, threadId: threadIdRef.current }));
          void refreshThreadMessages(threadIdRef.current, projectId);
        }
        const storedPending = window.localStorage.getItem(`palm:pending-turn:${projectId}`);
        if (storedPending) {
          try {
            const pending = JSON.parse(storedPending) as PendingTurn;
            if (pending.projectId === projectId && pending.clientRequestId) {
              pendingTurnRef.current = pending;
              setDeliveryState('sending');
              socket.send(JSON.stringify({
                type: 'turn.start', clientRequestId: pending.clientRequestId, projectId: pending.projectId,
                threadId: pending.threadId, text: pending.text, attachments: pending.attachments.map((file) => file.path),
              }));
            }
          } catch { window.localStorage.removeItem(`palm:pending-turn:${projectId}`); }
        }
        void loadProjectData(projectId);
      };
      reconnectNowRef.current = () => {
        if (disposed || socketRef.current?.readyState === WebSocket.OPEN || socketRef.current?.readyState === WebSocket.CONNECTING) return;
        if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
        connect();
      };
      socket.onclose = () => { if (!disposed) { setConnection('正在重连'); reconnectRef.current = window.setTimeout(connect, 1800); } };
      socket.onmessage = (event) => {
        let message: { type: string; threadId?: string; message?: string; clientRequestId?: string; replayed?: boolean; payload?: Record<string, unknown> };
        try { message = JSON.parse(event.data) as typeof message; }
        catch { setNotice('收到无法识别的服务器消息'); return; }
        if (message.type === 'turn.accepted') {
          const pending = pendingTurnRef.current;
          if (pending && (!message.clientRequestId || message.clientRequestId === pending.clientRequestId)) {
            window.localStorage.removeItem(`palm:pending-turn:${pending.projectId}`);
            pendingTurnRef.current = undefined;
          }
          setDeliveryState('accepted');
          setThreadId(message.threadId);
          const turn = (message.payload?.turn ?? {}) as { id?: string };
          if (turn.id) setTurnId(turn.id);
          void loadProjectData(projectId);
          return;
        }
        if (message.type === 'error') {
          const pending = pendingTurnRef.current;
          if (pending && (!message.clientRequestId || message.clientRequestId === pending.clientRequestId)) {
            window.localStorage.removeItem(`palm:pending-turn:${pending.projectId}`);
            pendingTurnRef.current = undefined;
          }
          setDeliveryState('idle');
          runningRef.current = false; setRunning(false); setNotice(message.message ?? '任务执行失败');
          setMessages((items) => items.map((item) => item.pending ? { ...item, pending: false, text: item.text || '任务未能完成。' } : item));
          return;
        }
        if (message.type === 'codex.offline') {
          runningRef.current = false; setConnection('正在重连'); setRunning(false); setNotice('Codex 服务正在恢复连接');
          return;
        }
        if (message.type !== 'codex.event' || !message.payload) return;
        const rpc = message.payload as { method?: string; params?: Record<string, unknown> };
        if (rpc.method === 'item/agentMessage/delta') {
          const delta = String(rpc.params?.delta ?? '');
          setMessages((items) => {
            let updated = false;
            const next = items.map((item) => {
              if (!item.pending) return item;
              updated = true;
              return { ...item, text: item.text + delta };
            });
            return updated ? next : [...items, { id: crypto.randomUUID(), role: 'assistant', text: delta, pending: true }];
          });
        }
        if (['turn/completed', 'turn/failed', 'turn/interrupted'].includes(String(rpc.method))) {
          setDeliveryState('idle');
          runningRef.current = false; setRunning(false); setTurnId(undefined);
          const terminalText = rpc.method === 'turn/interrupted' ? '任务已停止。' : rpc.method === 'turn/failed' ? '任务执行失败，请在记录中重试。' : '';
          setMessages((items) => items.map((item) => item.pending ? { ...item, pending: false, text: item.text || terminalText } : item));
          if (terminalText) setNotice(terminalText);
          void loadDashboard(); void loadProjectData(projectId);
          const completedThreadId = threadIdRef.current;
          if (completedThreadId) {
            window.setTimeout(() => void refreshThreadMessages(completedThreadId, projectId, true), 120);
            window.setTimeout(() => void refreshThreadMessages(completedThreadId, projectId, true), 900);
          }
        }
      };
    };
    connect();
    return () => { disposed = true; if (reconnectRef.current) window.clearTimeout(reconnectRef.current); socketRef.current?.close(); socketRef.current = null; };
  }, [authenticated, loadDashboard, loadProjectData, projectId, refreshThreadMessages]);

  useEffect(() => {
    if (!authenticated || !projectId) return;
    let syncing = false;
    const syncVisibleView = async () => {
      if (document.visibilityState !== 'visible') return;
      if (syncing) return;
      syncing = true;
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        try { socketRef.current?.close(); } catch {}
        reconnectNowRef.current();
      }
      void loadDashboard();
      const activeThreadId = threadIdRef.current;
      try {
        const loadedTasks = await loadProjectData(projectId);
        if (activeThreadId) {
          const taskStillRunning = loadedTasks.some((task) => task.threadId === activeThreadId && task.status === 'running');
          await refreshThreadMessages(activeThreadId, projectId, true, taskStillRunning);
        }
      } finally {
        syncing = false;
      }
    };
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') syncVisibleView(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', syncVisibleView);
    window.addEventListener('online', syncVisibleView);
    window.addEventListener('pageshow', syncVisibleView);
    window.addEventListener('palm-resume', syncVisibleView);
    const timer = window.setInterval(syncVisibleView, 4_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', syncVisibleView);
      window.removeEventListener('online', syncVisibleView);
      window.removeEventListener('pageshow', syncVisibleView);
      window.removeEventListener('palm-resume', syncVisibleView);
      window.clearInterval(timer);
    };
  }, [authenticated, loadDashboard, loadProjectData, projectId, refreshThreadMessages]);

  async function login(event: FormEvent) {
    event.preventDefault(); setLoginError('');
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) }).catch(() => null);
    if (!response?.ok) { const body = response ? await response.json().catch(() => ({})) as { error?: string } : {}; setLoginError(body.error ?? '无法连接服务器'); return; }
    setPassword(''); setNotice(''); setAuthenticated(true);
  }

  function newConversation() {
    if (running) { setNotice('请先停止当前任务再新建对话'); return; }
    setThreadId(undefined); setMessages([]); setAttachments([]); setUploadFeedbacks([]); setView('chat');
  }

  async function createProject() {
    const name = window.prompt('新项目名称');
    if (!name?.trim()) return;
    const response = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    const body = await response.json() as { project?: Project; error?: string };
    if (!response.ok || !body.project) { setNotice(body.error ?? '项目创建失败'); return; }
    await loadProjects(); setProjectId(body.project.id); setView('chat');
  }

  async function renameProject() {
    if (!activeProject) return;
    const name = window.prompt('修改项目名称', activeProject.name);
    if (!name?.trim() || name.trim() === activeProject.name) return;
    const response = await fetch(`/api/projects/${encodeURIComponent(activeProject.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }) });
    const body = await response.json() as { project?: Project; error?: string };
    if (!response.ok || !body.project) { setNotice(body.error ?? '项目重命名失败'); return; }
    setProjects((items) => items.map((item) => item.id === body.project?.id ? body.project : item));
    setNotice('项目名称已更新');
  }

  async function saveModel(modelName: string, reasoningEffort?: string) {
    const model = models.find((item) => item.model === modelName);
    if (!model) return;
    const effort = reasoningEffort && model.supportedReasoningEfforts.some((item) => item.reasoningEffort === reasoningEffort)
      ? reasoningEffort : model.defaultReasoningEffort;
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/model`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: model.model, reasoningEffort: effort }),
    });
    const body = await response.json() as { project?: Project; error?: string };
    if (!response.ok || !body.project) { setNotice(body.error ?? '模型切换失败'); return; }
    setProjects((items) => items.map((item) => item.id === body.project?.id ? body.project : item));
    setNotice(`已切换到 ${model.displayName} · ${effort}`);
  }

  async function openThread(item: ProjectThread, focusHint = item.title) {
    const response = await fetch(`/api/threads/${encodeURIComponent(item.threadId)}?projectId=${encodeURIComponent(projectId)}`);
    if (!response.ok) { setNotice('读取对话失败'); return; }
    const restored = messagesFromThread(await response.json());
    const hint = focusHint.trim().toLowerCase();
    const focused = [...restored].reverse().find((message) => message.role === 'user' && (message.text.trim().toLowerCase() === hint || message.text.toLowerCase().includes(hint)))
      ?? [...restored].reverse().find((message) => message.role === 'user') ?? restored.at(-1);
    setThreadId(item.threadId); setMessages(restored); setFocusedMessageId(focused?.id); setView('chat');
    if (!restored.length) setNotice('已恢复对话上下文；旧消息格式暂无法完整展示');
  }

  function startTurn(text: string, sentAttachments: UploadedFile[], targetThreadId = threadId) {
    if (!text || running || socketRef.current?.readyState !== WebSocket.OPEN) return;
    const now = crypto.randomUUID();
    setMessages((items) => [...items, { id: `${now}-u`, role: 'user', text, attachments: sentAttachments }, { id: `${now}-a`, role: 'assistant', text: '', pending: true }]);
    const pending: PendingTurn = { clientRequestId: crypto.randomUUID(), projectId, threadId: targetThreadId, text, attachments: sentAttachments };
    pendingTurnRef.current = pending;
    window.localStorage.setItem(`palm:pending-turn:${projectId}`, JSON.stringify(pending));
    setDeliveryState('sending');
    socketRef.current.send(JSON.stringify({
      type: 'turn.start', clientRequestId: pending.clientRequestId, projectId, threadId: targetThreadId,
      text, attachments: sentAttachments.map((file) => file.path),
    }));
    runningRef.current = true;
    setDraft(''); window.localStorage.removeItem(`palm:draft:${projectId}`); setAttachments([]); setRunning(true); setNotice('');
  }

  function sendTask(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim() || (attachments.length ? '请检查并处理我上传的附件。' : '');
    startTurn(text, attachments);
  }

  async function retryTask(task: ProjectTask) {
    if (running || socketRef.current?.readyState !== WebSocket.OPEN) { setNotice('请等待连接恢复或先停止当前任务'); return; }
    const thread = threads.find((item) => item.threadId === task.threadId);
    if (!thread) { setNotice('原对话不存在，无法重试'); return; }
    await openThread(thread);
    const retryAttachments = (task.attachments ?? []).map((attachmentPath) => files.find((file) => file.path === attachmentPath) ?? {
      path: attachmentPath, name: displayFileName(attachmentPath.split('/').pop() ?? attachmentPath), size: undefined,
    });
    startTurn(task.title, retryAttachments, task.threadId);
  }

  const upload = useCallback(async (file?: File, existingUploadId?: string, manageBusy = true): Promise<boolean> => {
    if (!file || (uploading && manageBusy)) return false;
    const uploadId = existingUploadId ?? crypto.randomUUID();
    const updateFeedback = (next: UploadFeedback | ((current: UploadFeedback) => UploadFeedback)) => setUploadFeedbacks((items) => {
      const existing = items.find((item) => item.uploadId === uploadId);
      const value = typeof next === 'function' ? next(existing ?? { uploadId, file, progress: 0, status: 'uploading', retryable: true }) : next;
      return existing ? items.map((item) => item.uploadId === uploadId ? value : item) : [...items, value];
    });
    if (file.size > SAFE_UPLOAD_BYTES) {
      updateFeedback({ uploadId, file, progress: 0, status: 'error', message: '文件超过公网安全上限 95MB', retryable: false });
      return false;
    }
    const url = `/api/files/upload?projectId=${encodeURIComponent(projectId)}`;
    setNotice('');
    if (manageBusy) setUploading(true);
    updateFeedback({ uploadId, file, progress: 0, status: 'uploading', retryable: true });
    try {
      let result: UploadResponse = { status: 0 };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        updateFeedback((current) => ({ ...current, status: attempt === 1 ? 'uploading' : 'retrying' }));
        result = await uploadOnce(file, url, uploadId, (progress) => updateFeedback((current) => ({ ...current, progress, status: 'uploading' })));
        if (result.status >= 200 && result.status < 300 && result.body?.file) {
          const saved = result.body.file;
          setAttachments((items) => items.some((item) => item.path === saved.path) ? items : [...items, saved]);
          setFiles((items) => items.some((item) => item.path === saved.path) ? items : [saved, ...items]);
          updateFeedback((current) => ({ ...current, progress: 100, status: 'success', retryable: false }));
          window.setTimeout(() => setUploadFeedbacks((items) => items.filter((item) => item.uploadId !== uploadId)), 4500);
          setNotice('附件已添加到当前对话');
          return true;
        }
        const retryable = result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
        if (!retryable || attempt === 3) break;
        updateFeedback((current) => ({ ...current, status: 'retrying', message: `第 ${attempt} 次重试` }));
        await new Promise((resolve) => window.setTimeout(resolve, attempt * 1200));
      }
      updateFeedback({ uploadId, file, progress: 0, status: 'error', message: uploadErrorMessage(result), retryable: result.status !== 413 && result.status !== 507 });
      return false;
    } finally {
      if (manageBusy) setUploading(false);
    }
  }, [projectId, uploading]);

  const uploadFiles = useCallback(async (fileList?: FileList | File[] | null) => {
    if (!fileList?.length || uploading) return;
    const selected = Array.from(fileList).slice(0, 10);
    if (fileList.length > 10) setNotice('一次最多上传 10 个文件，已处理前 10 个');
    setUploading(true);
    let completed = 0;
    try { for (const file of selected) if (await upload(file, undefined, false)) completed += 1; }
    finally { setUploading(false); }
    setNotice(completed === selected.length ? `已上传 ${completed} 个文件并添加到当前对话` : `已上传 ${completed}/${selected.length} 个文件；失败项可单独重试`);
  }, [upload, uploading]);

  useEffect(() => {
    if (!authenticated) return;
    let consuming = false;
    const consumeSharedFiles = async (event?: Event) => {
      if (consuming) return;
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const shared = (Array.isArray(detail) ? detail : window.__PALM_SHARED_FILES__) as NativeSharedFile[] | undefined;
      if (!shared?.length) return;
      consuming = true;
      window.__PALM_SHARED_FILES__ = [];
      setView('chat');
      setNotice(`正在接收外部分享的 ${shared.length} 个文件…`);
      try {
        const imported: File[] = [];
        for (const item of shared.slice(0, 10)) {
          const response = await fetch(`/__native_share/${encodeURIComponent(item.id)}`);
          if (!response.ok) throw new Error(`无法读取 ${item.name}`);
          const blob = await response.blob();
          imported.push(new File([blob], item.name, { type: item.mimeType || blob.type || 'application/octet-stream' }));
        }
        await uploadFiles(imported);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : '接收外部分享文件失败，请重试');
      } finally {
        consuming = false;
      }
    };
    const listener = (event: Event) => { void consumeSharedFiles(event); };
    const errorListener = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      setNotice(typeof detail === 'string' && detail ? detail : '接收外部分享文件失败，请重试');
    };
    window.addEventListener('palm-share', listener);
    window.addEventListener('palm-share-error', errorListener);
    void consumeSharedFiles();
    return () => {
      window.removeEventListener('palm-share', listener);
      window.removeEventListener('palm-share-error', errorListener);
    };
  }, [authenticated, projectId, uploadFiles]);

  function dragEnter(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDraggingFiles(true);
  }

  function dragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDraggingFiles(false);
  }

  function dropFiles(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingFiles(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
  }

  function taskStatusLabel(status: ProjectTask['status']) {
    return ({ running: '执行中', completed: '已完成', failed: '失败', interrupted: '已停止' } as const)[status];
  }

  async function copyMessage(text: string) {
    try { await navigator.clipboard.writeText(text); setNotice('回复已复制'); }
    catch { setNotice('复制失败，请长按文字选择复制'); }
  }

  async function deleteFile(file: UploadedFile) {
    if (!window.confirm(`删除 ${file.name}？`)) return;
    const query = new URLSearchParams({ projectId, path: file.path });
    const response = await fetch(`/api/files?${query}`, { method: 'DELETE' });
    if (response.ok) setFiles((items) => items.filter((item) => item.path !== file.path)); else setNotice('文件删除失败');
  }

  function interrupt() {
    if (!threadId || !turnId || socketRef.current?.readyState !== WebSocket.OPEN) return;
    socketRef.current.send(JSON.stringify({ type: 'turn.interrupt', threadId, turnId }));
  }

  if (booting) return <main className="splash"><div className="brand-mark">掌</div><p>正在唤醒助理…</p></main>;
  if (!authenticated) return <main className="login-shell"><section className="login-card"><div className="login-seal">掌</div><p className="eyebrow">私人空间</p><h1>掌心助理</h1><p className="login-intro">从手机安全访问服务器上的 Codex。</p><form onSubmit={login}><label htmlFor="password">访问密码</label><input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" autoFocus />{loginError && <p className="form-error" role="alert">{loginError}</p>}<button type="submit" disabled={!password}>进入工作台</button></form><p className="privacy-note">仅允许通过你的受保护域名访问</p></section></main>;

  return <main className="app-shell">
    <aside className="desktop-rail" aria-label="主导航"><div className="rail-brand"><div className="brand-mark">掌</div><strong>掌心</strong></div><nav><button className={`rail-button ${view === 'chat' ? 'active' : ''}`} aria-label="新对话" onClick={newConversation}><b>✦</b><span>对话</span></button><button className={`rail-button ${view === 'history' ? 'active' : ''}`} aria-label="任务记录" onClick={() => setView('history')}><b>▤</b><span>记录</span></button><button className={`rail-button ${view === 'files' ? 'active' : ''}`} aria-label="文件中心" onClick={() => setView('files')}><b>▱</b><span>文件</span></button></nav><button className="rail-avatar" aria-label="退出登录" onClick={() => void fetch('/api/auth/logout', { method: 'POST' }).then(() => setAuthenticated(false))}><b>我</b><span>退出</span></button></aside>
    <section className={`conversation ${draggingFiles ? 'drag-active' : ''}`} onDragEnter={dragEnter} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDragLeave={dragLeave} onDrop={dropFiles}>
      {draggingFiles && <div className="drop-overlay" role="status"><div><span>＋</span><strong>拖到这里上传</strong><small>文件会加入当前项目和本轮对话</small></div></div>}
      <header className="topbar"><div className="identity"><span className="mobile-brand">掌</span><div><h1>掌心助理</h1><p><span className={connection === '已连接' ? 'online-dot' : 'offline-dot'} /> Codex {connection}</p></div></div><div className="header-actions"><select aria-label="当前项目" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={uploading}>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button className="project-add" onClick={() => void createProject()} aria-label="创建项目" disabled={uploading}>＋项目</button><div className="usage-control"><button className="usage-pill" aria-label="查看 Codex 余量" aria-expanded={usageOpen} onClick={() => { setUsageOpen((open) => !open); void loadDashboard(); }}>{usageWindows.length ? usageWindows.slice(0, 2).map((window) => <span className="usage-metric" key={window.id}><small>{window.label}</small><strong>{window.remainingPercent}%</strong></span>) : <span className="usage-metric"><small>余量</small><strong>暂无</strong></span>}</button>{usageOpen && <div className="usage-popover"><div className="usage-heading"><strong>Codex 用量</strong><button onClick={() => void loadDashboard()} aria-label="刷新用量">↻</button></div>{usageWindows.length ? usageWindows.map((window) => <div className="usage-window" key={window.id}><div><strong>{window.label}</strong><span>剩余 {window.remainingPercent}%</span></div><i><b style={{ width: `${window.remainingPercent}%` }} /></i><small>{resetLabel(window.resetAt)}</small></div>) : <p>暂时无法读取用量，请稍后刷新。</p>}</div>}</div></div></header>
      <nav className="mobile-tabs"><button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>对话</button><button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}>记录</button><button className={view === 'files' ? 'active' : ''} onClick={() => setView('files')}>文件</button></nav>
      <section className="model-bar" aria-label="Codex 模型设置"><label><span>模型</span><select value={activeModel?.model ?? ''} onChange={(event) => void saveModel(event.target.value)} disabled={!models.length}>{models.map((model) => <option key={model.id} value={model.model}>{model.displayName}</option>)}</select></label><label><span>推理</span><select value={activeEffort} onChange={(event) => activeModel && void saveModel(activeModel.model, event.target.value)} disabled={!activeModel}>{activeModel?.supportedReasoningEfforts.map((effort) => <option key={effort.reasoningEffort} value={effort.reasoningEffort}>{effortLabel(effort.reasoningEffort)}</option>)}</select></label><button className="model-refresh" onClick={() => void loadModels(true)} aria-label="刷新模型列表">↻</button><strong title={status.sudo?.available ? 'Codex 可使用无密码 sudo 执行服务器维护' : 'Codex 完整沙箱访问；sudo 尚不可用'}>{status.sudo?.available ? 'Root 运维' : '完全访问'}</strong></section>
      {(connection !== '已连接' || status.disk?.warning) && <section className={`system-alert ${status.disk?.tasksPaused ? 'critical' : ''}`} role="status"><strong>{connection !== '已连接' ? `Codex ${connection}` : status.disk?.tasksPaused ? '服务器空间不足，已暂停新任务和上传' : '服务器磁盘空间偏低'}</strong><span>{connection !== '已连接' ? '连接恢复后会自动同步当前任务' : `${bytes(status.disk?.freeBytes)} 可用 · 建议尽快清理旧版本`}</span></section>}
      {view === 'history' && <div className="panel-stage"><div className="panel-title"><div><p className="eyebrow">任务中心</p><h2>{activeProject?.name ?? '当前项目'}</h2></div><div className="panel-title-actions"><button className="secondary" onClick={() => void renameProject()}>重命名</button><button onClick={newConversation}>＋ 新对话</button></div></div><div className="panel-search"><input value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="搜索任务或对话" aria-label="搜索任务或对话" /><span>{matchingTasks.length} 个任务</span></div>{matchingTasks.length > 0 && <section className="task-section"><div className="section-heading"><strong>最近任务</strong><span>点击后定位到对应消息</span></div><div className="task-list">{matchingTasks.map((task) => <article key={task.taskId} className={`task-card ${task.status}`}><button className="task-main" onClick={() => { const thread = threads.find((item) => item.threadId === task.threadId); if (thread) void openThread(thread, task.title); }}><span className="task-state">{task.status === 'running' ? <i /> : task.status === 'completed' ? '✓' : task.status === 'interrupted' ? '■' : '!'}</span><span className="task-copy"><strong>{task.title}</strong><small>{new Date(task.startedAt).toLocaleString('zh-CN')} · {taskDuration(task)} · 附件 {task.attachments?.length ?? 0} · 成果 {task.outputPaths?.length ?? 0}{task.errorMessage ? ` · ${task.errorMessage}` : ''}</small></span><b>{taskStatusLabel(task.status)}</b></button>{((task.outputPaths?.length ?? 0) > 0 || ['failed', 'interrupted'].includes(task.status)) && <div className="task-actions">{task.outputPaths?.map((outputPath) => { const query = new URLSearchParams({ projectId, path: outputPath }); return <a key={outputPath} href={`/api/files/download?${query}`}>↓ {outputPath.split('/').pop()}</a>; })}{['failed', 'interrupted'].includes(task.status) && <button onClick={() => void retryTask(task)}>重新执行</button>}</div>}</article>)}</div></section>}<section className="thread-section"><div className="section-heading"><strong>对话记录</strong><span>{recordSearch.trim() ? `${matchingThreads.length} 条匹配` : `最近 ${visibleThreads.length} 条`} · 点击或双击均可定位</span></div>{visibleThreads.length ? <div className="record-list">{visibleThreads.map((thread) => <button key={thread.threadId} onClick={() => void openThread(thread)}><strong>{thread.title}</strong><span>{new Date(thread.updatedAt).toLocaleString('zh-CN')}</span></button>)}</div> : <div className="empty-panel">没有匹配的对话。</div>}</section></div>}
      {view === 'files' && <div className="panel-stage"><div className="panel-title"><div><p className="eyebrow">项目文件</p><h2>{activeProject?.name ?? '当前项目'}的文件</h2></div><button onClick={() => fileRef.current?.click()} disabled={uploading}>{uploading ? '上传中…' : '＋ 上传'}</button></div><div className="file-toolbar"><div className="file-filters"><button className={fileKind === 'all' ? 'active' : ''} onClick={() => setFileKind('all')}>全部</button><button className={fileKind === 'inbox' ? 'active' : ''} onClick={() => setFileKind('inbox')}>上传</button><button className={fileKind === 'outbox' ? 'active' : ''} onClick={() => setFileKind('outbox')}>成果</button></div><input value={fileSearch} onChange={(event) => setFileSearch(event.target.value)} placeholder="搜索文件" aria-label="搜索文件" /></div>{notice && <button className="panel-notice" onClick={() => setNotice('')}>✓ {notice}<span>×</span></button>}{uploadFeedbacks.length > 0 && <div className="panel-upload-feedback">{uploadFeedbacks.map((item) => <UploadCard key={item.uploadId} item={item} onRetry={() => void upload(item.file, item.uploadId)} onDismiss={() => setUploadFeedbacks((items) => items.filter((entry) => entry.uploadId !== item.uploadId))} />)}</div>}{matchingFiles.length ? <div className="file-list">{matchingFiles.map((file) => { const query = new URLSearchParams({ projectId, path: file.path }); return <article key={file.path}><div><span className={`file-kind ${file.path.startsWith('outbox/') ? 'output' : ''}`}>{file.path.startsWith('outbox/') ? '成果' : '上传'}</span><strong>{file.name}</strong><span>{bytes(file.size)}{file.modifiedAt ? ` · ${new Date(file.modifiedAt).toLocaleString('zh-CN')}` : ''}</span></div><div>{canPreview(file.name) && <a href={`/api/files/preview?${query}`} target="_blank" rel="noreferrer">预览</a>}<a href={`/api/files/download?${query}`}>下载</a><button onClick={() => void deleteFile(file)}>删除</button></div></article>; })}</div> : <div className="empty-panel">没有匹配的文件。</div>}</div>}
      {view === 'chat' && <div className="message-stage"><div className="date-divider"><span>{activeProject?.name ?? '当前项目'}</span></div>{messages.length === 0 ? <><article className="assistant-message"><div className="assistant-seal">掌</div><div className="message-copy"><p className="eyebrow">独立项目工作台</p><h2>今天想先处理什么？</h2><p className="lede">上传的文件会真实保存到当前项目，并把服务器路径交给 Codex 读取。不同项目拥有独立目录和对话记录。</p><div className="starter-grid">{starterTasks.map((task) => <button key={task} onClick={() => { setDraft(task); window.localStorage.setItem(`palm:draft:${projectId}`, task); }}>{task}<span>↗</span></button>)}</div></div></article><section className={`status-card ${status.disk?.warning ? "warning" : ""}`} aria-label="服务器状态"><div><span className="status-icon">{status.disk?.warning ? "!" : "✓"}</span><div><strong>{status.disk?.tasksPaused ? "空间不足，已暂停新任务" : status.disk?.warning ? "磁盘空间偏低" : "完全访问模式已启用"}</strong><p>{bytes(status.disk?.freeBytes)} 可用 · {status.disk?.warning ? "建议清理旧版本" : "常规操作无需审批"}</p></div></div><button onClick={() => void loadDashboard()}>刷新</button></section></> : <section className="chat-list" aria-live="polite">{messages.map((message) => <article key={message.id} data-message-id={message.id} className={`chat-bubble ${message.role} ${focusedMessageId === message.id ? 'message-focus' : ''}`}><span>{message.role === 'assistant' ? '掌' : '我'}</span><div>{message.text ? <MessageContent text={message.text} projectId={projectId} files={files} /> : message.pending ? '正在思考…' : ''}{message.attachments?.length ? <div className="message-files">{message.attachments.map((file) => <SentFileCard key={file.path} file={file} projectId={projectId} />)}</div> : null}{message.pending && <i className="typing-dot" />}{message.role === 'assistant' && message.text && !message.pending && <button type="button" className="copy-message" onClick={() => void copyMessage(message.text)}>复制</button>}</div></article>)}</section>}</div>}
      <footer className={`composer-wrap ${view !== 'chat' ? 'composer-hidden' : ''}`}>{notice && <button className="notice" onClick={() => setNotice('')}>{notice} ×</button>}{recentOutputs.length > 0 && <div className="output-row"><span>最新成果</span>{recentOutputs.map((file) => { const query = new URLSearchParams({ projectId, path: file.path }); return <a key={file.path} href={`/api/files/download?${query}`}>↓ {file.name}</a>; })}</div>}{(uploadFeedbacks.length > 0 || attachments.length > 0) && <div className="attachment-tray">{uploadFeedbacks.map((item) => <UploadCard key={item.uploadId} item={item} onRetry={() => void upload(item.file, item.uploadId)} onDismiss={() => setUploadFeedbacks((items) => items.filter((entry) => entry.uploadId !== item.uploadId))} />)}{attachments.map((file) => <AttachedFileCard key={file.path} file={file} onRemove={() => setAttachments((items) => items.filter((item) => item.path !== file.path))} />)}</div>}<form className="composer" onSubmit={sendTask}><input ref={fileRef} type="file" multiple hidden disabled={uploading} onChange={(event) => { void uploadFiles(event.target.files); event.target.value = ''; }} /><div className="composer-actions"><button type="button" className="round-button" aria-label="添加文件" title="选择文件或直接拖入" onClick={() => fileRef.current?.click()} disabled={uploading}>＋</button><button type="button" className="round-button camera-button" aria-label="选择图片" onClick={() => fileRef.current?.click()} disabled={uploading}>▣</button></div><textarea value={draft} onChange={(event) => { const value = event.target.value; setDraft(value); if (value) window.localStorage.setItem(`palm:draft:${projectId}`, value); else window.localStorage.removeItem(`palm:draft:${projectId}`); }} placeholder={running ? '任务执行中…' : '交代一个任务……'} rows={1} aria-label="任务内容" />{running ? <button type="button" className="stop-button" aria-label="停止任务" onClick={interrupt}>■</button> : <button type="submit" className="send-button" disabled={uploading || (!draft.trim() && !attachments.length) || connection !== '已连接'} aria-label="发送">↑</button>}</form><p className={`composer-note delivery-${deliveryState}`}><span className="desktop-upload-hint">可拖入文件 · </span>{deliveryState === 'sending' ? '正在发送，断线后会安全续传' : deliveryState === 'accepted' ? '服务器已接收，Codex 正在执行' : '草稿按项目保存 · 附件发送时会交给 Codex 读取'}</p></footer>
    </section>
  </main>;
}
