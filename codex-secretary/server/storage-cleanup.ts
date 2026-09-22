import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const helper = process.env.STORAGE_CLEANUP_HELPER ?? '/usr/local/libexec/palm-storage-cleanup';
const planLifetimeMs = 5 * 60_000;

export type StorageCleanupPlan = {
  planId: string;
  currentRelease: string;
  rollbackRelease?: string;
  candidates: Array<{ name: string; sizeBytes: number; modifiedAt: string }>;
  reclaimableBytes: number;
  expiresInSeconds: number;
};

let latestPlan: { value: StorageCleanupPlan; expiresAt: number } | undefined;
let cleanupInFlight = false;

async function runHelper(...args: string[]): Promise<unknown> {
  const { stdout } = await execFileAsync('/usr/bin/sudo', [
    '-n', '/usr/bin/flock', '--wait', '5', '/run/lock/palm-storage-cleanup.lock', helper, ...args,
  ], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function createStorageCleanupPlan(): Promise<StorageCleanupPlan> {
  const value = await runHelper('plan') as StorageCleanupPlan;
  latestPlan = { value, expiresAt: Date.now() + planLifetimeMs };
  return value;
}

export async function executeStorageCleanup(planId: string, confirmed: boolean): Promise<unknown> {
  if (!confirmed) throw new Error('需要人工确认');
  if (cleanupInFlight) throw new Error('已有清理任务正在执行');
  if (!latestPlan || latestPlan.expiresAt < Date.now() || latestPlan.value.planId !== planId) {
    throw new Error('清理计划已过期，请重新预检');
  }
  cleanupInFlight = true;
  try {
    const result = await runHelper('execute', planId);
    latestPlan = undefined;
    return result;
  } finally {
    cleanupInFlight = false;
  }
}
