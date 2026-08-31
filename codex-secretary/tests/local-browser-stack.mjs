import { spawn } from 'node:child_process';
import path from 'node:path';
import { hashPassword } from '../dist-server/auth.js';

const root = process.cwd();
const children = [];
const previewPassword = 'browser-test-password';
const previewPasswordHash = await hashPassword(previewPassword);
const start = (command, args, env = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
};

start(process.execPath, ['dist-server/index.js'], {
  APP_HOST: '127.0.0.1',
  APP_PORT: '4511',
  APP_ORIGIN: 'http://127.0.0.1:8088',
  SESSION_SECRET: 'browser-test-secret-long-enough',
  APP_PASSWORD_HASH: previewPasswordHash,
  WORKSPACE_ROOT: path.join(root, '.browser-workspace'),
  CODEX_BIN: process.execPath,
  CODEX_ARGS_PREFIX_JSON: JSON.stringify([path.join(root, 'tests', 'mock-app-server.mjs')]),
  TASK_STOP_FREE_BYTES: '1',
  DISK_WARNING_FREE_BYTES: '1',
  LOG_LEVEL: 'error',
});
start(process.execPath, [path.join(root, 'node_modules', 'vinext', 'dist', 'cli.js'), 'start', '--host', '127.0.0.1', '--port', '3000']);
start(process.execPath, [path.join(root, 'tests', 'local-preview-proxy.mjs')]);

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
setInterval(() => undefined, 60_000);
