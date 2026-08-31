import path from 'node:path';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

export const config = {
  host: process.env.APP_HOST ?? '127.0.0.1',
  port: Number(process.env.APP_PORT ?? 4511),
  origin: process.env.APP_ORIGIN?.replace(/\/$/, '') ?? 'http://localhost:3000',
  passwordHash: process.env.APP_PASSWORD_HASH?.trim() ?? '',
  sessionSecret: required('SESSION_SECRET'),
  workspace: path.resolve(process.env.WORKSPACE_ROOT ?? '/home/codex/workspace'),
  codexBin: process.env.CODEX_BIN ?? '/home/codex/.local/bin/codex-proxy',
  codexArgsPrefix: (() => {
    try {
      const value = JSON.parse(process.env.CODEX_ARGS_PREFIX_JSON ?? '[]');
      return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value as string[] : [];
    } catch {
      return [];
    }
  })(),
  codexUserHome: process.env.CODEX_USER_HOME ?? '/home/codex',
  codexHome: process.env.CODEX_HOME ?? '/home/codex/.codex',
  proxyUrl: process.env.HTTPS_PROXY ?? 'http://127.0.0.1:7897',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 104_857_600),
  taskStopFreeBytes: Number(process.env.TASK_STOP_FREE_BYTES ?? 4 * 1024 ** 3),
  diskWarningFreeBytes: Number(process.env.DISK_WARNING_FREE_BYTES ?? 6 * 1024 ** 3),
  sessionHours: Number(process.env.SESSION_HOURS ?? 168),
};
