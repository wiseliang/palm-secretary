import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT = 4 * 1024 * 1024;
const MAX_UNTRACKED_HASH_BYTES = 5 * 1024 * 1024;

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
    commit?: { sha: string; message: string };
  };
  verification: {
    status: 'passed' | 'failed' | 'unverified';
    commands: VerificationCommand[];
  };
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

export async function readGitSnapshot(cwd: string, includeDiffs = false): Promise<GitSnapshot> {
  try {
    if ((await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      return { available: false, error: '当前项目还没有 Git 仓库' };
    }
    const statusText = await runGit(cwd, ['status', '--porcelain=v1', '-z']);
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
      ...(includeDiffs ? {
        unstagedDiff: (unstagedDiff ?? '').slice(0, 1_000_000),
        stagedDiff: (stagedDiff ?? '').slice(0, 1_000_000),
      } : {}),
    };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : 'Git 状态暂时无法读取' };
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

export function aggregateDevelopmentResult(
  before: GitSnapshot | undefined,
  after: GitSnapshot,
  commands: VerificationCommand[],
  fileChangeDetected = false,
): DevelopmentResult {
  const gitChanged = Boolean(
    before?.available && after.available && (
      before.fingerprint !== after.fingerprint ||
      before.branch !== after.branch ||
      before.commit?.sha !== after.commit?.sha
    ),
  );
  const detected = gitChanged || ((!before?.available || !after.available) && fileChangeDetected);
  const verificationStatus = commands.some((command) => command.status === 'failed')
    ? 'failed'
    : commands.length > 0 && commands.every((command) => command.status === 'passed')
      ? 'passed'
      : 'unverified';
  let summary: DevelopmentResult['summary'];
  if (!detected) summary = { status: 'clean', label: '本次执行没有检测到代码变化' };
  else if (!after.available) summary = { status: 'unknown', label: '检测到文件修改，但暂时无法完整判断开发状态' };
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
      changedFiles: after.changes?.length,
      additions: after.additions,
      deletions: after.deletions,
      commit: after.commit,
    },
    verification: { status: verificationStatus, commands: [...commands] },
    summary,
  };
}
