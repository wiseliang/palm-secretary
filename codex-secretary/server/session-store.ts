import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { sessionExpiry, verifySession } from './auth.js';

/** Persist hashes only: a copied, logged-out cookie stays revoked after restart. */
export class SessionStore {
  private revoked: Record<string, number> = {};
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string, private readonly secret: string) {}

  async initialize(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.entries(value).some(([key, expiry]) => !/^[a-f0-9]{64}$/.test(key) || typeof expiry !== 'number' || !Number.isFinite(expiry))) {
        throw new Error('会话撤销记录损坏');
      }
      this.revoked = value as Record<string, number>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  valid(token: string | undefined): boolean {
    return Boolean(token && verifySession(token, this.secret) && !this.revoked[this.key(token)]);
  }

  async revoke(token: string): Promise<void> {
    for (const [key, expiry] of Object.entries(this.revoked)) {
      if (expiry <= Date.now()) delete this.revoked[key];
    }
    // Invalidate immediately, even if persistence fails; the API reports that failure.
    this.revoked[this.key(token)] = sessionExpiry(token);
    const operation = this.queue.then(async () => {
      const active = Object.fromEntries(Object.entries(this.revoked).filter(([, expiry]) => expiry > Date.now()));
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(active), { mode: 0o600 });
      await rename(temporary, this.file);
    });
    this.queue = operation.catch(() => undefined);
    await operation;
  }

  private key(token: string): string { return createHash('sha256').update(token).digest('hex'); }
}
