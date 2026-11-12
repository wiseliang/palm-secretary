#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath, rm, statfs } from 'node:fs/promises';
import path from 'node:path';

const releasesRoot = '/opt/palm-secretary/releases';
const currentLink = '/opt/palm-secretary/current';
const cliRoot = '/home/codex/.codex/packages/npm';

async function cliInventory() {
  const root = await realpath(cliRoot);
  const proxy = await readFile('/home/codex/.local/bin/codex-proxy', 'utf8');
  const current = proxy.match(/packages\/npm\/(\d+\.\d+\.\d+)\//)?.[1];
  if (!current) fail('无法识别当前 Codex CLI，停止清理');
  const entries = [];
  for (const name of await readdir(root)) {
    if (!/^\d+\.\d+\.\d+$/.test(name)) continue;
    const target = path.join(root, name);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    entries.push({ name, path: target, category: 'codex', sizeBytes: await directorySize(target), modifiedAt: info.mtime.toISOString() });
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const rollback = entries.find(entry => entry.name !== current);
  return { current, rollback: rollback?.name, candidates: entries.filter(entry => entry.name !== current && entry.name !== rollback?.name) };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function directorySize(target) {
  const output = execFileSync('/usr/bin/du', ['-sx', '-B1', '--', target], { encoding: 'utf8' });
  return Number(output.trim().split(/\s+/, 1)[0]);
}

async function inventory() {
  const root = await realpath(releasesRoot);
  const current = await realpath(currentLink);
  if (path.dirname(current) !== root) fail('current 不在发布目录中');
  const entries = [];
  for (const name of await readdir(root)) {
    const target = path.join(root, name);
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const resolved = await realpath(target);
    if (path.dirname(resolved) !== root) fail(`发布目录越界：${name}`);
    entries.push({ name, path: resolved, modifiedAt: info.mtime.toISOString(), sizeBytes: await directorySize(resolved) });
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  const pinned = await realpath('/opt/palm-secretary/rollback').catch(error => {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  });
  if (pinned && path.dirname(pinned) !== root) fail('rollback 不在发布目录中');
  const rollback = entries.find((entry) => entry.path === pinned && entry.path !== current)
    ?? entries.find((entry) => entry.path !== current && entry.sizeBytes >= 100 * 1024 * 1024);
  const protectedNames = new Set([path.basename(current), rollback?.name].filter(Boolean));
  const candidates = entries.filter((entry) => !protectedNames.has(entry.name));
  const cli = await cliInventory();
  for (const item of candidates) item.category = 'releases';
  candidates.push(...cli.candidates);
  const fingerprint = JSON.stringify({ current: path.basename(current), rollback: rollback?.name, candidates: candidates.map(({ name, sizeBytes, modifiedAt }) => ({ name, sizeBytes, modifiedAt })) });
  return {
    planId: createHash('sha256').update(fingerprint).digest('hex').slice(0, 24),
    currentRelease: path.basename(current),
    rollbackRelease: rollback?.name,
    currentCli: cli.current,
    rollbackCli: cli.rollback,
    candidates,
    reclaimableBytes: candidates.reduce((sum, item) => sum + item.sizeBytes, 0),
    expiresInSeconds: 300,
  };
}

async function inUse(target) {
  try {
    execFileSync('/usr/bin/lsof', ['+D', target], { stdio: 'ignore', timeout: 15_000 });
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw new Error(`无法确认版本是否仍被进程使用：${path.basename(target)}`);
  }
}

async function healthSnapshot() {
  const disk = await statfs('/');
  const service = (name) => {
    try { return execFileSync('/usr/bin/systemctl', ['is-active', name], { encoding: 'utf8' }).trim(); }
    catch (error) { return String(error?.stdout ?? 'unknown').trim() || 'unknown'; }
  };
  return {
    freeBytes: Number(disk.bavail) * Number(disk.bsize),
    services: {
      api: service('palm-secretary-api.service'),
      web: service('palm-secretary-web.service'),
    },
  };
}

async function execute(planId, selection) {
  if (!['releases', 'codex', 'both'].includes(selection)) fail('无效清理选项');
  const before = await inventory();
  if (!planId || before.planId !== planId) fail('清理计划已变化，请重新预检并确认');
  const removed = [];
  let releasedBytes = 0;
  for (const candidate of before.candidates) {
    if (selection !== 'both' && candidate.category !== selection) continue;
    const target = await realpath(candidate.path);
    const allowedRoot = candidate.category === 'codex' ? cliRoot : releasesRoot;
    if (path.dirname(target) !== await realpath(allowedRoot)) fail(`拒绝越界目标：${candidate.name}`);
    if (candidate.category === 'codex') {
      const fresh = await cliInventory();
      if (!fresh.candidates.some(item => item.path === target)) fail('Codex 版本已变化，请重新预检');
    }
    if (target === await realpath(currentLink)) fail(`拒绝删除当前版本：${candidate.name}`);
    if (await inUse(target)) fail(`版本仍被进程使用：${candidate.name}`);
    await rm(target, { recursive: true, force: false });
    removed.push(candidate.name);
    releasedBytes += candidate.sizeBytes;
  }
  if (selection !== 'codex') try {
    execFileSync('/usr/bin/journalctl', ['--vacuum-size=200M'], { stdio: 'ignore', timeout: 30_000 });
  } catch { /* 日志压缩失败不影响已完成的 release 清理。 */ }
  return { ok: true, removed, releasedBytes, health: await healthSnapshot(), remainingPlan: await inventory() };
}

if (process.getuid?.() !== 0) fail('清理程序必须以 root 运行');
const command = process.argv[2];
const result = command === 'plan' ? await inventory() : command === 'execute' ? await execute(process.argv[3], process.argv[4] ?? 'releases') : fail('用法：palm-storage-cleanup plan|execute <planId> [releases|codex|both]');
process.stdout.write(`${JSON.stringify(result)}\n`);
