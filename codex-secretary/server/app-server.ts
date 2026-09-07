import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { config } from './config.js';

const packageVersion = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

type JsonRecord = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<void> | null = null;
  private failures = 0;
  private retryAfter = 0;

  async ready(): Promise<void> {
    if (!this.readyPromise) {
      const starting = this.start();
      this.readyPromise = starting;
      void starting.catch(() => {
        if (this.readyPromise === starting) this.readyPromise = null;
      });
    }
    return this.readyPromise;
  }

  private async start(): Promise<void> {
    const delay = this.retryAfter - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    const child = spawn(config.codexBin, [...config.codexArgsPrefix, 'app-server', '--listen', 'stdio://'], {
      cwd: config.workspace,
      env: {
        ...process.env,
        HOME: config.codexUserHome,
        CODEX_HOME: config.codexHome,
        HTTP_PROXY: config.proxyUrl,
        HTTPS_PROXY: config.proxyUrl,
        ALL_PROXY: config.proxyUrl,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child) return;
      if (!line.trim()) return;
      try { this.receive(JSON.parse(line) as JsonRecord); }
      catch { this.emit('diagnostic', { level: 'warn', message: '收到无法解析的 App Server 输出' }); }
    });
    let lastDiagnosticAt = 0;
    createInterface({ input: child.stderr }).on('line', () => {
      const now = Date.now();
      if (now - lastDiagnosticAt > 30_000) {
        lastDiagnosticAt = now;
        this.emit('diagnostic', { level: 'info', message: 'Codex App Server 输出了一条内部诊断（内容已隐藏）' });
      }
    });
    const fail = (error: Error) => {
      if (this.child !== child) return;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.readyPromise = null;
      this.retryAfter = Date.now() + Math.min(5_000, 250 * 2 ** Math.min(this.failures++, 5));
      child.kill('SIGTERM');
      const forceStop = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 2_000);
      forceStop.unref();
      child.once('close', () => clearTimeout(forceStop));
      this.emit('offline', { reason: error.message });
    };
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('exit', (code, signal) => {
      fail(new Error(`Codex App Server 已退出 (${code ?? signal ?? 'unknown'})`));
    });

    try {
      await this.call('initialize', {
        clientInfo: { name: 'palm_secretary', title: '掌心助理', version: packageVersion },
        capabilities: {},
      });
      this.notify('initialized', {});
      this.failures = 0;
      this.retryAfter = 0;
      this.emit('online');
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private receive(message: JsonRecord): void {
    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    this.emit('message', message);
  }

  async call(method: string, params?: JsonRecord, timeoutMs = 30_000): Promise<unknown> {
    if (method !== 'initialize') await this.ready();
    if (!this.child) throw new Error('Codex App Server 未运行');
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ method, id, params: params ?? {} })}\n`);
    return result;
  }

  notify(method: string, params?: JsonRecord): void {
    if (!this.child) throw new Error('Codex App Server 未运行');
    this.child.stdin.write(`${JSON.stringify({ method, params: params ?? {} })}\n`);
  }

  respond(id: number, result: unknown): void {
    if (!this.child) throw new Error('Codex App Server 未运行');
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async close(): Promise<void> {
    this.child?.kill('SIGTERM');
  }
}
