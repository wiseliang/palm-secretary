import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { GithubDevelopmentStatus } from './github-status.js';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const MAX_UNTRACKED_HASH_BYTES = 5 * 1024 * 1024;
const MAX_BASELINE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_BASELINE_TOTAL_BYTES = 6 * 1024 * 1024;

type BaselineFile = { exists: boolean; contentBase64?: string };

export type GitChange = {
  status: string;
  indexStatus: string;
  worktreeStatus: string;
  path: string;
  originalPath?: string;
};

export type GitSnapshot = {
  available: boolean;
  error?: string;
  branch?: string;
  detached?: boolean;
  dirty?: boolean;
  changes?: GitChange[];
  additions?: number;
  deletions?: number;
  commit?: { sha: string; message: string };
  fingerprint?: string;
  unstagedDiff?: string;
  stagedDiff?: string;
  baselineFiles?: Record<string, BaselineFile>;
  baselineIncomplete?: boolean;
};

export type VerificationCommand = {
  command: string;
  status: 'passed' | 'failed';
  exitCode: number;
};

export type DevelopmentResult = {
  detected: boolean;
  git: {
    available: boolean;
    error?: string;
    branch?: string;
    detached?: boolean;
    dirty?: boolean;
    changedFiles?: number;
    additions?: number;
    deletions?: number;
    deltaComplete?: boolean;
    commit?: { sha: string; message: string };
  };
  verification: {
    status: 'passed' | 'failed' | 'unverified';
    commands: VerificationCommand[];
  };
  github?: GithubDevelopmentStatus;
  summary: {
    status: 'ready' | 'unverified' | 'failed' | 'clean' | 'unknown';
    label: string;
  };
};

function gitExecutable(): string {
  return process.platform === 'win32' ? 'git' : '/usr/bin/git';
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(gitExecutable(), ['-C', cwd, ...args], {
    timeout: 60_000,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  return stdout;
}

async function optionalGit(cwd: string, args: string[]): Promise<string | undefined> {
  try { return await runGit(cwd, args); }
  catch { return undefined; }
}

export function parsePorcelain(statusText: string): GitChange[] {
  const entries = statusText.split('\0').filter(Boolean);
  const changes: GitChange[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const indexStatus = entry[0] ?? ' ';
    const worktreeStatus = entry[1] ?? ' ';
    const filePath = entry.slice(3);
    const renamed = ['R', 'C'].includes(indexStatus) || ['R', 'C'].includes(worktreeStatus);
    const originalPath = renamed ? entries[++index] : undefined;
    changes.push({
      status: `${indexStatus}${worktreeStatus}`,
      indexStatus,
      worktreeStatus,
      path: filePath,
      ...(originalPath ? { originalPath } : {}),
    });
  }
  return changes;
}

function parseNumstat(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of text.split('\n')) {
    const [added, deleted] = line.split('\t');
    if (/^\d+$/.test(added ?? '')) additions += Number(added);
    if (/^\d+$/.test(deleted ?? '')) deletions += Number(deleted);
  }
  return { additions, deletions };
}

async function untrackedFileFacts(cwd: string, changes: GitChange[]): Promise<Array<{ path: string; additions: number; hash: string }>> {
  const facts = [];
  for (const change of changes.filter((item) => item.status === '??')) {
    const absolute = path.resolve(cwd, change.path);
    if (absolute !== cwd && !absolute.startsWith(`${cwd}${path.sep}`)) continue;
    const details = await stat(absolute).catch(() => undefined);
    if (!details?.isFile()) continue;
    if (details.size > MAX_UNTRACKED_HASH_BYTES) {
      facts.push({ path: change.path, additions: 0, hash: `large:${details.size}:${details.mtimeMs}` });
      continue;
    }
    const content = await readFile(absolute).catch(() => undefined);
    if (!content) continue;
    const binary = content.includes(0);
    const additions = binary || content.length === 0
      ? 0
      : content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
    facts.push({ path: change.path, additions, hash: createHash('sha256').update(content).digest('hex') });
  }
  return facts;
}

function safeGitPath(cwd: string, relativePath: string): string | undefined {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) return;
  const absolute = path.resolve(cwd, relativePath);
  return absolute.startsWith(`${path.resolve(cwd)}${path.sep}`) ? absolute : undefined;
}

async function captureBaselineFiles(cwd: string, changes: GitChange[]): Promise<{ files: Record<string, BaselineFile>; incomplete: boolean }> {
  const paths = new Set(changes.flatMap((change) => [change.path, change.originalPath].filter((value): value is string => Boolean(value))));
  const files: Record<string, BaselineFile> = {};
  let totalBytes = 0;
  let incomplete = false;
  for (const relativePath of paths) {
    const absolute = safeGitPath(cwd, relativePath);
    if (!absolute) { incomplete = true; continue; }
    const details = await stat(absolute).catch(() => undefined);
    if (!details?.isFile()) { files[relativePath] = { exists: false }; continue; }
    if (details.size > MAX_BASELINE_FILE_BYTES || totalBytes + details.size > MAX_BASELINE_TOTAL_BYTES) {
      files[relativePath] = { exists: true };
      incomplete = true;
      continue;
    }
    const content = await readFile(absolute);
    totalBytes += content.length;
    files[relativePath] = { exists: true, contentBase64: content.toString('base64') };
  }
  return { files, incomplete };
}

export async function readGitSnapshot(cwd: string, includeDiffs = false, captureBaseline = false): Promise<GitSnapshot> {
  try {
    if ((await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      return { available: false, error: '当前项目还没有 Git 仓库' };
    }
    const statusText = await runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    const changes = parsePorcelain(statusText);
    const branchText = (await optionalGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']))?.trim();
    const headText = (await optionalGit(cwd, ['log', '-1', '--format=%H%x00%s']))?.trim();
    const [sha, message = ''] = headText?.split('\0') ?? [];
    const hasHead = Boolean(sha);
    const trackedDiff = hasHead
      ? await optionalGit(cwd, ['diff', '--numstat', 'HEAD']) ?? ''
      : `${await optionalGit(cwd, ['diff', '--cached', '--numstat']) ?? ''}\n${await optionalGit(cwd, ['diff', '--numstat']) ?? ''}`;
    const diffForFingerprint = hasHead
      ? await optionalGit(cwd, ['diff', '--binary', 'HEAD']) ?? ''
      : `${await optionalGit(cwd, ['diff', '--cached', '--binary']) ?? ''}\n${await optionalGit(cwd, ['diff', '--binary']) ?? ''}`;
    const untrackedFacts = await untrackedFileFacts(cwd, changes);
    const totals = parseNumstat(trackedDiff);
    totals.additions += untrackedFacts.reduce((sum, item) => sum + item.additions, 0);
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ branch: branchText || null, sha: sha || null, statusText, diffForFingerprint, untrackedFacts }))
      .digest('hex');
    const [unstagedDiff, stagedDiff] = includeDiffs
      ? await Promise.all([
          optionalGit(cwd, ['diff', '--no-ext-diff', '--unified=3']),
          optionalGit(cwd, ['diff', '--cached', '--no-ext-diff', '--unified=3']),
        ])
      : [undefined, undefined];
    const baseline = captureBaseline ? await captureBaselineFiles(cwd, changes) : undefined;
    return {
      available: true,
      branch: branchText || undefined,
      detached: !branchText,
      dirty: changes.length > 0,
      changes,
      additions: totals.additions,
      deletions: totals.deletions,
      ...(sha ? { commit: { sha, message } } : {}),
      fingerprint,
      ...(baseline ? { baselineFiles: baseline.files, baselineIncomplete: baseline.incomplete } : {}),
      ...(includeDiffs ? {
        unstagedDiff: (unstagedDiff ?? '').slice(0, 1_000_000),
        stagedDiff: (stagedDiff ?? '').slice(0, 1_000_000),
      } : {}),
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : 'Git 状态暂时无法读取' };
  }
}

async function gitBlob(cwd: string, sha: string, relativePath: string): Promise<Buffer | undefined> {
  try {
    const result = await execFileAsync(gitExecutable(), ['-C', cwd, 'show', `${sha}:${relativePath}`], {
      encoding: 'buffer', timeout: 30_000, maxBuffer: MAX_GIT_OUTPUT,
    }) as unknown as { stdout: Buffer };
    return Buffer.from(result.stdout);
  } catch { return undefined; }
}

async function baselineContent(cwd: string, before: GitSnapshot, relativePath: string): Promise<{ content?: Buffer; complete: boolean }> {
  if (before.baselineFiles && Object.hasOwn(before.baselineFiles, relativePath)) {
    const file = before.baselineFiles[relativePath];
    if (!file.exists) return { complete: true };
    if (!file.contentBase64) return { complete: false };
    return { content: Buffer.from(file.contentBase64, 'base64'), complete: true };
  }
  if (!before.commit?.sha) return { complete: true };
  return { content: await gitBlob(cwd, before.commit.sha, relativePath), complete: true };
}

async function currentContent(cwd: string, relativePath: string): Promise<Buffer | undefined> {
  const absolute = safeGitPath(cwd, relativePath);
  if (!absolute) return;
  const details = await stat(absolute).catch(() => undefined);
  return details?.isFile() ? readFile(absolute) : undefined;
}

async function commitChangedPaths(cwd: string, before: GitSnapshot, after: GitSnapshot): Promise<string[]> {
  if (before.commit?.sha && after.commit?.sha && before.commit.sha !== after.commit.sha) {
    return (await optionalGit(cwd, ['diff', '--name-only', '-z', before.commit.sha, after.commit.sha]) ?? '').split('\0').filter(Boolean);
  }
  if (!before.commit?.sha && after.commit?.sha) {
    return (await optionalGit(cwd, ['ls-tree', '-r', '--name-only', '-z', after.commit.sha]) ?? '').split('\0').filter(Boolean);
  }
  return [];
}

async function noIndexNumstat(cwd: string, beforeDirectory: string, afterDirectory: string): Promise<string> {
  try {
    return await runGit(cwd, ['diff', '--no-index', '--numstat', '-M', '--', beforeDirectory, afterDirectory]);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout === 'string') return stdout;
    throw error;
  }
}

async function developmentDelta(cwd: string, before: GitSnapshot, after: GitSnapshot): Promise<{ changedFiles?: number; additions?: number; deletions?: number; complete: boolean }> {
  if (!before.available || !after.available || before.baselineIncomplete) return { complete: false };
  const candidates = new Set<string>([
    ...(before.changes ?? []).flatMap((change) => [change.path, change.originalPath].filter((value): value is string => Boolean(value))),
    ...(after.changes ?? []).flatMap((change) => [change.path, change.originalPath].filter((value): value is string => Boolean(value))),
    ...await commitChangedPaths(cwd, before, after),
  ]);
  if (!candidates.size) return { changedFiles: 0, additions: 0, deletions: 0, complete: true };
  const temporary = await mkdtemp(path.join(tmpdir(), 'palm-git-delta-'));
  const beforeDirectory = path.join(temporary, 'before');
  const afterDirectory = path.join(temporary, 'after');
  await Promise.all([mkdir(beforeDirectory), mkdir(afterDirectory)]);
  try {
    for (const relativePath of candidates) {
      const safeBefore = safeGitPath(beforeDirectory, relativePath);
      const safeAfter = safeGitPath(afterDirectory, relativePath);
      if (!safeBefore || !safeAfter) return { complete: false };
      const baseline = await baselineContent(cwd, before, relativePath);
      if (!baseline.complete) return { complete: false };
      const current = await currentContent(cwd, relativePath);
      if (baseline.content) { await mkdir(path.dirname(safeBefore), { recursive: true }); await writeFile(safeBefore, baseline.content); }
      if (current) { await mkdir(path.dirname(safeAfter), { recursive: true }); await writeFile(safeAfter, current); }
    }
    const numstat = await noIndexNumstat(cwd, beforeDirectory, afterDirectory);
    const lines = numstat.split('\n').filter(Boolean);
    const totals = parseNumstat(numstat);
    return { changedFiles: lines.length, additions: totals.additions, deletions: totals.deletions, complete: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function verificationCommand(commandValue: unknown, exitCodeValue: unknown): VerificationCommand | undefined {
  const command = Array.isArray(commandValue)
    ? commandValue.map(String).join(' ')
    : typeof commandValue === 'string' ? commandValue : '';
  const exitCode = typeof exitCodeValue === 'number' && Number.isInteger(exitCodeValue) ? exitCodeValue : undefined;
  if (!command.trim() || exitCode === undefined) return;
  const verificationPattern = /(?:^|\s*(?:&&|\|\||;)\s*)(?:(?:(?:\/usr\/bin\/|\/bin\/)?(?:bash|sh|zsh)\s+-[a-z]*c\s+["']?)?(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test(?::[\w-]+)?|build|check|lint)|(?:python(?:3)?\s+-m\s+)?pytest|go\s+test|cargo\s+test|dotnet\s+test|mvn(?:w)?\s+(?:test|verify)|(?:\.\/)?gradlew?\s+(?:test|check)|make\s+(?:test|check)|(?:npx\s+)?tsc(?:\s|$)))/i;
  if (!verificationPattern.test(command.trim())) return;
  return { command: command.trim().slice(0, 500), status: exitCode === 0 ? 'passed' : 'failed', exitCode };
}

export async function aggregateDevelopmentResult(
  cwd: string,
  before: GitSnapshot | undefined,
  after: GitSnapshot,
  commands: VerificationCommand[],
  fileChangeDetected = false,
  taskStatus: 'completed' | 'failed' | 'interrupted' = 'completed',
): Promise<DevelopmentResult> {
  const gitChanged = Boolean(
    before?.available && after.available && (
      before.fingerprint !== after.fingerprint ||
      before.branch !== after.branch ||
      before.commit?.sha !== after.commit?.sha
    ),
  );
  const detected = gitChanged || ((!before?.available || !after.available) && fileChangeDetected);
  const delta = detected && before ? await developmentDelta(cwd, before, after) : { changedFiles: 0, additions: 0, deletions: 0, complete: true };
  const verificationStatus = commands.some((command) => command.status === 'failed')
    ? 'failed'
    : commands.length > 0 && commands.every((command) => command.status === 'passed')
      ? 'passed'
      : 'unverified';
  let summary: DevelopmentResult['summary'];
  if (!detected) summary = { status: 'clean', label: '本次执行没有检测到代码变化' };
  else if (taskStatus === 'interrupted') summary = { status: 'unknown', label: '任务被中断，请确认代码状态后再继续' };
  else if (taskStatus === 'failed') summary = { status: 'failed', label: '任务执行失败，代码尚未达到可提交状态' };
  else if (!after.available || !delta.complete) summary = { status: 'unknown', label: '检测到代码修改，但暂时无法完整判断开发状态' };
  else if (verificationStatus === 'failed') summary = { status: 'failed', label: '验证失败，需要继续处理' };
  else if (verificationStatus === 'passed') summary = { status: 'ready', label: '修改已完成并通过验证，可以提交' };
  else summary = { status: 'unverified', label: '代码已有修改，但尚未完成验证' };
  return {
    detected,
    git: {
      available: after.available,
      error: after.available ? undefined : (after.error || 'Git 状态暂时无法读取'),
      branch: after.branch,
      detached: after.detached,
      dirty: after.dirty,
      changedFiles: delta.changedFiles,
      additions: delta.additions,
      deletions: delta.deletions,
      deltaComplete: delta.complete,
      commit: after.commit,
    },
    verification: { status: verificationStatus, commands: [...commands] },
    summary,
  };
}
