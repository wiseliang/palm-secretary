"use client";

import {
  DragEvent,
  FormEvent,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Archive,
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  ChatCircleDots,
  ClockCounterClockwise,
  Copy,
  DotsThree,
  DownloadSimple,
  Export,
  FolderOpen,
  Gauge,
  GithubLogo,
  GitDiff,
  ImageSquare,
  Paperclip,
  PencilSimple,
  Plus,
  SignOut,
  SlidersHorizontal,
  Star,
  Stop,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";

type ExecutionStep = {
  id: string;
  label: string;
  detail?: string;
  status: "running" | "completed" | "failed";
};
type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  attachments?: UploadedFile[];
  steps?: ExecutionStep[];
};
type UploadedFile = {
  name: string;
  path: string;
  size?: number;
  modifiedAt?: string;
};
type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  reasoningEffort?: string;
  archivedAt?: string;
};
type ProjectThread = {
  threadId: string;
  title: string;
  updatedAt: string;
  archivedAt?: string;
  favorite?: boolean;
};
type ProjectTask = {
  taskId: string;
  turnId: string;
  threadId: string;
  projectId: string;
  title: string;
  status: "running" | "completed" | "failed" | "interrupted";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  attachments: string[];
  outputPaths: string[];
  errorMessage?: string;
};
type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: string;
    description: string;
  }>;
};
type ServerStatus = {
  disk?: {
    freeBytes: number;
    usedPercent: number;
    warning: boolean;
    tasksPaused: boolean;
  };
  sudo?: { available: boolean };
};
type View = "chat" | "history" | "files";
type UploadResponse = {
  status: number;
  body?: { file?: UploadedFile; error?: string };
};
type UploadFeedback = {
  uploadId: string;
  file: File;
  progress: number;
  status: "uploading" | "retrying" | "success" | "error";
  message?: string;
  retryable: boolean;
};
type UsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetAt?: number;
  windowMinutes?: number;
};
type NativeSharedFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: number;
};
type PendingTurn = {
  clientRequestId: string;
  projectId: string;
  threadId?: string;
  text: string;
  attachments: UploadedFile[];
};
type DeliveryState = "idle" | "sending" | "accepted";
type SearchResult = {
  kind: "thread" | "task" | "file";
  projectId: string;
  threadId?: string;
  path?: string;
  title: string;
  snippet: string;
  updatedAt?: string;
};
type GitStatus = {
  projectId?: string;
  repository: boolean;
  branch?: string;
  changes: Array<{
    status: string;
    indexStatus: string;
    worktreeStatus: string;
    path: string;
    originalPath?: string;
  }>;
  untracked?: string[];
  unstagedDiff?: string;
  stagedDiff?: string;
  error?: string;
};
type PendingNavigation = {
  projectId: string;
  threadId?: string;
  focusHint?: string;
  view: "chat" | "files";
  fileSearch?: string;
};
type TaskNotice = {
  key: string;
  projectId: string;
  threadId: string;
  text: string;
};
type OpenMenu =
  | "project-picker"
  | "project-actions"
  | "attachments"
  | `task-actions:${string}`;
type ProjectDialog = {
  mode: "create" | "rename" | "duplicate" | "github";
  name: string;
  url?: string;
};

declare global {
  interface Window {
    __PALM_SHARED_FILES__?: NativeSharedFile[];
    __PALM_OPEN_TASK__?: { projectId: string; threadId: string };
    PalmNative?: {
      notifyTask?: (
        status: "completed" | "failed" | "interrupted",
        projectId: string,
        threadId: string,
      ) => void;
      ackTaskTarget?: () => void;
    };
  }
}
const starterTasks = [
  "整理当前项目的文件",
  "把这份 PDF 提炼成要点",
  "检查服务器运行状态",
];

function pendingAttachmentKey(projectId: string) {
  return `palm:pending-attachments:${projectId}`;
}

function readPendingAttachments(projectId: string): UploadedFile[] {
  try {
    const stored = window.localStorage.getItem(pendingAttachmentKey(projectId));
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is UploadedFile =>
        Boolean(
          item &&
            typeof item === "object" &&
            "path" in item &&
            "name" in item &&
            typeof item.path === "string" &&
            typeof item.name === "string",
        ),
    );
  } catch {
    return [];
  }
}
const SAFE_UPLOAD_BYTES = 95 * 1024 ** 2;
const COMPLETION_CURSOR_KEY = "palm:last-task-completed-at";
const NOTIFIED_TASKS_KEY = "palm:notified-task-ids";

function rememberTaskNotification(taskId: string): boolean {
  const notified = new Set<string>();
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(NOTIFIED_TASKS_KEY) ?? "[]",
    ) as unknown;
    if (Array.isArray(stored))
      stored.filter((item): item is string => typeof item === "string").forEach((item) => notified.add(item));
  } catch {
    /* invalid legacy cache is replaced below */
  }
  const isNew = !notified.has(taskId);
  notified.add(taskId);
  window.localStorage.setItem(
    NOTIFIED_TASKS_KEY,
    JSON.stringify([...notified].slice(-100)),
  );
  return isNew;
}

function advanceCompletionCursor(completedAt?: string): void {
  if (!completedAt) return;
  const previous = window.localStorage.getItem(COMPLETION_CURSOR_KEY) ?? "";
  if (!previous || completedAt > previous)
    window.localStorage.setItem(COMPLETION_CURSOR_KEY, completedAt);
}

function usageWindowsFrom(value: unknown): UsageWindow[] {
  const candidates: Array<{ path: string; value: Record<string, unknown> }> =
    [];
  const visited = new Set<object>();
  const walk = (node: unknown, currentPath = "rateLimits") => {
    if (!node || typeof node !== "object" || visited.has(node as object))
      return;
    visited.add(node as object);
    const record = node as Record<string, unknown>;
    if (typeof record.usedPercent === "number")
      candidates.push({ path: currentPath, value: record });
    for (const [key, child] of Object.entries(record))
      walk(child, `${currentPath}.${key}`);
  };
  walk(value);
  const windows = candidates.map(({ path, value }, index) => {
    const minutes = [
      value.windowDurationMins,
      value.windowDurationMinutes,
      value.windowMinutes,
      value.limitWindowMinutes,
    ].find((item) => typeof item === "number") as number | undefined;
    const resetRaw = [value.resetsAt, value.resetAt, value.resetAtMs].find(
      (item) => typeof item === "number",
    ) as number | undefined;
    const key = path.split(".").at(-1)?.toLowerCase() ?? "";
    const label =
      minutes && minutes <= 360
        ? "5 小时"
        : minutes && minutes >= 6 * 24 * 60
          ? "每周"
          : key.includes("primary")
            ? "5 小时"
            : key.includes("secondary")
              ? "每周"
              : `窗口 ${index + 1}`;
    const usedPercent = Math.max(0, Math.min(100, Number(value.usedPercent)));
    return {
      id: `${path}-${minutes ?? index}`,
      label,
      usedPercent,
      remainingPercent: Math.max(0, Math.round(100 - usedPercent)),
      resetAt: resetRaw
        ? resetRaw < 10_000_000_000
          ? resetRaw * 1000
          : resetRaw
        : undefined,
      windowMinutes: minutes,
    };
  });
  return windows
    .filter(
      (window, index) =>
        windows.findIndex((item) => item.label === window.label) === index,
    )
    .sort(
      (a, b) =>
        (a.windowMinutes ?? Number.MAX_SAFE_INTEGER) -
        (b.windowMinutes ?? Number.MAX_SAFE_INTEGER),
    );
}

function resetLabel(resetAt?: number): string {
  if (!resetAt) return "重置时间待同步";
  const remainingMs = resetAt - Date.now();
  if (remainingMs <= 0) return "即将重置";
  const hours = Math.floor(remainingMs / 3_600_000);
  const minutes = Math.ceil((remainingMs % 3_600_000) / 60_000);
  if (hours >= 24)
    return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时后重置`;
  return `${hours ? `${hours} 小时 ` : ""}${minutes} 分钟后重置`;
}

function uploadOnce(
  file: File,
  url: string,
  uploadId: string,
  onProgress: (percent: number) => void,
): Promise<UploadResponse> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.withCredentials = true;
    request.timeout = 15 * 60_000;
    request.setRequestHeader("X-Upload-Id", uploadId);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0)
        onProgress(
          Math.min(99, Math.round((event.loaded / event.total) * 100)),
        );
    };
    request.onload = () => {
      let body: UploadResponse["body"];
      try {
        body = JSON.parse(request.responseText) as UploadResponse["body"];
      } catch {
        body = undefined;
      }
      resolve({ status: request.status, body });
    };
    request.onerror = () => resolve({ status: 0 });
    request.ontimeout = () => resolve({ status: 408 });
    request.onabort = () => resolve({ status: 0 });
    const form = new FormData();
    form.append("file", file);
    request.send(form);
  });
}

async function uploadChunked(
  file: File,
  projectId: string,
  uploadId: string,
  onProgress: (percent: number) => void,
): Promise<UploadResponse> {
  const base = `?projectId=${encodeURIComponent(projectId)}`;
  const headers = {
    "X-Upload-Id": uploadId,
    "X-File-Name": encodeURIComponent(file.name),
    "X-File-Size": String(file.size),
  };
  const session = await fetch(`/api/files/upload-session${base}`, {
    headers,
  }).catch(() => null);
  if (!session) return { status: 0 };
  if (!session.ok)
    return {
      status: session.status,
      body: (await session
        .json()
        .catch(() => undefined)) as UploadResponse["body"],
    };
  let offset = Number(
    ((await session.json()) as { uploaded?: number }).uploaded ?? 0,
  );
  const chunkSize = 8 * 1024 * 1024;
  while (offset < file.size) {
    const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
    const response = await fetch(`/api/files/upload-chunk${base}`, {
      method: "PUT",
      headers: {
        ...headers,
        "X-Upload-Offset": String(offset),
        "Content-Type": "application/octet-stream",
      },
      body: chunk,
    }).catch(() => null);
    if (!response) return { status: 0 };
    const body = (await response.json().catch(() => ({}))) as {
      uploaded?: number;
      error?: string;
    };
    if (response.status === 409 && typeof body.uploaded === "number") {
      offset = body.uploaded;
      continue;
    }
    if (!response.ok)
      return { status: response.status, body: { error: body.error } };
    offset = Number(body.uploaded ?? offset + chunk.size);
    onProgress(Math.min(99, Math.round((offset / file.size) * 100)));
  }
  const complete = await fetch(`/api/files/upload-complete${base}`, {
    method: "POST",
    headers,
  }).catch(() => null);
  if (!complete) return { status: 0 };
  return {
    status: complete.status,
    body: (await complete
      .json()
      .catch(() => undefined)) as UploadResponse["body"],
  };
}

async function abortChunkUpload(
  file: File,
  projectId: string,
  uploadId: string,
): Promise<void> {
  const headers = {
    "X-Upload-Id": uploadId,
    "X-File-Name": encodeURIComponent(file.name),
    "X-File-Size": String(file.size),
  };
  await fetch(
    `/api/files/upload-session?projectId=${encodeURIComponent(projectId)}`,
    { method: "DELETE", headers },
  ).catch(() => undefined);
}

function uploadErrorMessage(result: UploadResponse): string {
  if (result.body?.error) return result.body.error;
  if (result.status === 0) return "网络连接中断，请检查网络后重试";
  if (result.status === 401) return "登录已过期，请重新进入工作台";
  if (result.status === 413) return "文件过大，公网上传请控制在 95MB 以内";
  if (result.status === 429) return "上传过于频繁，请稍后重试";
  if (result.status === 507) return "服务器可用空间不足，已暂停上传";
  if (result.status >= 500) return "服务器暂时无法保存文件，请稍后重试";
  return `文件上传失败（HTTP ${result.status || "网络错误"}）`;
}

function bytes(value?: number) {
  if (value === undefined) return "暂无";
  if (value < 1024 ** 2) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

function fileMark(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension))
    return "图";
  if (["pdf"].includes(extension)) return "PDF";
  if (["doc", "docx", "txt", "md", "rtf"].includes(extension)) return "文";
  if (["xls", "xlsx", "csv"].includes(extension)) return "表";
  if (["zip", "rar", "7z", "tar", "gz"].includes(extension)) return "包";
  return "档";
}

function canPreview(name: string): boolean {
  return [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "pdf",
    "txt",
    "md",
    "csv",
    "json",
    "log",
  ].includes(name.split(".").pop()?.toLowerCase() ?? "");
}

function isImageFile(name: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(
    name.split(".").pop()?.toLowerCase() ?? "",
  );
}

function safeServerFilePath(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/^<|>$/g, "")
    .replaceAll("\\", "/")
    .split(/[?#]/, 1)[0];
  let normalized = cleaned.replace(/^\.\//, "");
  const stored = normalized.match(/(?:^|\/)(inbox|outbox)\/(.+)$/i);
  if (stored) normalized = `${stored[1].toLowerCase()}/${stored[2]}`;
  if (
    !/^(inbox|outbox)\/.+/i.test(normalized) ||
    normalized.split("/").includes("..") ||
    !isImageFile(normalized)
  )
    return undefined;
  return normalized;
}

function fileUrl(
  projectId: string,
  path: string,
  action: "preview" | "download" = "preview",
): string {
  return `/api/files/${action}?${new URLSearchParams({ projectId, path })}`;
}

function displayFileName(name: string): string {
  return (
    name
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{8}-/i, "")
      .replace(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i,
        "",
      ) || name
  );
}

function parseUserMessage(text: string): {
  text: string;
  attachments: UploadedFile[];
} {
  const marker = "\n\n【本次附件】";
  const markerAt = text.indexOf(marker);
  if (markerAt < 0) return { text, attachments: [] };
  const attachments = text
    .slice(markerAt + marker.length)
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^- (.+?)（(\d+) 字节）$/);
      if (!match) return [];
      const normalized = match[1].replaceAll("\\", "/");
      const stored = normalized.match(/\/(inbox|outbox)\/(.+)$/);
      if (!stored) return [];
      return [
        {
          name: displayFileName(stored[2]),
          path: `${stored[1]}/${stored[2]}`,
          size: Number(match[2]),
        },
      ];
    });
  return { text: text.slice(0, markerAt), attachments };
}

function inlineContent(text: string): ReactNode[] {
  return text
    .split(/(`[^`\n]+`|https?:\/\/[^\s]+)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith("`") && part.endsWith("`"))
        return <code key={index}>{part.slice(1, -1)}</code>;
      if (/^https?:\/\//.test(part))
        return (
          <a key={index} href={part} target="_blank" rel="noreferrer">
            {part}
          </a>
        );
      return part;
    });
}

function ServerImage({
  path,
  name,
  projectId,
}: {
  path: string;
  name: string;
  projectId: string;
}) {
  const previewUrl = fileUrl(projectId, path);
  return (
    <figure className="inline-server-image">
      <a
        href={previewUrl}
        target="_blank"
        rel="noreferrer"
        aria-label={`打开图片 ${name}`}
      >
        <img src={previewUrl} alt={name} loading="lazy" />
      </a>
      <figcaption>
        <span>{name}</span>
        <a href={fileUrl(projectId, path, "download")}>下载原图</a>
      </figcaption>
    </figure>
  );
}

function MessageContent({
  text,
  projectId,
  files,
}: {
  text: string;
  projectId: string;
  files: UploadedFile[];
}) {
  const nodes: ReactNode[] = [];
  const renderedPaths = new Set<string>();
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let code: string[] | null = null;
  let codeLanguage = "";
  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      if (code) {
        nodes.push(
          <pre key={`code-${index}`}>
            <code data-language={codeLanguage}>{code.join("\n")}</code>
          </pre>,
        );
        code = null;
        codeLanguage = "";
      } else {
        code = [];
        codeLanguage = line.slice(3).trim();
      }
      return;
    }
    if (code) {
      code.push(line);
      return;
    }
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (image) {
      const path = safeServerFilePath(image[2]);
      if (path) {
        renderedPaths.add(path);
        nodes.push(
          <ServerImage
            key={`image-${index}`}
            path={path}
            name={
              image[1].trim() || displayFileName(path.split("/").pop() ?? path)
            }
            projectId={projectId}
          />,
        );
      } else nodes.push(<p key={index}>{inlineContent(line)}</p>);
    } else if (heading) {
      const Tag = `h${heading[1].length + 2}` as "h3" | "h4" | "h5";
      nodes.push(<Tag key={index}>{inlineContent(heading[2])}</Tag>);
    } else if (unordered || ordered) {
      nodes.push(
        <div className="rich-list-item" key={index}>
          <b>{ordered ? `${line.match(/^\d+/)?.[0]}.` : "•"}</b>
          <span>{inlineContent((unordered ?? ordered)?.[1] ?? "")}</span>
        </div>,
      );
    } else if (!line.trim())
      nodes.push(<span className="rich-spacer" key={index} />);
    else nodes.push(<p key={index}>{inlineContent(line)}</p>);
  });
  if (code)
    nodes.push(
      <pre key="code-final">
        <code data-language={codeLanguage}>{code.join("\n")}</code>
      </pre>,
    );
  files
    .filter(
      (file) =>
        isImageFile(file.name) &&
        !renderedPaths.has(file.path) &&
        (text.includes(file.path) || text.includes(file.name)),
    )
    .forEach((file) =>
      nodes.push(
        <ServerImage
          key={`mentioned-${file.path}`}
          path={file.path}
          name={file.name}
          projectId={projectId}
        />,
      ),
    );
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

function UploadCard({
  item,
  onRetry,
  onDismiss,
}: {
  item: UploadFeedback;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const active = item.status === "uploading" || item.status === "retrying";
  const status =
    item.status === "retrying"
      ? "网络波动，正在重试…"
      : item.status === "uploading"
        ? `正在上传 · ${item.progress}%`
        : item.status === "success"
          ? "上传成功，已添加到当前任务"
          : (item.message ?? "上传失败");
  return (
    <article
      className={`attachment-card upload-card ${item.status}`}
      role="status"
      aria-live="polite"
    >
      <span className="attachment-icon">{fileMark(item.file.name)}</span>
      <div className="attachment-copy">
        <strong title={item.file.name}>{item.file.name}</strong>
        <span>
          {status} · {bytes(item.file.size)}
        </span>
        {active && (
          <span className="upload-track" aria-hidden="true">
            <i style={{ width: `${item.progress}%` }} />
          </span>
        )}
      </div>
      {item.status === "error" ? (
        <div className="upload-actions">
          {item.retryable && (
            <button type="button" onClick={onRetry}>
              重试
            </button>
          )}
          <button type="button" aria-label="关闭上传提示" onClick={onDismiss}>
            ×
          </button>
        </div>
      ) : item.status === "success" ? (
        <button
          type="button"
          className="upload-success"
          aria-label="关闭上传成功提示"
          onClick={onDismiss}
        >
          ✓
        </button>
      ) : (
        <span className="upload-spinner" aria-hidden="true" />
      )}
    </article>
  );
}

function AttachedFileCard({
  file,
  onRemove,
}: {
  file: UploadedFile;
  onRemove: () => void;
}) {
  return (
    <article className="attachment-card attached-card">
      <span className="attachment-icon">{fileMark(file.name)}</span>
      <div className="attachment-copy">
        <strong title={file.name}>{file.name}</strong>
        <span>
          <b>✓ 已上传</b> · {bytes(file.size)} · 发送时自动附带
        </span>
      </div>
      <button
        type="button"
        className="attachment-remove"
        aria-label={`移除附件 ${file.name}`}
        onClick={onRemove}
      >
        ×
      </button>
    </article>
  );
}

function SentFileCard({
  file,
  projectId,
}: {
  file: UploadedFile;
  projectId: string;
}) {
  const query = new URLSearchParams({ projectId, path: file.path });
  const preview = canPreview(file.name);
  return (
    <article className="message-file-card">
      <a
        className="message-file-main"
        href={`/api/files/${preview ? "preview" : "download"}?${query}`}
        target={preview ? "_blank" : undefined}
        rel={preview ? "noreferrer" : undefined}
      >
        <span className="attachment-icon">{fileMark(file.name)}</span>
        <span>
          <strong title={file.name}>{file.name}</strong>
          <small>
            {bytes(file.size)} · {preview ? "点击预览" : "点击下载"}
          </small>
        </span>
      </a>
      <a
        className="message-file-download"
        href={`/api/files/download?${query}`}
        aria-label={`下载 ${file.name}`}
      >
        ↓
      </a>
    </article>
  );
}

function effortLabel(value: string) {
  return (
    (
      {
        none: "极速",
        low: "较低",
        medium: "标准",
        high: "深入",
        xhigh: "很深入",
        max: "最大",
      } as Record<string, string>
    )[value] ?? value
  );
}

function textFromContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return String(record.text ?? record.inputText ?? record.outputText ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

function executionStep(
  itemValue: unknown,
  completed = false,
): ExecutionStep | undefined {
  if (!itemValue || typeof itemValue !== "object") return;
  const item = itemValue as Record<string, unknown>;
  const type = String(item.type ?? "");
  const id = String(item.id ?? item.itemId ?? crypto.randomUUID());
  const command = Array.isArray(item.command)
    ? item.command.join(" ")
    : String(item.command ?? "");
  const changes = Array.isArray(item.changes)
    ? (item.changes as Array<Record<string, unknown>>)
    : [];
  const fileDetail = changes
    .map((change) => String(change.path ?? ""))
    .filter(Boolean)
    .join("、");
  const labels: Record<string, string> = {
    commandExecution: "执行命令",
    fileChange: "修改文件",
    mcpToolCall: "调用工具",
    webSearch: "搜索资料",
    imageGeneration: "生成图片",
    reasoning: "分析任务",
    dynamicToolCall: "调用扩展工具",
    plan: "更新计划",
  };
  const label = labels[type];
  if (!label) return;
  const exitCode =
    typeof item.exitCode === "number" ? item.exitCode : undefined;
  const status = completed
    ? exitCode !== undefined && exitCode !== 0
      ? "failed"
      : "completed"
    : "running";
  const detail =
    command ||
    fileDetail ||
    String(item.tool ?? item.server ?? item.query ?? "");
  return { id, label, detail: detail || undefined, status };
}

function mergeExecutionStep(
  steps: ExecutionStep[] | undefined,
  step: ExecutionStep,
): ExecutionStep[] {
  const current = steps ?? [];
  const index = current.findIndex((item) => item.id === step.id);
  return index < 0
    ? [...current, step]
    : current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, ...step } : item,
      );
}

function messagesFromThread(value: unknown): ChatMessage[] {
  const root = (value && typeof value === "object" ? value : {}) as Record<
    string,
    unknown
  >;
  const thread = (
    root.thread && typeof root.thread === "object" ? root.thread : root
  ) as Record<string, unknown>;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const result: ChatMessage[] = [];
  for (const turn of turns) {
    const turnStart = result.length;
    let turnSteps: ExecutionStep[] = [];
    const items =
      turn &&
      typeof turn === "object" &&
      Array.isArray((turn as Record<string, unknown>).items)
        ? ((turn as Record<string, unknown>).items as unknown[])
        : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const type = String(record.type ?? "");
      const text =
        String(record.text ?? record.message ?? "") ||
        textFromContent(record.content);
      const step = executionStep(record, true);
      if (step) turnSteps = mergeExecutionStep(turnSteps, step);
      if (!text) continue;
      if (type === "userMessage") {
        const parsed = parseUserMessage(text);
        result.push({
          id: crypto.randomUUID(),
          role: "user",
          text: parsed.text,
          attachments: parsed.attachments,
        });
      }
      if (type === "agentMessage")
        result.push({ id: crypto.randomUUID(), role: "assistant", text });
    }
    if (turnSteps.length) {
      const assistantIndex = result.findLastIndex(
        (message, index) => index >= turnStart && message.role === "assistant",
      );
      if (assistantIndex >= turnStart)
        result[assistantIndex] = {
          ...result[assistantIndex],
          steps: turnSteps,
        };
    }
  }
  return result;
}

export default function Home() {
  const [booting, setBooting] = useState(true);
  const [authenticated, setAuthenticated] = useState(false);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<View>("chat");
  const [projects, setProjects] = useState<Project[]>([]);
  const [models, setModels] = useState<CodexModel[]>([]);
  const [projectId, setProjectId] = useState("default");
  const [threads, setThreads] = useState<ProjectThread[]>([]);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [recordSearch, setRecordSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [searchAllProjects, setSearchAllProjects] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitStatus, setGitStatus] = useState<GitStatus>();
  const [gitBusy, setGitBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>();
  const [fileSearch, setFileSearch] = useState("");
  const [fileKind, setFileKind] = useState<"all" | "inbox" | "outbox">("all");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [focusedMessageId, setFocusedMessageId] = useState<string>();
  const [attachments, setAttachments] = useState<UploadedFile[]>([]);
  const [status, setStatus] = useState<ServerStatus>({});
  const [usageWindows, setUsageWindows] = useState<UsageWindow[]>([]);
  const [usageUpdatedAt, setUsageUpdatedAt] = useState<number>();
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState<OpenMenu>();
  const [projectDialog, setProjectDialog] = useState<ProjectDialog>();
  const [projectDialogBusy, setProjectDialogBusy] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [threadId, setThreadId] = useState<string>();
  const [turnId, setTurnId] = useState<string>();
  const [running, setRunning] = useState(false);
  const [deliveryState, setDeliveryState] = useState<DeliveryState>("idle");
  const [connection, setConnection] = useState<
    "连接中" | "已连接" | "正在重连"
  >("连接中");
  const [notice, setNotice] = useState("");
  const [taskNotices, setTaskNotices] = useState<TaskNotice[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedbacks, setUploadFeedbacks] = useState<UploadFeedback[]>([]);
  const socketRef = useRef<WebSocket | null>(null);
  const threadIdRef = useRef<string>();
  const projectIdRef = useRef(projectId);
  const attachmentsProjectRef = useRef(projectId);
  const projectDialogBusyRef = useRef(false);
  const projectLoadGenerationRef = useRef(0);
  const threadLoadGenerationRef = useRef(0);
  const showArchivedRef = useRef(showArchived);
  const [filesProjectId, setFilesProjectId] = useState(projectId);
  const projectsRef = useRef<Project[]>([]);
  const runningRef = useRef(false);
  const pendingTurnRef = useRef<PendingTurn>();
  const reconnectRef = useRef<number>();
  const reconnectNowRef = useRef<() => void>(() => undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const imageFileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLElement>(null);
  const closeProjectDialog = useCallback(() => {
    if (projectDialogBusyRef.current) return;
    setProjectDialog(undefined);
  }, []);

  const activeProject = projects.find((project) => project.id === projectId);
  const projectReadOnly = Boolean(activeProject?.archivedAt);
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const activeModel =
    models.find((model) => model.model === activeProject?.model) ??
    defaultModel;
  const activeEffort =
    activeProject?.reasoningEffort ?? activeModel?.defaultReasoningEffort ?? "";
  const projectRunningTask = tasks.find((task) => task.status === "running");
  const projectBusy = running || Boolean(projectRunningTask);
  const recentOutputs = files
    .filter((file) => file.path.startsWith("outbox/"))
    .slice(0, 3);
  const recordQuery = recordSearch.trim().toLowerCase();
  const remoteThreadIds = new Set(
    searchResults
      .filter((item) => item.projectId === projectId && item.threadId)
      .map((item) => item.threadId),
  );
  const matchingTasks = tasks.filter(
    (task) =>
      task.title.toLowerCase().includes(recordQuery) ||
      remoteThreadIds.has(task.threadId),
  );
  const matchingThreads = threads.filter(
    (thread) =>
      thread.title.toLowerCase().includes(recordQuery) ||
      remoteThreadIds.has(thread.threadId) ||
      tasks.some(
        (task) =>
          task.threadId === thread.threadId &&
          task.title.toLowerCase().includes(recordQuery),
      ),
  );
  const visibleThreads = showArchived
    ? matchingThreads
    : recordSearch.trim()
      ? matchingThreads
      : matchingThreads.slice(0, 3);
  const matchingFiles = files.filter(
    (file) =>
      (fileKind === "all" || file.path.startsWith(`${fileKind}/`)) &&
      file.name.toLowerCase().includes(fileSearch.trim().toLowerCase()),
  );

  useEffect(() => {
    threadIdRef.current = threadId;
  }, [threadId]);
  useEffect(() => {
    const composer = composerRef.current;
    if (!composer || typeof ResizeObserver === "undefined") return;
    const update = () => {
      document.documentElement.style.setProperty(
        "--composer-height",
        `${Math.ceil(composer.getBoundingClientRect().height)}px`,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(composer);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--composer-height");
    };
  }, [authenticated, view]);
  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  useEffect(() => {
    const closeMenus = (event?: Event) => {
      const target = event?.target;
      if (
        !(target instanceof Element) ||
        !target.closest("[data-popover-root]")
      ) {
        setOpenMenu(undefined);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeMenus();
      setRuntimeOpen(false);
      closeProjectDialog();
    };
    document.addEventListener("pointerdown", closeMenus);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenus);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeProjectDialog]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOpenMenu(undefined);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [projectId]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!authenticated || attachmentsProjectRef.current !== projectId) return;
    const key = pendingAttachmentKey(projectId);
    if (attachments.length) {
      window.localStorage.setItem(key, JSON.stringify(attachments));
    } else {
      window.localStorage.removeItem(key);
    }
  }, [attachments, authenticated, projectId]);
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => {
    const query = recordSearch.trim();
    if (query.length < 2) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      const params = new URLSearchParams({ q: query, projectId });
      if (searchAllProjects) params.set("all", "1");
      try {
        const response = await fetch(`/api/search?${params}`, {
          signal: controller.signal,
        });
        if (response.ok)
          setSearchResults(
            ((await response.json()) as { results: SearchResult[] }).results,
          );
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 320);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [projectId, recordSearch, searchAllProjects]);
  useEffect(() => {
    if (view !== "chat" || !focusedMessageId) return;
    let clearTimer: number | undefined;
    const frame = window.requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(focusedMessageId)}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      if (target)
        clearTimer = window.setTimeout(
          () => setFocusedMessageId(undefined),
          2400,
        );
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (clearTimer) window.clearTimeout(clearTimer);
    };
  }, [focusedMessageId, messages, view]);

  const loadDashboard = useCallback(async () => {
    const [statusResponse, usageResponse] = await Promise.allSettled([
      fetch("/api/status").then((response) =>
        response.ok ? response.json() : Promise.reject(),
      ),
      fetch("/api/usage").then((response) =>
        response.ok ? response.json() : Promise.reject(),
      ),
    ]);
    if (statusResponse.status === "fulfilled")
      setStatus(statusResponse.value as ServerStatus);
    if (usageResponse.status === "fulfilled") {
      const value = usageResponse.value as {
        rateLimits?: unknown;
        usage?: unknown;
      };
      setUsageWindows(usageWindowsFrom(value.rateLimits ?? value.usage));
      setUsageUpdatedAt(Date.now());
    }
  }, []);

  const loadProjects = useCallback(async () => {
    const response = await fetch("/api/projects");
    if (!response.ok) return;
    const body = (await response.json()) as { projects: Project[] };
    setProjects(body.projects);
    if (!body.projects.some((project) => project.id === projectId))
      setProjectId(body.projects[0]?.id ?? "default");
  }, [projectId]);

  const loadModels = useCallback(async (refresh = false) => {
    const response = await fetch(`/api/models${refresh ? "?refresh=1" : ""}`);
    if (!response.ok) {
      setNotice("模型列表暂时不可用，请稍后刷新");
      return;
    }
    setModels(((await response.json()) as { models: CodexModel[] }).models);
  }, []);

  const loadThreads = useCallback(
    async (id: string, archived = showArchivedRef.current) => {
      const generation = ++threadLoadGenerationRef.current;
      const encoded = encodeURIComponent(id);
      const response = await fetch(
        `/api/threads?projectId=${encoded}&archived=${archived ? "1" : "0"}`,
      );
      const loadedThreads = response.ok
        ? ((await response.json()) as { threads: ProjectThread[] }).threads
        : undefined;
      if (
        generation !== threadLoadGenerationRef.current ||
        id !== projectIdRef.current ||
        archived !== showArchivedRef.current
      )
        return [];
      if (loadedThreads) setThreads(loadedThreads);
      return loadedThreads ?? [];
    },
    [],
  );

  const loadProjectCore = useCallback(
    async (id: string): Promise<ProjectTask[]> => {
      const generation = ++projectLoadGenerationRef.current;
      const encoded = encodeURIComponent(id);
      const [taskResponse, fileResponse] = await Promise.all([
        fetch(`/api/tasks?projectId=${encoded}`),
        fetch(`/api/files?projectId=${encoded}`),
      ]);
      let loadedTasks: ProjectTask[] = [];
      if (taskResponse.ok) {
        loadedTasks = ((await taskResponse.json()) as { tasks: ProjectTask[] })
          .tasks;
      }
      const loadedFiles = fileResponse.ok
        ? ((await fileResponse.json()) as { files: UploadedFile[] }).files
        : undefined;
      if (
        generation !== projectLoadGenerationRef.current ||
        id !== projectIdRef.current
      )
        return [];
      if (taskResponse.ok) {
        setTasks(loadedTasks);
        const activeTask = loadedTasks.find(
          (task) =>
            task.threadId === threadIdRef.current && task.status === "running",
        );
        if (activeTask) {
          runningRef.current = true;
          setRunning(true);
          setTurnId(activeTask.turnId);
        } else if (threadIdRef.current) {
          runningRef.current = false;
          setRunning(false);
          setTurnId(undefined);
        }
      }
      if (loadedFiles) {
        setFiles(loadedFiles);
        setFilesProjectId(id);
      }
      return loadedTasks;
    },
    [],
  );

  const loadProjectData = useCallback(
    async (id: string): Promise<ProjectTask[]> => {
      const [loadedTasks] = await Promise.all([
        loadProjectCore(id),
        loadThreads(id),
      ]);
      return loadedTasks;
    },
    [loadProjectCore, loadThreads],
  );

  const refreshThreadMessages = useCallback(
    async (
      targetThreadId: string,
      targetProjectId: string,
      force = false,
      taskRunning = runningRef.current,
    ) => {
      const response = await fetch(
        `/api/threads/${encodeURIComponent(targetThreadId)}?projectId=${encodeURIComponent(targetProjectId)}`,
      ).catch(() => null);
      if (!response?.ok) return false;
      const restored = messagesFromThread(await response.json());
      if (
        !restored.length ||
        threadIdRef.current !== targetThreadId ||
        projectIdRef.current !== targetProjectId
      )
        return false;
      const synced = taskRunning
        ? restored.some((item) => item.role === "assistant")
          ? restored.map((item, index) =>
              index === restored.length - 1 && item.role === "assistant"
                ? { ...item, pending: true }
                : item,
            )
          : [
              ...restored,
              {
                id: crypto.randomUUID(),
                role: "assistant" as const,
                text: "",
                pending: true,
              },
            ]
        : restored;
      setMessages((current) => {
        if (
          !force &&
          (runningRef.current || current.some((item) => item.pending))
        )
          return current;
        const liveAssistant =
          current
            .findLast((item) => item.role === "assistant" && item.text.trim())
            ?.text.trim() ?? "";
        const storedAssistant =
          synced
            .findLast((item) => item.role === "assistant" && item.text.trim())
            ?.text.trim() ?? "";
        const wouldDowngradeLongOutput =
          liveAssistant.length >= 80 &&
          storedAssistant.length < liveAssistant.length &&
          !storedAssistant.includes(liveAssistant);
        return wouldDowngradeLongOutput ? current : synced;
      });
      return true;
    },
    [],
  );

  const handleFinishedTask = useCallback(
    (payload: {
      taskId?: string;
      projectId: string;
      threadId: string;
      status: "completed" | "failed" | "interrupted";
      completedAt?: string;
      projectName?: string;
    }) => {
      const taskId = payload.taskId ?? `${payload.projectId}:${payload.threadId}:${payload.completedAt ?? payload.status}`;
      if (!rememberTaskNotification(taskId)) return;
      try {
        window.PalmNative?.notifyTask?.(
          payload.status,
          payload.projectId,
          payload.threadId,
        );
      } catch {
        /* 原生桥不可用时仍保留网页内通知 */
      }
      if (
        payload.projectId === projectIdRef.current &&
        payload.threadId === threadIdRef.current
      )
        return;
      const projectName =
        payload.projectName ??
        projectsRef.current.find((project) => project.id === payload.projectId)
          ?.name ??
        "其他项目";
      const result =
        payload.status === "completed"
          ? "任务已完成"
          : payload.status === "failed"
            ? "任务执行失败"
            : "任务已停止";
      setTaskNotices((items) => [
        ...items.filter((item) => item.key !== taskId),
        {
          key: taskId,
          projectId: payload.projectId,
          threadId: payload.threadId,
          text: `${projectName} · ${result}`,
        },
      ]);
    },
    [],
  );

  const recoverFinishedTasks = useCallback(async () => {
    const cursor = window.localStorage.getItem(COMPLETION_CURSOR_KEY);
    if (!cursor) {
      window.localStorage.setItem(COMPLETION_CURSOR_KEY, new Date().toISOString());
      return;
    }
    const response = await fetch(
      `/api/tasks/completed?since=${encodeURIComponent(cursor)}`,
    ).catch(() => null);
    if (!response?.ok) return;
    const recovered = ((await response.json()) as {
      tasks: Array<ProjectTask & { projectName: string }>;
    }).tasks;
    recovered
      .sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""))
      .forEach((task) =>
        handleFinishedTask({
          taskId: task.taskId,
          projectId: task.projectId,
          threadId: task.threadId,
          status: task.status as "completed" | "failed" | "interrupted",
          completedAt: task.completedAt,
          projectName: task.projectName,
        }),
      );
    const latest = recovered.at(-1)?.completedAt;
    advanceCompletionCursor(latest);
  }, [handleFinishedTask]);

  useEffect(() => {
    fetch("/api/session")
      .then((response) => response.json())
      .then((data: { authenticated?: boolean }) =>
        setAuthenticated(Boolean(data.authenticated)),
      )
      .catch(() => setNotice("暂时无法连接服务器"))
      .finally(() => setBooting(false));
    if ("serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setTimeout(() => {
      void loadDashboard();
      void loadProjects();
      void loadModels();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [authenticated, loadDashboard, loadModels, loadProjects]);

  useEffect(() => {
    if (!authenticated || !projectId) return;
    projectLoadGenerationRef.current += 1;
    threadLoadGenerationRef.current += 1;
    threadIdRef.current = undefined;
    attachmentsProjectRef.current = projectId;
    const restoredAttachments = readPendingAttachments(projectId);
    const timer = window.setTimeout(() => {
      setThreads([]);
      setTasks([]);
      setFiles([]);
      setFilesProjectId(projectId);
      setDraft(window.localStorage.getItem(`palm:draft:${projectId}`) ?? "");
      runningRef.current = false;
      setGitOpen(false);
      setGitStatus(undefined);
      setGitBusy(false);
      setThreadId(undefined);
      setMessages([]);
      setAttachments(restoredAttachments);
      setUploadFeedbacks([]);
      setRunning(false);
      void loadProjectCore(projectId);
      void loadThreads(projectId, showArchivedRef.current);
      if (restoredAttachments.length) {
        setNotice(`已恢复 ${restoredAttachments.length} 个待发送附件`);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [authenticated, projectId, loadProjectCore, loadThreads]);

  useEffect(() => {
    showArchivedRef.current = showArchived;
    if (!authenticated || !projectId) return;
    void loadThreads(projectId, showArchived);
  }, [authenticated, loadThreads, projectId, showArchived]);

  useEffect(() => {
    if (!pendingNavigation || pendingNavigation.projectId !== projectId) return;
    if (pendingNavigation.view === "files") {
      const timer = window.setTimeout(() => {
        setFileSearch(pendingNavigation.fileSearch ?? "");
        setView("files");
        setPendingNavigation(undefined);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (!pendingNavigation.threadId) return;
    const target = pendingNavigation;
    void fetch(
      `/api/threads/${encodeURIComponent(target.threadId)}?projectId=${encodeURIComponent(target.projectId)}`,
    ).then(async (response) => {
      if (!response.ok) {
        setNotice("无法打开目标任务");
        setPendingNavigation(undefined);
        return;
      }
      const restored = messagesFromThread(await response.json());
      const hint = target.focusHint?.trim().toLowerCase();
      const focused = hint
        ? restored.find((message) => message.text.toLowerCase().includes(hint))
        : restored.at(-1);
      threadIdRef.current = target.threadId;
      setThreadId(target.threadId);
      setMessages(restored);
      setFocusedMessageId(focused?.id);
      setView("chat");
      setPendingNavigation(undefined);
    });
  }, [pendingNavigation, projectId, threads]);

  useEffect(() => {
    if (!authenticated) return;
    let disposed = false;
    const connect = () => {
      setConnection(socketRef.current ? "正在重连" : "连接中");
      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const socketHost =
        location.hostname === "localhost" && location.port === "3000"
          ? `${location.hostname}:4511`
          : location.host;
      const socket = new WebSocket(`${protocol}//${socketHost}/api/ws`);
      socketRef.current = socket;
      socket.onopen = () => {
        setConnection("已连接");
        if (threadIdRef.current) {
          socket.send(
            JSON.stringify({
              type: "thread.subscribe",
              projectId,
              threadId: threadIdRef.current,
            }),
          );
          void refreshThreadMessages(threadIdRef.current, projectId);
        }
        const storedPending = window.localStorage.getItem(
          `palm:pending-turn:${projectId}`,
        );
        if (storedPending) {
          try {
            const pending = JSON.parse(storedPending) as PendingTurn;
            if (pending.projectId === projectId && pending.clientRequestId) {
              pendingTurnRef.current = pending;
              setDeliveryState("sending");
              socket.send(
                JSON.stringify({
                  type: "turn.start",
                  clientRequestId: pending.clientRequestId,
                  projectId: pending.projectId,
                  threadId: pending.threadId,
                  text: pending.text,
                  attachments: pending.attachments.map((file) => file.path),
                }),
              );
            }
          } catch {
            window.localStorage.removeItem(`palm:pending-turn:${projectId}`);
          }
        }
        void loadProjectData(projectId);
        void recoverFinishedTasks();
      };
      reconnectNowRef.current = () => {
        if (
          disposed ||
          socketRef.current?.readyState === WebSocket.OPEN ||
          socketRef.current?.readyState === WebSocket.CONNECTING
        )
          return;
        if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
        connect();
      };
      socket.onclose = () => {
        if (!disposed) {
          setConnection("正在重连");
          reconnectRef.current = window.setTimeout(connect, 1800);
        }
      };
      socket.onmessage = (event) => {
        let message: {
          type: string;
          threadId?: string;
          message?: string;
          operation?: "turn.start" | "turn.interrupt" | "thread.subscribe" | "unknown";
          clientRequestId?: string;
          replayed?: boolean;
          payload?: Record<string, unknown>;
        };
        try {
          message = JSON.parse(event.data) as typeof message;
        } catch {
          setNotice("收到无法识别的服务器消息");
          return;
        }
        if (message.type === "turn.accepted") {
          const pending = pendingTurnRef.current;
          if (
            pending &&
            (!message.clientRequestId ||
              message.clientRequestId === pending.clientRequestId)
          ) {
            window.localStorage.removeItem(
              `palm:pending-turn:${pending.projectId}`,
            );
            pendingTurnRef.current = undefined;
          }
          setDeliveryState("accepted");
          threadIdRef.current = message.threadId;
          setThreadId(message.threadId);
          const turn = (message.payload?.turn ?? {}) as { id?: string };
          if (turn.id) setTurnId(turn.id);
          void loadProjectData(projectId);
          return;
        }
        if (message.type === "error") {
          if (message.operation && message.operation !== "turn.start") {
            setNotice(message.message ?? "操作未能完成");
            return;
          }
          const pending = pendingTurnRef.current;
          if (
            pending &&
            (!message.clientRequestId ||
              message.clientRequestId === pending.clientRequestId)
          ) {
            window.localStorage.removeItem(
              `palm:pending-turn:${pending.projectId}`,
            );
            pendingTurnRef.current = undefined;
          }
          setDeliveryState("idle");
          runningRef.current = false;
          setRunning(false);
          setNotice(message.message ?? "任务执行失败");
          setMessages((items) =>
            items.map((item) =>
              item.pending
                ? {
                    ...item,
                    pending: false,
                    text: item.text || "任务未能完成。",
                  }
                : item,
            ),
          );
          return;
        }
        if (message.type === "codex.offline") {
          runningRef.current = false;
          setConnection("正在重连");
          setRunning(false);
          setNotice("Codex 服务正在恢复连接");
          void loadProjectData(projectIdRef.current);
          return;
        }
        if (message.type === "codex.online") {
          setConnection("已连接");
          setNotice("Codex 服务已恢复");
          void loadProjectData(projectIdRef.current);
          const activeThreadId = threadIdRef.current;
          if (activeThreadId) {
            socket.send(JSON.stringify({
              type: "thread.subscribe",
              projectId: projectIdRef.current,
              threadId: activeThreadId,
            }));
            void refreshThreadMessages(
              activeThreadId,
              projectIdRef.current,
              true,
            );
          }
          return;
        }
        if (message.type === "task.finished") {
          const payload = message.payload as
            | {
              projectId?: string;
              threadId?: string;
              taskId?: string;
              status?: "completed" | "failed" | "interrupted";
              completedAt?: string;
            }
            | undefined;
          if (payload?.projectId && payload.threadId && payload.status) {
            handleFinishedTask({
              taskId: payload.taskId,
              projectId: payload.projectId,
              threadId: payload.threadId,
              status: payload.status,
              completedAt: payload.completedAt,
            });
            if (payload.projectId === projectIdRef.current)
              void loadProjectData(payload.projectId);
            if (payload.threadId === threadIdRef.current) {
              setDeliveryState("idle");
              runningRef.current = false;
              setRunning(false);
              setTurnId(undefined);
            }
          }
          return;
        }
        if (message.type !== "codex.event" || !message.payload) return;
        const rpc = message.payload as {
          method?: string;
          params?: Record<string, unknown>;
        };
        const eventThreadId =
          typeof rpc.params?.threadId === "string"
            ? rpc.params.threadId
            : undefined;
        if (eventThreadId && eventThreadId !== threadIdRef.current) return;
        if (rpc.method === "item/started" || rpc.method === "item/completed") {
          const step = executionStep(
            rpc.params?.item,
            rpc.method === "item/completed",
          );
          if (step)
            setMessages((items) => {
              let updated = false;
              const next = items.map((item) => {
                if (item.role !== "assistant" || !item.pending) return item;
                updated = true;
                return { ...item, steps: mergeExecutionStep(item.steps, step) };
              });
              return updated
                ? next
                : [
                    ...items,
                    {
                      id: crypto.randomUUID(),
                      role: "assistant",
                      text: "",
                      pending: true,
                      steps: [step],
                    },
                  ];
            });
        }
        if (rpc.method === "item/agentMessage/delta") {
          const delta = String(rpc.params?.delta ?? "");
          setMessages((items) => {
            let updated = false;
            const next = items.map((item) => {
              if (!item.pending) return item;
              updated = true;
              return { ...item, text: item.text + delta };
            });
            return updated
              ? next
              : [
                  ...items,
                  {
                    id: crypto.randomUUID(),
                    role: "assistant",
                    text: delta,
                    pending: true,
                  },
                ];
          });
        }
        if (
          ["turn/completed", "turn/failed", "turn/interrupted"].includes(
            String(rpc.method),
          )
        ) {
          const completedThreadId = eventThreadId ?? threadIdRef.current;
          const completedProjectId = projectIdRef.current;
          setDeliveryState("idle");
          runningRef.current = false;
          setRunning(false);
          setTurnId(undefined);
          const terminalText =
            rpc.method === "turn/interrupted"
              ? "任务已停止。"
              : rpc.method === "turn/failed"
                ? "任务执行失败，请在记录中重试。"
                : "";
          setMessages((items) =>
            items.map((item) =>
              item.pending
                ? { ...item, pending: false, text: item.text || terminalText }
                : item,
            ),
          );
          if (terminalText) setNotice(terminalText);
          void loadDashboard();
          void loadProjectData(completedProjectId);
          if (completedThreadId) {
            window.setTimeout(
              () =>
                void refreshThreadMessages(
                  completedThreadId,
                  completedProjectId,
                  true,
                ),
              250,
            );
            window.setTimeout(
              () =>
                void refreshThreadMessages(
                  completedThreadId,
                  completedProjectId,
                  true,
                ),
              1_500,
            );
            window.setTimeout(
              () =>
                void refreshThreadMessages(
                  completedThreadId,
                  completedProjectId,
                  true,
                ),
              4_500,
            );
          }
        }
      };
    };
    connect();
    return () => {
      disposed = true;
      if (reconnectRef.current) window.clearTimeout(reconnectRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [
    authenticated,
    loadDashboard,
    loadProjectData,
    handleFinishedTask,
    projectId,
    recoverFinishedTasks,
    refreshThreadMessages,
  ]);

  useEffect(() => {
    const socket = socketRef.current;
    if (
      !authenticated ||
      !projectId ||
      !threadId ||
      projectIdRef.current !== projectId ||
      threadIdRef.current !== threadId ||
      connection !== "已连接" ||
      socket?.readyState !== WebSocket.OPEN
    )
      return;
    socket.send(
      JSON.stringify({ type: "thread.subscribe", projectId, threadId }),
    );
    void refreshThreadMessages(threadId, projectId);
  }, [authenticated, connection, projectId, refreshThreadMessages, threadId]);

  useEffect(() => {
    if (!authenticated || !projectId) return;
    let syncing = false;
    const syncVisibleView = async () => {
      if (document.visibilityState !== "visible") return;
      if (syncing) return;
      syncing = true;
      if (socketRef.current?.readyState !== WebSocket.OPEN) {
        try {
          socketRef.current?.close();
        } catch {}
        reconnectNowRef.current();
      }
      void loadDashboard();
      const activeThreadId = threadIdRef.current;
      try {
        const loadedTasks = await loadProjectData(projectId);
        if (activeThreadId) {
          const taskStillRunning = loadedTasks.some(
            (task) =>
              task.threadId === activeThreadId && task.status === "running",
          );
          await refreshThreadMessages(
            activeThreadId,
            projectId,
            true,
            taskStillRunning,
          );
        }
      } finally {
        syncing = false;
      }
    };
    const resumeVisibleView = () => {
      void recoverFinishedTasks();
      void syncVisibleView();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") resumeVisibleView();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", resumeVisibleView);
    window.addEventListener("online", resumeVisibleView);
    window.addEventListener("pageshow", resumeVisibleView);
    window.addEventListener("palm-resume", resumeVisibleView);
    const timer = window.setInterval(syncVisibleView, 4_000);
    const recoveryTimer = window.setInterval(recoverFinishedTasks, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", resumeVisibleView);
      window.removeEventListener("online", resumeVisibleView);
      window.removeEventListener("pageshow", resumeVisibleView);
      window.removeEventListener("palm-resume", resumeVisibleView);
      window.clearInterval(timer);
      window.clearInterval(recoveryTimer);
    };
  }, [
    authenticated,
    loadDashboard,
    loadProjectData,
    projectId,
    recoverFinishedTasks,
    refreshThreadMessages,
  ]);

  useEffect(() => {
    if (!authenticated) return;
    const rememberTarget = (event: Event) => {
      const detail =
        (event as CustomEvent<{ projectId?: string; threadId?: string }>)
          .detail ?? window.__PALM_OPEN_TASK__;
      if (!detail?.projectId || !detail.threadId) return;
      window.localStorage.setItem("palm:open-task", JSON.stringify(detail));
      window.__PALM_OPEN_TASK__ = undefined;
      window.PalmNative?.ackTaskTarget?.();
      setPendingNavigation({
        projectId: detail.projectId,
        threadId: detail.threadId,
        view: "chat",
      });
      setShowArchived(false);
      setProjectId(detail.projectId);
      setView("chat");
    };
    window.addEventListener("palm-open-task", rememberTarget);
    if (window.__PALM_OPEN_TASK__)
      rememberTarget(
        new CustomEvent("palm-open-task", {
          detail: window.__PALM_OPEN_TASK__,
        }),
      );
    return () => window.removeEventListener("palm-open-task", rememberTarget);
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated || showArchived) return;
    const stored = window.localStorage.getItem("palm:open-task");
    if (!stored) return;
    try {
      const target = JSON.parse(stored) as {
        projectId?: string;
        threadId?: string;
      };
      if (target.projectId !== projectId || !target.threadId) return;
      const thread = threads.find((item) => item.threadId === target.threadId);
      if (!thread) return;
      window.localStorage.removeItem("palm:open-task");
      void fetch(
        `/api/threads/${encodeURIComponent(thread.threadId)}?projectId=${encodeURIComponent(projectId)}`,
      ).then(async (response) => {
        if (!response.ok) {
          setNotice("无法打开通知对应的任务");
          return;
        }
        const restored = messagesFromThread(await response.json());
        setThreadId(thread.threadId);
        setMessages(restored);
        setFocusedMessageId(restored.at(-1)?.id);
        setView("chat");
      });
    } catch {
      window.localStorage.removeItem("palm:open-task");
    }
  }, [authenticated, projectId, showArchived, threads]);

  function openTaskNotice(taskNotice: TaskNotice) {
    setPendingNavigation({
      projectId: taskNotice.projectId,
      threadId: taskNotice.threadId,
      view: "chat",
    });
    setShowArchived(false);
    setProjectId(taskNotice.projectId);
    setView("chat");
    setTaskNotices((items) => items.filter((item) => item !== taskNotice));
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    setLoginError("");
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }).catch(() => null);
    if (!response?.ok) {
      const body = response
        ? ((await response.json().catch(() => ({}))) as { error?: string })
        : {};
      setLoginError(body.error ?? "无法连接服务器");
      return;
    }
    setPassword("");
    setNotice("");
    setAuthenticated(true);
  }

  function newConversation() {
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再新建任务");
      return;
    }
    if (projectBusy) {
      setNotice("请先停止当前执行再新建任务");
      return;
    }
    setThreadId(undefined);
    setMessages([]);
    setAttachments([]);
    setUploadFeedbacks([]);
    setView("chat");
  }

  async function createProject(name: string) {
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    const body = (await response.json()) as {
      project?: Project;
      error?: string;
    };
    if (!response.ok || !body.project) {
      setNotice(body.error ?? "项目创建失败");
      return false;
    }
    await loadProjects();
    setProjectId(body.project.id);
    setView("chat");
    return true;
  }

  async function renameProject(name: string) {
    if (!activeProject) return false;
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再重命名");
      return false;
    }
    if (!name.trim() || name.trim() === activeProject.name) return true;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(activeProject.id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      },
    );
    const body = (await response.json()) as {
      project?: Project;
      error?: string;
    };
    if (!response.ok || !body.project) {
      setNotice(body.error ?? "项目重命名失败");
      return false;
    }
    setProjects((items) =>
      items.map((item) => (item.id === body.project?.id ? body.project : item)),
    );
    setNotice("项目名称已更新");
    return true;
  }

  async function importGitHubProject(url: string, name: string) {
    setNotice("正在从 GitHub 导入项目…");
    const response = await fetch("/api/projects/github", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), url: url.trim() }),
    });
    const body = (await response.json()) as {
      project?: Project;
      error?: string;
    };
    if (!response.ok || !body.project) {
      setNotice(body.error ?? "GitHub 导入失败");
      return false;
    }
    await loadProjects();
    setProjectId(body.project.id);
    setNotice(body.error ?? "GitHub 项目已导入");
    return true;
  }

  async function duplicateProject(name: string) {
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再复制");
      return false;
    }
    if (projectBusy) {
      setNotice("Codex 正在处理任务，暂时不能复制项目");
      return false;
    }
    if (!activeProject) return false;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/duplicate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      },
    );
    const body = (await response.json()) as {
      project?: Project;
      error?: string;
    };
    if (!response.ok || !body.project) {
      setNotice(body.error ?? "项目复制失败");
      return false;
    }
    await loadProjects();
    setProjectId(body.project.id);
    setNotice("项目已复制，Git 历史未复制");
    return true;
  }

  function openProjectDialog(mode: ProjectDialog["mode"]) {
    setOpenMenu(undefined);
    if (mode === "rename")
      setProjectDialog({ mode, name: activeProject?.name ?? "" });
    else if (mode === "duplicate")
      setProjectDialog({ mode, name: `${activeProject?.name ?? "项目"} 副本` });
    else if (mode === "github")
      setProjectDialog({ mode, name: "", url: "" });
    else setProjectDialog({ mode, name: "" });
  }

  async function submitProjectDialog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (projectDialogBusyRef.current || projectDialogBusy) return;
    if (!projectDialog || !projectDialog.name.trim()) return;
    if (projectDialog.mode === "github" && !projectDialog.url?.trim()) return;
    projectDialogBusyRef.current = true;
    setProjectDialogBusy(true);
    try {
      const succeeded =
        projectDialog.mode === "create"
          ? await createProject(projectDialog.name)
          : projectDialog.mode === "rename"
            ? await renameProject(projectDialog.name)
            : projectDialog.mode === "duplicate"
              ? await duplicateProject(projectDialog.name)
              : await importGitHubProject(
                  projectDialog.url ?? "",
                  projectDialog.name,
                );
      if (succeeded) setProjectDialog(undefined);
    } finally {
      projectDialogBusyRef.current = false;
      setProjectDialogBusy(false);
    }
  }

  async function toggleProjectArchive() {
    if (!activeProject) return;
    const archived = !activeProject.archivedAt;
    if (
      archived &&
      !window.confirm(`归档项目“${activeProject.name}”？文件不会删除。`)
    )
      return;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived }),
      },
    );
    const body = (await response.json()) as {
      project?: Project;
      error?: string;
    };
    if (!response.ok || !body.project) {
      setNotice(body.error ?? "项目归档失败");
      return;
    }
    setProjects((items) =>
      items.map((item) => (item.id === body.project?.id ? body.project : item)),
    );
    setNotice(archived ? "项目已归档，文件仍完整保留" : "项目已恢复");
  }

  async function loadGitStatus(open = true) {
    if (open) setGitOpen(true);
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/git`,
    );
    const body = (await response.json()) as GitStatus;
    setGitStatus(
      response.ok
        ? { ...body, projectId }
        : {
            projectId,
            repository: false,
            changes: [],
            error: (body as { error?: string }).error ?? "Git 状态读取失败",
          },
    );
  }

  async function openGitReview() {
    setView("history");
    setGitOpen(true);
    await loadGitStatus(false);
  }

  async function runGitAction(
    action: "pull" | "push" | "commit" | "discard",
    filePath?: string,
  ) {
    if (projectReadOnly) {
      setNotice("项目已归档，代码变更仅供查看");
      return;
    }
    if (projectBusy) {
      setNotice("Codex 正在处理任务，暂时禁止 Git 写操作");
      return;
    }
    if (!gitStatus || gitStatus.projectId !== projectId) {
      setGitOpen(false);
      setGitStatus(undefined);
      setNotice("项目已切换，请重新打开代码变更");
      return;
    }
    const message = action === "commit" ? window.prompt("提交说明") : undefined;
    if (action === "commit" && !message?.trim()) return;
    if (
      (action === "push" || action === "pull") &&
      !window.confirm(`确认执行 git ${action}？`)
    )
      return;
    if (
      action === "discard" &&
      (!filePath || !window.confirm(`撤销 ${filePath} 的未暂存修改？`))
    )
      return;
    setGitBusy(true);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectId)}/git`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ...(message ? { message: message.trim() } : {}),
            ...(filePath ? { path: filePath } : {}),
          }),
        },
      );
      const body = (await response.json()) as {
        error?: string;
        output?: string;
      };
      setNotice(
        response.ok
          ? body.output || `git ${action} 已完成`
          : (body.error ?? `git ${action} 失败`),
      );
      await loadGitStatus(false);
    } finally {
      setGitBusy(false);
    }
  }

  async function updateThread(
    item: ProjectThread,
    update: { title?: string; archived?: boolean; favorite?: boolean },
  ) {
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再修改任务");
      return;
    }
    if (
      update.archived === true &&
      tasks.some(
        (task) => task.threadId === item.threadId && task.status === "running",
      )
    ) {
      setNotice("当前任务仍在执行，请先停止执行");
      return;
    }
    const response = await fetch(
      `/api/threads/${encodeURIComponent(item.threadId)}?projectId=${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      },
    );
    const body = (await response.json().catch(() => ({}))) as {
      thread?: ProjectThread;
      error?: string;
    };
    if (!response.ok) {
      setNotice(body.error ?? "任务更新失败");
      return;
    }
    await loadProjectData(projectId);
    setNotice(
      update.archived === true
        ? "任务已归档"
        : update.archived === false
          ? "任务已恢复"
          : "任务名称已更新",
    );
  }

  async function renameThread(item: ProjectThread) {
    const title = window.prompt("修改任务名称", item.title);
    if (!title?.trim() || title.trim() === item.title) return;
    await updateThread(item, { title: title.trim() });
  }

  async function deleteThread(item: ProjectThread) {
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再删除任务");
      return;
    }
    if (
      tasks.some(
        (task) => task.threadId === item.threadId && task.status === "running",
      )
    ) {
      setNotice("当前任务仍在执行，请先停止执行");
      return;
    }
    if (
      !window.confirm(
        `从掌心助理记录中删除“${item.title}”？服务器文件和 Codex 原始会话不会被删除。`,
      )
    )
      return;
    const response = await fetch(
      `/api/threads/${encodeURIComponent(item.threadId)}?projectId=${encodeURIComponent(projectId)}`,
      { method: "DELETE" },
    );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      setNotice(body.error ?? "任务删除失败");
      return;
    }
    if (threadId === item.threadId) newConversation();
    await loadProjectData(projectId);
    setNotice("任务记录已删除");
  }

  async function saveModel(modelName: string, reasoningEffort?: string) {
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再切换模型");
      return;
    }
    const model = models.find((item) => item.model === modelName);
    if (!model) return;
    const effort =
      reasoningEffort &&
      model.supportedReasoningEfforts.some(
        (item) => item.reasoningEffort === reasoningEffort,
      )
        ? reasoningEffort
        : model.defaultReasoningEffort;
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/model`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.model, reasoningEffort: effort }),
      },
    );
    const body = (await response.json()) as {
      project?: Project;
      error?: string;
    };
    if (!response.ok || !body.project) {
      setNotice(body.error ?? "模型切换失败");
      return;
    }
    setProjects((items) =>
      items.map((item) => (item.id === body.project?.id ? body.project : item)),
    );
    setNotice(`已切换到 ${model.displayName} · ${effort}`);
  }

  async function openThreadById(
    targetProjectId: string,
    targetThreadId: string,
    focusHint = "",
  ) {
    if (targetProjectId !== projectId) {
      setPendingNavigation({
        projectId: targetProjectId,
        threadId: targetThreadId,
        focusHint,
        view: "chat",
      });
      setShowArchived(false);
      setProjectId(targetProjectId);
      return;
    }
    const response = await fetch(
      `/api/threads/${encodeURIComponent(targetThreadId)}?projectId=${encodeURIComponent(targetProjectId)}`,
    );
    if (!response.ok) {
      setNotice("读取任务失败");
      return;
    }
    const restored = messagesFromThread(await response.json());
    const hint = focusHint.trim().toLowerCase();
    const focused =
      (hint
        ? [...restored]
            .reverse()
            .find(
              (message) =>
                message.role === "user" &&
                (message.text.trim().toLowerCase() === hint ||
                  message.text.toLowerCase().includes(hint)),
            )
        : undefined) ??
      [...restored].reverse().find((message) => message.role === "user") ??
      restored.at(-1);
    setThreadId(targetThreadId);
    setMessages(restored);
    setFocusedMessageId(focused?.id);
    setView("chat");
    if (!restored.length)
      setNotice("已恢复任务上下文；旧消息格式暂无法完整展示");
  }

  async function openThread(item: ProjectThread, focusHint = item.title) {
    await openThreadById(projectId, item.threadId, focusHint);
  }

  async function openSearchResult(result: SearchResult) {
    if (result.kind === "file") {
      if (result.projectId === projectId) {
        setFileSearch(result.title);
        setView("files");
      } else {
        setPendingNavigation({
          projectId: result.projectId,
          view: "files",
          fileSearch: result.title,
        });
        setProjectId(result.projectId);
      }
      return;
    }
    if (!result.threadId) return;
    if (result.projectId !== projectId) {
      setPendingNavigation({
        projectId: result.projectId,
        threadId: result.threadId,
        focusHint: recordSearch,
        view: "chat",
      });
      setProjectId(result.projectId);
      return;
    }
    const response = await fetch(
      `/api/threads/${encodeURIComponent(result.threadId)}?projectId=${encodeURIComponent(result.projectId)}`,
    );
    if (!response.ok) {
      setNotice("读取搜索结果失败");
      return;
    }
    const restored = messagesFromThread(await response.json());
    const hint = recordSearch.trim().toLowerCase();
    const focused =
      restored.find((message) => message.text.toLowerCase().includes(hint)) ??
      restored.at(-1);
    setProjectId(result.projectId);
    setThreadId(result.threadId);
    setMessages(restored);
    setFocusedMessageId(focused?.id);
    setView("chat");
  }

  function startTurn(
    text: string,
    sentAttachments: UploadedFile[],
    targetThreadId = threadId,
  ) {
    if (activeProject?.archivedAt) {
      setNotice("项目已归档，请先恢复后再执行任务");
      return;
    }
    if (projectRunningTask && projectRunningTask.threadId !== targetThreadId) {
      setNotice("当前项目已有任务正在运行，请等待完成后再开始新任务");
      return;
    }
    if (
      !text ||
      projectBusy ||
      socketRef.current?.readyState !== WebSocket.OPEN
    )
      return;
    const now = crypto.randomUUID();
    setMessages((items) => [
      ...items,
      { id: `${now}-u`, role: "user", text, attachments: sentAttachments },
      { id: `${now}-a`, role: "assistant", text: "", pending: true },
    ]);
    const pending: PendingTurn = {
      clientRequestId: crypto.randomUUID(),
      projectId,
      threadId: targetThreadId,
      text,
      attachments: sentAttachments,
    };
    pendingTurnRef.current = pending;
    window.localStorage.setItem(
      `palm:pending-turn:${projectId}`,
      JSON.stringify(pending),
    );
    setDeliveryState("sending");
    socketRef.current.send(
      JSON.stringify({
        type: "turn.start",
        clientRequestId: pending.clientRequestId,
        projectId,
        threadId: targetThreadId,
        text,
        attachments: sentAttachments.map((file) => file.path),
      }),
    );
    runningRef.current = true;
    setDraft("");
    window.localStorage.removeItem(`palm:draft:${projectId}`);
    setAttachments([]);
    setRunning(true);
    setNotice("");
  }

  function sendTask(event: FormEvent) {
    event.preventDefault();
    const text =
      draft.trim() || (attachments.length ? "请检查并处理我上传的附件。" : "");
    startTurn(text, attachments);
  }

  async function retryTask(task: ProjectTask) {
    if (projectBusy || socketRef.current?.readyState !== WebSocket.OPEN) {
      setNotice("请等待连接恢复或先停止当前任务");
      return;
    }
    await openThreadById(task.projectId, task.threadId, task.title);
    if (task.projectId !== projectId) return;
    const retryAttachments = (task.attachments ?? []).map(
      (attachmentPath) =>
        files.find((file) => file.path === attachmentPath) ?? {
          path: attachmentPath,
          name: displayFileName(
            attachmentPath.split("/").pop() ?? attachmentPath,
          ),
          size: undefined,
        },
    );
    startTurn(task.title, retryAttachments, task.threadId);
  }

  const mobileConnection =
    connection === "已连接"
      ? "在线"
      : connection === "正在重连"
        ? "重连"
        : "连接";

  const upload = useCallback(
    async (
      file?: File,
      existingUploadId?: string,
      manageBusy = true,
    ): Promise<boolean> => {
      if (!file || (uploading && manageBusy)) return false;
      const uploadId = existingUploadId ?? crypto.randomUUID();
      const updateFeedback = (
        next: UploadFeedback | ((current: UploadFeedback) => UploadFeedback),
      ) =>
        setUploadFeedbacks((items) => {
          const existing = items.find((item) => item.uploadId === uploadId);
          const value =
            typeof next === "function"
              ? next(
                  existing ?? {
                    uploadId,
                    file,
                    progress: 0,
                    status: "uploading",
                    retryable: true,
                  },
                )
              : next;
          return existing
            ? items.map((item) => (item.uploadId === uploadId ? value : item))
            : [...items, value];
        });
      if (file.size > SAFE_UPLOAD_BYTES) {
        updateFeedback({
          uploadId,
          file,
          progress: 0,
          status: "error",
          message: "文件超过公网安全上限 95MB",
          retryable: false,
        });
        return false;
      }
      const url = `/api/files/upload?projectId=${encodeURIComponent(projectId)}`;
      setNotice("");
      if (manageBusy) setUploading(true);
      updateFeedback({
        uploadId,
        file,
        progress: 0,
        status: "uploading",
        retryable: true,
      });
      try {
        let result: UploadResponse = { status: 0 };
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          updateFeedback((current) => ({
            ...current,
            status: attempt === 1 ? "uploading" : "retrying",
          }));
          result =
            file.size > 8 * 1024 * 1024
              ? await uploadChunked(file, projectId, uploadId, (progress) =>
                  updateFeedback((current) => ({
                    ...current,
                    progress,
                    status: "uploading",
                  })),
                )
              : await uploadOnce(file, url, uploadId, (progress) =>
                  updateFeedback((current) => ({
                    ...current,
                    progress,
                    status: "uploading",
                  })),
                );
          if (
            result.status >= 200 &&
            result.status < 300 &&
            result.body?.file
          ) {
            const saved = result.body.file;
            setAttachments((items) =>
              items.some((item) => item.path === saved.path)
                ? items
                : [...items, saved],
            );
            if (projectIdRef.current === projectId) {
              setFilesProjectId(projectId);
              setFiles((items) =>
                items.some((item) => item.path === saved.path)
                  ? items
                  : [saved, ...items],
              );
            }
            updateFeedback((current) => ({
              ...current,
              progress: 100,
              status: "success",
              retryable: false,
            }));
            window.setTimeout(
              () =>
                setUploadFeedbacks((items) =>
                  items.filter((item) => item.uploadId !== uploadId),
                ),
              4500,
            );
            setNotice("附件已添加到当前任务");
            return true;
          }
          const retryable =
            result.status === 0 ||
            result.status === 408 ||
            result.status === 429 ||
            result.status >= 500;
          if (!retryable || attempt === 3) break;
          updateFeedback((current) => ({
            ...current,
            status: "retrying",
            message: `第 ${attempt} 次重试`,
          }));
          await new Promise((resolve) =>
            window.setTimeout(resolve, attempt * 1200),
          );
        }
        updateFeedback({
          uploadId,
          file,
          progress: 0,
          status: "error",
          message: uploadErrorMessage(result),
          retryable: result.status !== 413 && result.status !== 507,
        });
        if (
          file.size > 8 * 1024 * 1024 &&
          result.status > 0 &&
          ![408, 409, 429, 500, 502, 503, 504, 507].includes(result.status)
        )
          await abortChunkUpload(file, projectId, uploadId);
        return false;
      } finally {
        if (manageBusy) setUploading(false);
      }
    },
    [projectId, uploading],
  );

  const uploadFiles = useCallback(
    async (fileList?: FileList | File[] | null) => {
      if (!fileList?.length || uploading) return;
      if (activeProject?.archivedAt) {
        setNotice("项目已归档，请先恢复后再上传");
        return;
      }
      const selected = Array.from(fileList).slice(0, 10);
      if (fileList.length > 10)
        setNotice("一次最多上传 10 个文件，已处理前 10 个");
      setUploading(true);
      let completed = 0;
      try {
        for (const file of selected)
          if (await upload(file, undefined, false)) completed += 1;
      } finally {
        setUploading(false);
      }
      setNotice(
        completed === selected.length
          ? `已上传 ${completed} 个文件并添加到当前任务`
          : `已上传 ${completed}/${selected.length} 个文件；失败项可单独重试`,
      );
    },
    [activeProject?.archivedAt, upload, uploading],
  );

  useEffect(() => {
    if (!authenticated) return;
    let consuming = false;
    const consumeSharedFiles = async (event?: Event) => {
      if (consuming) return;
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      const shared = (
        Array.isArray(detail) ? detail : window.__PALM_SHARED_FILES__
      ) as NativeSharedFile[] | undefined;
      if (!shared?.length) return;
      consuming = true;
      window.__PALM_SHARED_FILES__ = [];
      setView("chat");
      setNotice(`正在接收外部分享的 ${shared.length} 个文件…`);
      try {
        const imported: File[] = [];
        for (const item of shared.slice(0, 10)) {
          const response = await fetch(
            `/__native_share/${encodeURIComponent(item.id)}`,
          );
          if (!response.ok) throw new Error(`无法读取 ${item.name}`);
          const blob = await response.blob();
          imported.push(
            new File([blob], item.name, {
              type: item.mimeType || blob.type || "application/octet-stream",
            }),
          );
        }
        await uploadFiles(imported);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "接收外部分享文件失败，请重试",
        );
      } finally {
        consuming = false;
      }
    };
    const listener = (event: Event) => {
      void consumeSharedFiles(event);
    };
    const errorListener = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : undefined;
      setNotice(
        typeof detail === "string" && detail
          ? detail
          : "接收外部分享文件失败，请重试",
      );
    };
    window.addEventListener("palm-share", listener);
    window.addEventListener("palm-share-error", errorListener);
    void consumeSharedFiles();
    return () => {
      window.removeEventListener("palm-share", listener);
      window.removeEventListener("palm-share-error", errorListener);
    };
  }, [authenticated, projectId, uploadFiles]);

  function dragEnter(event: DragEvent<HTMLElement>) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDraggingFiles(true);
  }

  function dragLeave(event: DragEvent<HTMLElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null))
      return;
    setDraggingFiles(false);
  }

  function dropFiles(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDraggingFiles(false);
    if (event.dataTransfer.files.length)
      void uploadFiles(event.dataTransfer.files);
  }

  function taskStatusLabel(status: ProjectTask["status"]) {
    return (
      {
        running: "执行中",
        completed: "已完成",
        failed: "失败",
        interrupted: "已停止",
      } as const
    )[status];
  }

  async function copyMessage(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("回复已复制");
    } catch {
      setNotice("复制失败，请长按文字选择复制");
    }
  }

  async function deleteFile(file: UploadedFile) {
    if (projectReadOnly) {
      setNotice("项目已归档，请先恢复后再删除文件");
      return;
    }
    if (filesProjectId !== projectId) {
      setNotice("项目刚刚切换，请等待文件列表刷新后再删除");
      return;
    }
    if (!window.confirm(`删除 ${file.name}？`)) return;
    const requestProjectId = filesProjectId;
    const query = new URLSearchParams({ projectId: requestProjectId, path: file.path });
    const response = await fetch(`/api/files?${query}`, { method: "DELETE" });
    if (response.ok) {
      setFiles((items) => items.filter((item) => item.path !== file.path));
      setAttachments((items) =>
        items.filter((item) => item.path !== file.path),
      );
    } else setNotice("文件删除失败");
  }

  function interrupt() {
    if (
      !threadId ||
      !turnId ||
      socketRef.current?.readyState !== WebSocket.OPEN
    )
      return;
    socketRef.current.send(
      JSON.stringify({ type: "turn.interrupt", threadId, turnId }),
    );
  }

  if (booting)
    return (
      <main className="splash">
        <div className="brand-mark">掌</div>
        <p>正在唤醒助理…</p>
      </main>
    );
  if (!authenticated)
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="login-seal">掌</div>
          <p className="eyebrow">私人空间</p>
          <h1>掌心助理</h1>
          <p className="login-intro">从手机安全访问服务器上的 Codex。</p>
          <form onSubmit={login}>
            <label htmlFor="password">访问密码</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
            {loginError && (
              <p className="form-error" role="alert">
                {loginError}
              </p>
            )}
            <button type="submit" disabled={!password}>
              进入工作台
            </button>
          </form>
          <p className="privacy-note">仅允许通过你的受保护域名访问</p>
        </section>
      </main>
    );

  return (
    <main className="app-shell">
      {view === "chat" && threadId && (
        <a
          className="thread-export-floating"
          href={`/api/threads/${encodeURIComponent(threadId)}/export?projectId=${encodeURIComponent(projectId)}`}
          aria-label="导出当前任务"
        >
          <Export size={16} weight="bold" />
          <span>导出</span>
        </a>
      )}
      <aside className="desktop-rail" aria-label="主导航">
        <div className="rail-brand">
          <div className="brand-mark">掌</div>
          <strong>掌心</strong>
        </div>
        <nav>
          <button
            className={`rail-button ${view === "chat" ? "active" : ""}`}
            aria-label="任务"
            onClick={() => setView("chat")}
          >
            <ChatCircleDots
              size={21}
              weight={view === "chat" ? "fill" : "regular"}
            />
            <span>任务</span>
          </button>
          <button
            className={`rail-button ${view === "history" ? "active" : ""}`}
            aria-label="任务记录"
            onClick={() => setView("history")}
          >
            <ClockCounterClockwise
              size={21}
              weight={view === "history" ? "fill" : "regular"}
            />
            <span>历史</span>
          </button>
          <button
            className={`rail-button ${view === "files" ? "active" : ""}`}
            aria-label="文件中心"
            onClick={() => setView("files")}
          >
            <FolderOpen
              size={21}
              weight={view === "files" ? "fill" : "regular"}
            />
            <span>文件</span>
          </button>
        </nav>
        <button
          className="rail-avatar"
          aria-label="退出登录"
          onClick={() =>
            void fetch("/api/auth/logout", { method: "POST" }).then(() =>
              setAuthenticated(false),
            )
          }
        >
          <SignOut size={20} />
          <span>退出</span>
        </button>
      </aside>
      <section
        className={`conversation ${draggingFiles ? "drag-active" : ""}`}
        onDragEnter={dragEnter}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files"))
            event.preventDefault();
        }}
        onDragLeave={dragLeave}
        onDrop={dropFiles}
      >
        {draggingFiles && (
          <div className="drop-overlay" role="status">
            <div>
              <span>
                <UploadSimple size={28} weight="bold" />
              </span>
              <strong>拖到这里上传</strong>
              <small>文件会加入当前项目和本次任务</small>
            </div>
          </div>
        )}
        <header className="topbar">
          <div className="identity">
            <span className="mobile-identity" aria-label={`Codex ${connection}`}>
              <b>掌</b>
              <small className={connection === "已连接" ? "online" : "offline"}>
                <i /> {mobileConnection}
              </small>
            </span>
            <div>
              <h1>掌心助理</h1>
              <p>
                <span
                  className={
                    connection === "已连接" ? "online-dot" : "offline-dot"
                  }
                />{" "}
                Codex {connection}
              </p>
            </div>
          </div>
          <div className="header-actions">
            <div className="project-picker" data-popover-root>
              <button
                type="button"
                className="project-picker-trigger"
                aria-label="选择项目"
                aria-haspopup="listbox"
                aria-expanded={openMenu === "project-picker"}
                disabled={uploading}
                onClick={() => {
                  setRuntimeOpen(false);
                  setOpenMenu((current) =>
                    current === "project-picker" ? undefined : "project-picker",
                  );
                }}
              >
                <span>{activeProject?.name ?? "选择项目"}</span>
                <CaretDown size={14} weight="bold" />
              </button>
              {openMenu === "project-picker" && (
                <div className="project-picker-menu" role="listbox">
                  {projects.map((project) => (
                    <button
                      type="button"
                      role="option"
                      aria-selected={project.id === projectId}
                      key={project.id}
                      onClick={() => {
                        const pendingCount = attachments.length;
                        setProjectId(project.id);
                        setOpenMenu(undefined);
                        if (pendingCount && project.id !== projectId) {
                          setNotice(
                            `已为 ${activeProject?.name ?? "当前项目"} 保留 ${pendingCount} 个待发送附件`,
                          );
                        }
                      }}
                    >
                      <span>{project.name}</span>
                      {project.archivedAt && <small>已归档</small>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="project-add"
              onClick={newConversation}
              aria-label="新任务"
              disabled={uploading || projectBusy || projectReadOnly}
            >
              <Plus size={16} weight="bold" />
              <span>新任务</span>
            </button>
            <div className="project-menu header-project-menu" data-popover-root>
              <button
                type="button"
                className="menu-trigger"
                aria-label="项目操作"
                aria-haspopup="menu"
                aria-expanded={openMenu === "project-actions"}
                onClick={() => {
                  setRuntimeOpen(false);
                  setOpenMenu((current) =>
                    current === "project-actions" ? undefined : "project-actions",
                  );
                }}
              >
                <DotsThree size={22} weight="bold" />
              </button>
              {openMenu === "project-actions" && <div role="menu">
                <button onClick={() => openProjectDialog("create")}>
                  <Plus size={17} weight="bold" />
                  新建项目
                </button>
                <button onClick={() => openProjectDialog("github")}>
                  <GithubLogo size={17} />
                  GitHub 导入
                </button>
                <button onClick={() => {
                  setOpenMenu(undefined);
                  void openGitReview();
                }}>
                  <GitDiff size={17} />
                  代码变更
                </button>
                <button
                  disabled={projectBusy || projectReadOnly}
                  onClick={() => openProjectDialog("duplicate")}
                >
                  <Copy size={17} />
                  复制项目
                </button>
                <button
                  disabled={projectBusy && !activeProject?.archivedAt}
                  onClick={() => {
                    setOpenMenu(undefined);
                    void toggleProjectArchive();
                  }}
                >
                  <Archive size={17} />
                  {activeProject?.archivedAt ? "恢复项目" : "归档项目"}
                </button>
                <button
                  disabled={projectReadOnly}
                  onClick={() => openProjectDialog("rename")}
                >
                  <PencilSimple size={17} />
                  重命名
                </button>
                <button
                  className="mobile-menu-only"
                  onClick={() => {
                    setOpenMenu(undefined);
                    setRuntimeOpen((open) => !open);
                  }}
                >
                  <SlidersHorizontal size={17} />
                  运行设置
                </button>
              </div>}
            </div>
            <button
              className={`runtime-toggle ${runtimeOpen ? "active" : ""}`}
              aria-label="运行设置"
              aria-expanded={runtimeOpen}
              onClick={() => {
                setOpenMenu(undefined);
                setRuntimeOpen((open) => !open);
              }}
            >
              <SlidersHorizontal size={19} />
            </button>
          </div>
        </header>
        <nav className="mobile-tabs">
          <button
            className={view === "chat" ? "active" : ""}
            onClick={() => setView("chat")}
          >
            <ChatCircleDots
              size={18}
              weight={view === "chat" ? "fill" : "regular"}
            />
            <span>任务</span>
          </button>
          <button
            className={view === "history" ? "active" : ""}
            onClick={() => setView("history")}
          >
            <ClockCounterClockwise
              size={18}
              weight={view === "history" ? "fill" : "regular"}
            />
            <span>历史</span>
          </button>
          <button
            className={view === "files" ? "active" : ""}
            onClick={() => setView("files")}
          >
            <FolderOpen
              size={18}
              weight={view === "files" ? "fill" : "regular"}
            />
            <span>文件</span>
          </button>
        </nav>
        {projectDialog && (
          <div
            className="dialog-backdrop"
            role="presentation"
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) closeProjectDialog();
            }}
          >
            <form
              className="project-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="project-dialog-title"
              onSubmit={submitProjectDialog}
            >
              <header>
                <div>
                  <small>项目工作区</small>
                  <h2 id="project-dialog-title">
                    {projectDialog.mode === "create"
                      ? "新建项目"
                      : projectDialog.mode === "rename"
                        ? "重命名项目"
                        : projectDialog.mode === "duplicate"
                          ? "复制项目"
                          : "从 GitHub 导入"}
                  </h2>
                </div>
                <button
                  type="button"
                  aria-label="关闭"
                  disabled={projectDialogBusy}
                  onClick={closeProjectDialog}
                >
                  <X size={18} weight="bold" />
                </button>
              </header>
              {projectDialog.mode === "github" && (
                <label>
                  <span>仓库地址</span>
                  <input
                    autoFocus
                    type="url"
                    value={projectDialog.url ?? ""}
                    placeholder="https://github.com/owner/repository.git"
                    onChange={(event) =>
                      setProjectDialog((current) =>
                        current ? { ...current, url: event.target.value } : current,
                      )
                    }
                    required
                    disabled={projectDialogBusy}
                  />
                </label>
              )}
              <label>
                <span>项目名称</span>
                <input
                  autoFocus={projectDialog.mode !== "github"}
                  value={projectDialog.name}
                  placeholder="例如：掌心助理"
                  onChange={(event) =>
                    setProjectDialog((current) =>
                      current ? { ...current, name: event.target.value } : current,
                    )
                  }
                  required
                  maxLength={80}
                  disabled={projectDialogBusy}
                />
              </label>
              <p>
                项目拥有独立文件、任务历史和 Codex 上下文，适合长期维护一项工作。
              </p>
              <footer>
                <button
                  type="button"
                  disabled={projectDialogBusy}
                  onClick={closeProjectDialog}
                >
                  {projectDialogBusy ? "正在处理，请稍候" : "取消"}
                </button>
                <button type="submit" className="primary" disabled={projectDialogBusy}>
                  {projectDialogBusy ? "处理中…" : "确认"}
                </button>
              </footer>
            </form>
          </div>
        )}
        <section
          className={`model-bar ${runtimeOpen ? "open" : ""}`}
          aria-label="Codex 模型设置"
        >
          <label>
            <span>模型</span>
            <select
              value={activeModel?.model ?? ""}
              onChange={(event) => void saveModel(event.target.value)}
              disabled={!models.length || projectReadOnly}
            >
              {models.map((model) => (
                <option key={model.id} value={model.model}>
                  {model.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>推理</span>
            <select
              value={activeEffort}
              onChange={(event) =>
                activeModel &&
                void saveModel(activeModel.model, event.target.value)
              }
              disabled={!activeModel || projectReadOnly}
            >
              {activeModel?.supportedReasoningEfforts.map((effort) => (
                <option
                  key={effort.reasoningEffort}
                  value={effort.reasoningEffort}
                >
                  {effortLabel(effort.reasoningEffort)}
                </option>
              ))}
            </select>
          </label>
          <button
            className="model-refresh"
            onClick={() => void loadModels(true)}
            aria-label="刷新模型列表"
          >
            <ArrowClockwise size={16} weight="bold" />
          </button>
          <strong
            title={
              status.sudo?.available
                ? "Codex 可使用无密码 sudo 执行服务器维护"
                : "Codex 完整沙箱访问；sudo 尚不可用"
            }
          >
            {status.sudo?.available ? "Root 运维" : "完全访问"}
          </strong>
        </section>
        {view === "chat" && (
          <section
            className="usage-overview"
            aria-label="Codex 用量"
            aria-live="polite"
          >
            <div className="usage-overview-title">
              <Gauge size={17} weight="bold" />
              <div>
                <span>Codex 用量</span>
                <small>
                  {usageUpdatedAt
                    ? `更新于 ${new Date(usageUpdatedAt).toLocaleTimeString(
                        "zh-CN",
                        { hour: "2-digit", minute: "2-digit" },
                      )}`
                    : "尚未刷新"}
                </small>
              </div>
            </div>
            <div className="usage-overview-windows">
              {usageWindows.length ? (
                usageWindows.slice(0, 2).map((window) => (
                  <div
                    className="usage-overview-window"
                    key={window.id}
                    title={resetLabel(window.resetAt)}
                  >
                    <span>{window.label}</span>
                    <strong>{window.remainingPercent}%</strong>
                    <small>{resetLabel(window.resetAt)}</small>
                  </div>
                ))
              ) : (
                <p>暂时无法读取用量</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => void loadDashboard()}
              aria-label="刷新 Codex 用量"
              title="刷新 Codex 用量"
            >
              <ArrowClockwise size={16} weight="bold" />
            </button>
          </section>
        )}
        {(connection !== "已连接" || status.disk?.warning) && (
          <section
            className={`system-alert ${status.disk?.tasksPaused ? "critical" : ""}`}
            role="status"
          >
            <strong>
              {connection !== "已连接"
                ? `Codex ${connection}`
                : status.disk?.tasksPaused
                  ? "服务器空间不足，已暂停新任务和上传"
                  : "服务器磁盘空间偏低"}
            </strong>
            <span>
              {connection !== "已连接"
                ? "连接恢复后会自动同步当前任务"
                : `${bytes(status.disk?.freeBytes)} 可用 · 建议尽快清理旧版本`}
            </span>
          </section>
        )}
        {notice && (
          <div className="global-notice" role="status" aria-live="polite">
            <span>{notice}</span>
            <button onClick={() => setNotice("")} aria-label="关闭提示">
              ×
            </button>
          </div>
        )}
        {view === "history" && (
          <div className="panel-stage">
            <div className="panel-title">
              <div>
                <p className="eyebrow">任务中心</p>
                <h2>{activeProject?.name ?? "当前项目"}</h2>
                <p className="task-definition">
                  任务会保留上下文；每次发送给 Codex 会产生一条执行记录。
                </p>
                {activeProject?.archivedAt && (
                  <span className="archived-badge">已归档 · 只读</span>
                )}
              </div>
              <div className="panel-title-actions">
                <button
                  disabled={Boolean(activeProject?.archivedAt)}
                  onClick={newConversation}
                >
                  <Plus size={17} weight="bold" />
                  新任务
                </button>
              </div>
            </div>
            {gitOpen && (
              <section className="git-review">
                <div className="git-review-head">
                  <div>
                    <strong>
                      {gitStatus?.repository
                        ? `分支 ${gitStatus.branch}`
                        : "代码审核"}
                    </strong>
                    <span>
                      {gitStatus?.error ??
                        (gitStatus?.repository
                          ? `${gitStatus.changes.length} 个变更文件 · 提交会包含当前项目全部变更`
                          : "当前项目没有 Git 仓库")}
                    </span>
                  </div>
                  <div className="git-review-primary-actions">
                    <button
                      className="git-commit-primary"
                      disabled={
                        projectBusy ||
                        gitBusy ||
                        projectReadOnly ||
                        !gitStatus?.repository ||
                        !gitStatus.changes.length
                      }
                      onClick={() => void runGitAction("commit")}
                    >
                      提交
                    </button>
                    <button onClick={() => setGitOpen(false)}>关闭</button>
                  </div>
                </div>
                <details className="git-advanced">
                  <summary>高级操作</summary>
                  <div>
                    <button
                      disabled={
                        projectBusy ||
                        gitBusy ||
                        projectReadOnly ||
                        !gitStatus?.repository
                      }
                      onClick={() => void runGitAction("pull")}
                    >
                      拉取远程更新
                    </button>
                    <button
                      disabled={
                        projectBusy ||
                        gitBusy ||
                        projectReadOnly ||
                        !gitStatus?.repository
                      }
                      onClick={() => void runGitAction("push")}
                    >
                      推送到远程
                    </button>
                  </div>
                </details>
                {gitStatus?.changes.map((change) => (
                  <div
                    className="git-change"
                    key={`${change.status}-${change.path}`}
                  >
                    <b>{change.status.replaceAll(" ", "·")}</b>
                    <span>{change.path}</span>
                    {change.status === "??" ? (
                      <small>未跟踪文件需手动删除</small>
                    ) : change.worktreeStatus !== " " ? (
                      <button
                        disabled={projectBusy || gitBusy || projectReadOnly}
                        onClick={() =>
                          void runGitAction("discard", change.path)
                        }
                      >
                        撤销未暂存修改
                      </button>
                    ) : (
                      <small>已暂存 · 暂不提供取消暂存</small>
                    )}
                  </div>
                ))}
                {gitStatus?.unstagedDiff && (
                  <details>
                    <summary>未暂存 Diff</summary>
                    <pre>{gitStatus.unstagedDiff}</pre>
                  </details>
                )}
                {gitStatus?.stagedDiff && (
                  <details>
                    <summary>已暂存 Diff</summary>
                    <pre>{gitStatus.stagedDiff}</pre>
                  </details>
                )}
                {Boolean(gitStatus?.untracked?.length) && (
                  <details>
                    <summary>未跟踪文件</summary>
                    <pre>{gitStatus?.untracked?.join("\n")}</pre>
                  </details>
                )}
              </section>
            )}
            <div className="panel-search">
              <input
                value={recordSearch}
                onChange={(event) => setRecordSearch(event.target.value)}
                placeholder="搜索任务、助手回复、执行记录和文本附件"
                aria-label="全文搜索"
              />
              <button
                className={searchAllProjects ? "active" : ""}
                onClick={() => setSearchAllProjects((value) => !value)}
              >
                {searchAllProjects ? "全部项目" : "当前项目"}
              </button>
              <button
                className={showArchived ? "active" : ""}
                onClick={() => setShowArchived((value) => !value)}
              >
                {showArchived ? "返回进行中" : "查看归档"}
              </button>
              {recordSearch.trim().length === 1 ? (
                <span>至少输入 2 个字</span>
              ) : recordSearch.trim().length >= 2 ? (
                <span>
                  {searching ? "检索中…" : `${searchResults.length} 条结果`}
                </span>
              ) : null}
            </div>
            {recordSearch.trim().length >= 2 && (
              <section className="global-search-results">
                {searchResults.length
                  ? searchResults.map((result, index) => (
                      <button
                        key={`${result.kind}-${result.projectId}-${result.threadId ?? result.path}-${index}`}
                        onClick={() => void openSearchResult(result)}
                      >
                        <span>
                          {result.kind === "thread"
                            ? "任务"
                            : result.kind === "task"
                              ? "执行"
                              : "文件"}
                        </span>
                        <strong>{result.title}</strong>
                        <small>{result.snippet || "匹配到内容"}</small>
                        {searchAllProjects && (
                          <em>
                            {projects.find(
                              (project) => project.id === result.projectId,
                            )?.name ?? result.projectId}
                          </em>
                        )}
                      </button>
                    ))
                  : !searching && (
                      <div className="empty-panel">没有找到匹配内容。</div>
                    )}
              </section>
            )}
            {!showArchived && matchingTasks.length > 0 && (
              <section className="task-section">
                <div className="section-heading">
                  <strong>最近执行</strong>
                  <span>每次发送给 Codex 的执行记录</span>
                </div>
                <div className="task-list">
                  {matchingTasks.map((task) => (
                    <article
                      key={task.taskId}
                      className={`task-card ${task.status}`}
                    >
                      <button
                        className="task-main"
                        onClick={() =>
                          void openThreadById(
                            task.projectId,
                            task.threadId,
                            task.title,
                          )
                        }
                      >
                        <span className="task-state">
                          {task.status === "running" ? (
                            <i />
                          ) : task.status === "completed" ? (
                            "✓"
                          ) : task.status === "interrupted" ? (
                            "■"
                          ) : (
                            "!"
                          )}
                        </span>
                        <span className="task-copy">
                          <strong>{task.title}</strong>
                          <small>
                            {new Date(task.startedAt).toLocaleString("zh-CN")} ·{" "}
                            {taskDuration(task)} · 附件{" "}
                            {task.attachments?.length ?? 0} · 成果{" "}
                            {task.outputPaths?.length ?? 0}
                            {task.errorMessage ? ` · ${task.errorMessage}` : ""}
                          </small>
                        </span>
                        <b>{taskStatusLabel(task.status)}</b>
                      </button>
                      {((task.outputPaths?.length ?? 0) > 0 ||
                        ["failed", "interrupted"].includes(task.status)) && (
                        <div className="task-actions">
                          {task.outputPaths?.map((outputPath) => {
                            const query = new URLSearchParams({
                              projectId,
                              path: outputPath,
                            });
                            return (
                              <a
                                key={outputPath}
                                href={`/api/files/download?${query}`}
                              >
                                ↓ {outputPath.split("/").pop()}
                              </a>
                            );
                          })}
                          {["failed", "interrupted"].includes(task.status) && (
                            <button onClick={() => void retryTask(task)}>
                              重新执行
                            </button>
                          )}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}
            <section className="thread-section">
              <div className="section-heading">
                <strong>{showArchived ? "已归档任务" : "任务记录"}</strong>
                <span>
                  {recordSearch.trim()
                    ? `${matchingThreads.length} 条匹配`
                    : showArchived
                      ? `${visibleThreads.length} 条`
                      : `最近 ${visibleThreads.length} 条`}
                </span>
              </div>
              {visibleThreads.length ? (
                <div className="record-list">
                  {visibleThreads.map((thread) => (
                    <article key={thread.threadId} className="record-item">
                      <button
                        className="record-main"
                        onClick={() => void openThread(thread)}
                      >
                        <strong>{thread.title}</strong>
                        <span>
                          {new Date(thread.updatedAt).toLocaleString("zh-CN")}
                        </span>
                      </button>
                      <div className="record-actions-menu" data-popover-root>
                        <button
                          type="button"
                          className="menu-trigger"
                          aria-label={`管理任务 ${thread.title}`}
                          aria-haspopup="menu"
                          aria-expanded={openMenu === `task-actions:${thread.threadId}`}
                          onClick={() =>
                            setOpenMenu((current) =>
                              current === `task-actions:${thread.threadId}`
                                ? undefined
                                : `task-actions:${thread.threadId}`,
                            )
                          }
                        >
                          <DotsThree size={20} weight="bold" />
                        </button>
                        {openMenu === `task-actions:${thread.threadId}` && <div role="menu">
                          <button
                            disabled={projectReadOnly}
                            onClick={() => {
                              setOpenMenu(undefined);
                              void updateThread(thread, {
                                favorite: !thread.favorite,
                              });
                            }}
                          >
                            <Star
                              size={16}
                              weight={thread.favorite ? "fill" : "regular"}
                            />
                            {thread.favorite ? "取消收藏" : "收藏"}
                          </button>
                          <button
                            disabled={projectReadOnly}
                            onClick={() => {
                              setOpenMenu(undefined);
                              void renameThread(thread);
                            }}
                          >
                            <PencilSimple size={16} />
                            重命名
                          </button>
                          <button
                            disabled={projectReadOnly}
                            onClick={() => {
                              setOpenMenu(undefined);
                              void updateThread(thread, {
                                archived: !showArchived,
                              });
                            }}
                          >
                            <Archive size={16} />
                            {showArchived ? "恢复" : "归档"}
                          </button>
                          <button
                            className="danger"
                            disabled={projectReadOnly}
                            onClick={() => {
                              setOpenMenu(undefined);
                              void deleteThread(thread);
                            }}
                          >
                            <Trash size={16} />
                            删除
                          </button>
                        </div>}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-panel">
                  {showArchived ? "还没有归档的任务。" : "没有匹配的任务。"}
                </div>
              )}
            </section>
          </div>
        )}
        {view === "files" && (
          <div className="panel-stage">
            <div className="panel-title">
              <div>
                <p className="eyebrow">项目文件</p>
                <h2>{activeProject?.name ?? "当前项目"}的文件</h2>
                {activeProject?.archivedAt && (
                  <span className="archived-badge">已归档 · 只读</span>
                )}
              </div>
              <button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || Boolean(activeProject?.archivedAt)}
              >
                <UploadSimple size={17} weight="bold" />
                {uploading ? "上传中…" : "上传"}
              </button>
            </div>
            <div className="file-toolbar">
              <div className="file-filters">
                <button
                  className={fileKind === "all" ? "active" : ""}
                  onClick={() => setFileKind("all")}
                >
                  全部
                </button>
                <button
                  className={fileKind === "inbox" ? "active" : ""}
                  onClick={() => setFileKind("inbox")}
                >
                  上传
                </button>
                <button
                  className={fileKind === "outbox" ? "active" : ""}
                  onClick={() => setFileKind("outbox")}
                >
                  成果
                </button>
              </div>
              <input
                value={fileSearch}
                onChange={(event) => setFileSearch(event.target.value)}
                placeholder="搜索文件"
                aria-label="搜索文件"
              />
            </div>
            {uploadFeedbacks.length > 0 && (
              <div className="panel-upload-feedback">
                {uploadFeedbacks.map((item) => (
                  <UploadCard
                    key={item.uploadId}
                    item={item}
                    onRetry={() => void upload(item.file, item.uploadId)}
                    onDismiss={() =>
                      setUploadFeedbacks((items) =>
                        items.filter(
                          (entry) => entry.uploadId !== item.uploadId,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            )}
            {matchingFiles.length ? (
              <div className="file-list">
                {matchingFiles.map((file) => {
                  const query = new URLSearchParams({
                    projectId,
                    path: file.path,
                  });
                  return (
                    <article key={file.path}>
                      <div>
                        <span
                          className={`file-kind ${file.path.startsWith("outbox/") ? "output" : ""}`}
                        >
                          {file.path.startsWith("outbox/") ? "成果" : "上传"}
                        </span>
                        <strong>{file.name}</strong>
                        <span>
                          {bytes(file.size)}
                          {file.modifiedAt
                            ? ` · ${new Date(file.modifiedAt).toLocaleString("zh-CN")}`
                            : ""}
                        </span>
                      </div>
                      <div>
                        {canPreview(file.name) && (
                          <a
                            href={`/api/files/preview?${query}`}
                          >
                            预览
                          </a>
                        )}
                        <a href={`/api/files/download?${query}`}>
                          <DownloadSimple size={15} />
                          下载
                        </a>
                        <button
                          disabled={projectReadOnly}
                          onClick={() => void deleteFile(file)}
                        >
                          <Trash size={15} />
                          删除
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-panel">没有匹配的文件。</div>
            )}
          </div>
        )}
        {view === "chat" && (
          <div className="message-stage">
            <div className="date-divider">
              <span>{activeProject?.name ?? "当前项目"}</span>
            </div>
            {messages.length === 0 ? (
              <>
                <article className="assistant-message">
                  <div className="assistant-seal">掌</div>
                  <div className="message-copy">
                    <p className="eyebrow">独立项目工作台</p>
                    <h2>今天想先处理什么？</h2>
                    <p className="lede">
                      上传的文件会真实保存到当前项目，并把服务器路径交给 Codex
                      读取。不同项目拥有独立目录和任务记录。
                    </p>
                    <div className="starter-grid">
                      {starterTasks.map((task) => (
                        <button
                          key={task}
                          onClick={() => {
                            setDraft(task);
                            window.localStorage.setItem(
                              `palm:draft:${projectId}`,
                              task,
                            );
                          }}
                        >
                          {task}
                          <span>↗</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </article>
                <section
                  className={`status-card ${status.disk?.warning ? "warning" : ""}`}
                  aria-label="服务器状态"
                >
                  <div>
                    <span className="status-icon">
                      {status.disk?.warning ? "!" : "✓"}
                    </span>
                    <div>
                      <strong>
                        {status.disk?.tasksPaused
                          ? "空间不足，已暂停新任务"
                          : status.disk?.warning
                            ? "磁盘空间偏低"
                            : "完全访问模式已启用"}
                      </strong>
                      <p>
                        {bytes(status.disk?.freeBytes)} 可用 ·{" "}
                        {status.disk?.warning
                          ? "建议清理旧版本"
                          : "常规操作无需审批"}
                      </p>
                    </div>
                  </div>
                  <button onClick={() => void loadDashboard()}>刷新</button>
                </section>
              </>
            ) : (
              <section className="chat-list" aria-live="polite">
                {messages.map((message) => (
                  <article
                    key={message.id}
                    data-message-id={message.id}
                    className={`chat-bubble ${message.role} ${focusedMessageId === message.id ? "message-focus" : ""}`}
                  >
                    <span>{message.role === "assistant" ? "掌" : "我"}</span>
                    <div>
                      {message.steps?.length ? (
                        <details className="execution-card">
                          <summary>
                            <span>执行过程</span>
                            <small>
                              {
                                message.steps.filter(
                                  (step) => step.status === "completed",
                                ).length
                              }
                              /{message.steps.length} 步
                            </small>
                          </summary>
                          <div>
                            {message.steps.map((step) => (
                              <article
                                key={step.id}
                                className={`execution-step ${step.status}`}
                              >
                                <b>
                                  {step.status === "running"
                                    ? "·"
                                    : step.status === "failed"
                                      ? "!"
                                      : "✓"}
                                </b>
                                <span>
                                  <strong>{step.label}</strong>
                                  {step.detail && (
                                    <small title={step.detail}>
                                      {step.detail}
                                    </small>
                                  )}
                                </span>
                              </article>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      {message.text ? (
                        <MessageContent
                          text={message.text}
                          projectId={projectId}
                          files={files}
                        />
                      ) : message.pending && !message.steps?.length ? (
                        "正在思考…"
                      ) : (
                        ""
                      )}
                      {message.attachments?.length ? (
                        <div className="message-files">
                          {message.attachments.map((file) => (
                            <SentFileCard
                              key={file.path}
                              file={file}
                              projectId={projectId}
                            />
                          ))}
                        </div>
                      ) : null}
                      {message.pending && <i className="typing-dot" />}
                      {message.role === "assistant" &&
                        message.text &&
                        !message.pending && (
                          <button
                            type="button"
                            className="copy-message"
                            onClick={() => void copyMessage(message.text)}
                          >
                            复制
                          </button>
                        )}
                    </div>
                  </article>
                ))}
              </section>
            )}
          </div>
        )}
        {taskNotices.length > 0 && (
          <div
            className={`task-notice-stack ${view === "chat" ? "" : "without-composer"}`}
            aria-label="任务完成通知"
          >
            {taskNotices.length > 1 && (
              <div className="task-notice-toolbar">
                <span>{taskNotices.length} 项任务更新</span>
                <button onClick={() => setTaskNotices([])}>全部清除</button>
              </div>
            )}
            {taskNotices.map((taskNotice) => (
              <article key={taskNotice.key} className="task-notice">
                <span className="task-notice-copy">{taskNotice.text}</span>
                <div className="task-notice-actions">
                  <button
                    className="task-notice-view"
                    onClick={() => openTaskNotice(taskNotice)}
                  >
                    查看
                  </button>
                  <button
                    className="task-notice-dismiss"
                    aria-label={`关闭通知 ${taskNotice.text}`}
                    onClick={() =>
                      setTaskNotices((items) =>
                        items.filter((item) => item.key !== taskNotice.key),
                      )
                    }
                  >
                    ×
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
        <footer
          ref={composerRef}
          className={`composer-wrap ${view !== "chat" ? "composer-hidden" : ""}`}
        >
          {recentOutputs.length > 0 && (
            <div className="output-row">
              <span>最新成果</span>
              {recentOutputs.map((file) => {
                const query = new URLSearchParams({
                  projectId,
                  path: file.path,
                });
                return (
                  <a key={file.path} href={`/api/files/download?${query}`}>
                    ↓ {file.name}
                  </a>
                );
              })}
            </div>
          )}
          {(uploadFeedbacks.length > 0 || attachments.length > 0) && (
            <div className="attachment-tray">
              {uploadFeedbacks.map((item) => (
                <UploadCard
                  key={item.uploadId}
                  item={item}
                  onRetry={() => void upload(item.file, item.uploadId)}
                  onDismiss={() =>
                    setUploadFeedbacks((items) =>
                      items.filter((entry) => entry.uploadId !== item.uploadId),
                    )
                  }
                />
              ))}
              {attachments.map((file) => (
                <AttachedFileCard
                  key={file.path}
                  file={file}
                  onRemove={() =>
                    setAttachments((items) =>
                      items.filter((item) => item.path !== file.path),
                    )
                  }
                />
              ))}
            </div>
          )}
          {openMenu === "attachments" && (
            <>
              <button
                type="button"
                className="attachment-sheet-backdrop"
                aria-label="关闭附件菜单"
                onClick={() => setOpenMenu(undefined)}
              />
              <section
                className="attachment-sheet"
                data-popover-root
                role="dialog"
                aria-modal="true"
                aria-label="添加附件"
              >
                <i className="sheet-handle" />
                <header>
                  <div>
                    <strong>添加到当前任务</strong>
                    <small>上传后会显示在本次任务消息中</small>
                  </div>
                  <button
                    type="button"
                    aria-label="关闭"
                    onClick={() => setOpenMenu(undefined)}
                  >
                    <X size={18} weight="bold" />
                  </button>
                </header>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(undefined);
                    fileRef.current?.click();
                  }}
                >
                  <span><Paperclip size={20} weight="bold" /></span>
                  <div><strong>上传文件</strong><small>文档、压缩包和其他文件</small></div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(undefined);
                    imageFileRef.current?.click();
                  }}
                >
                  <span><ImageSquare size={20} weight="bold" /></span>
                  <div><strong>照片和图片</strong><small>从系统图库选择原图</small></div>
                </button>
              </section>
            </>
          )}
          <form className="composer" onSubmit={sendTask}>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              disabled={uploading || projectReadOnly}
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <input
              ref={imageFileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              disabled={uploading || projectReadOnly}
              onChange={(event) => {
                void uploadFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="composer-actions">
              <button
                type="button"
                className="round-button"
                aria-label="添加附件"
                title="添加文件或照片"
                aria-expanded={openMenu === "attachments"}
                onClick={() =>
                  setOpenMenu((current) =>
                    current === "attachments" ? undefined : "attachments",
                  )
                }
                disabled={uploading || Boolean(activeProject?.archivedAt)}
              >
                <Paperclip size={19} weight="bold" />
              </button>
            </div>
            <textarea
              value={draft}
              onChange={(event) => {
                const value = event.target.value;
                setDraft(value);
                if (value)
                  window.localStorage.setItem(`palm:draft:${projectId}`, value);
                else window.localStorage.removeItem(`palm:draft:${projectId}`);
              }}
              placeholder={
                activeProject?.archivedAt
                  ? "项目已归档，仅可查看"
                  : projectRunningTask &&
                      projectRunningTask.threadId !== threadId
                    ? "本项目另一任务正在执行…"
                    : running
                      ? "任务执行中…"
                      : "告诉 Codex 要完成什么…"
              }
              disabled={Boolean(activeProject?.archivedAt)}
              rows={1}
              aria-label="任务内容"
            />
            {running ? (
              <button
                type="button"
                className="stop-button"
                aria-label="停止任务"
                onClick={interrupt}
              >
                <Stop size={15} weight="fill" />
              </button>
            ) : (
              <button
                type="submit"
                className="send-button"
                disabled={
                  uploading ||
                  projectBusy ||
                  Boolean(activeProject?.archivedAt) ||
                  (!draft.trim() && !attachments.length) ||
                  connection !== "已连接"
                }
                aria-label="发送"
              >
                <ArrowUp size={19} weight="bold" />
              </button>
            )}
          </form>
          <p className={`composer-note delivery-${deliveryState}`}>
            <span className="desktop-upload-hint">可拖入文件 · </span>
            {deliveryState === "sending"
              ? "正在发送，断线后会安全续传"
              : deliveryState === "accepted"
                ? "服务器已接收，Codex 正在执行"
                : "草稿按项目保存 · 附件发送时会交给 Codex 读取"}
          </p>
        </footer>
      </section>
    </main>
  );
}
