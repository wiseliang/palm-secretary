import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

type JsonRecord = Record<string, unknown>;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class CodexBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private readyPromise: Promise<void> | null = null;

  async ready(): Promise<void> {
    if (!this.readyPromise) this.readyPromise = this.start();
    return this.readyPromise;
  }

  private async start(): Promise<void> {
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
    child.on('exit', (code, signal) => {
      const error = new Error(`Codex App Server 已退出 (${code ?? signal ?? 'unknown'})`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.child = null;
      this.readyPromise = null;
      this.emit('offline', { code, signal });
    });

    await this.call('initialize', {
      clientInfo: { name: 'palm_secretary', title: '掌心助理', version: '0.11.3' },
      capabilities: {},
    });
    this.notify('initialized', {});
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
    if (!this.child && method !== 'initialize') await this.ready();
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
