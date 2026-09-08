// Only one request per key; bursts after completion share the recent result too.
export class SyncCoordinator {
  private requests = new Map<string, { promise: Promise<boolean>; at: number }>();
  run(key: string, work: () => Promise<boolean>, now = Date.now()): Promise<boolean> {
    const previous = this.requests.get(key);
    if (previous && now - previous.at < 1000) return previous.promise;
    const entry = { promise: Promise.resolve(false), at: Infinity };
    entry.promise = Promise.resolve().then(work).catch(() => false).then(result => {
      entry.at = result ? Date.now() : 0;
      return result;
    });
    this.requests.set(key, entry);
    if (this.requests.size > 32) {
      for (const [id, value] of this.requests) {
        if (value.at !== Infinity && id !== key) this.requests.delete(id);
      }
    }
    return entry.promise;
  }
}

export class RunCoordinator {
  revision = 0;
  threadId?: string;
  turnId?: string;
  running = false;
  private terminal = new Set<string>();
  update(threadId: string | undefined, turnId: string | undefined, running: boolean): boolean {
    if (threadId === this.threadId && this.running && !this.turnId && turnId && !running) return false;
    if (threadId === this.threadId && turnId && this.turnId && turnId !== this.turnId && !running) return false;
    if (running && turnId && this.terminal.has(`${threadId}:${turnId}`)) return false;
    this.revision++;
    this.threadId = threadId;
    this.turnId = turnId;
    this.running = running;
    if (!running && turnId) {
      this.terminal.add(`${threadId}:${turnId}`);
      if (this.terminal.size > 128) this.terminal.delete(this.terminal.values().next().value!);
    }
    return true;
  }
  reconcile(revision: number, threadId: string | undefined, turnId: string | undefined, running: boolean): boolean {
    if (revision !== this.revision) return false;
    // A missing REST row is not proof that an accepted/submitting turn stopped.
    if (this.running && this.threadId === threadId && !turnId) return false;
    return this.update(threadId, turnId, running);
  }
}
