import { readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export function normalizeUpdateScript(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

/** Only validated version directories inside the dedicated CLI package store. */
export async function cleanupCliVersions(root: string, keep: string[]): Promise<string[]> {
  const canonicalRoot = await realpath(root);
  const activeExecutables: string[] = [];
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try { activeExecutables.push(await realpath(`/proc/${pid}/exe`)); } catch { /* exited or another user */ }
  }
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+\.\d+\.\d+$/.test(entry.name) || keep.includes(entry.name)) continue;
    const target = path.join(canonicalRoot, entry.name);
    if (await realpath(target) !== target || activeExecutables.some(exe => exe.startsWith(`${target}/`))) continue;
    await rm(target, { recursive: true });
    removed.push(entry.name);
  }
  return removed;
}

export async function loadUpdateScript(file: string): Promise<string> {
  return normalizeUpdateScript(await readFile(file, 'utf8'));
}
