import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DevelopmentResult } from './development-status.js';

const execFileAsync = promisify(execFile);
const MAX_GITHUB_OUTPUT = 2 * 1024 * 1024;
const TERMINAL_CACHE_MS = 5 * 60_000;
const PENDING_CACHE_MS = 30_000;
const ERROR_CACHE_MS = 60_000;

export type PullRequestState = 'none' | 'open' | 'merged' | 'closed' | 'unknown';
export type CiStatus = 'pending' | 'success' | 'failed' | 'cancelled' | 'unknown';

export type GithubCheck = {
  name: string;
  status: CiStatus;
  url?: string;
};

export type GithubDevelopmentStatus = {
  available: boolean;
  repository?: string;
  pullRequest?: {
    number: number;
    title: string;
    state: Exclude<PullRequestState, 'none' | 'unknown'>;
    draft: boolean;
    mergeable?: boolean;
    url: string;
    headSha: string;
    baseBranch: string;
  };
  pullRequestState: PullRequestState;
  ci?: {
    status: CiStatus;
    checks: GithubCheck[];
    url?: string;
  };
  error?: string;
  fetchedAt?: string;
};

export type GithubTransport = (endpoint: string) => Promise<unknown>;

type CachedStatus = { expiresAt: number; value: GithubDevelopmentStatus };
const statusCache = new Map<string, CachedStatus>();

function gitExecutable(): string {
  return process.platform === 'win32' ? 'git' : '/usr/bin/git';
}

function ghExecutable(): string {
  return process.platform === 'win32' ? 'gh' : '/usr/bin/gh';
}

function validRepositoryPart(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..';
}

export function parseGithubRepository(remote: string | undefined): string | undefined {
  const value = remote?.trim();
  if (!value) return;
  let owner: string | undefined;
  let repository: string | undefined;
  const scp = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (scp) [, owner, repository] = scp;
  if (!owner) {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== 'github.com') return;
      const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/');
      if (parts.length !== 2) return;
      [owner, repository] = parts;
      repository = repository.replace(/\.git$/i, '');
    } catch { return; }
  }
  if (!owner || !repository || !validRepositoryPart(owner) || !validRepositoryPart(repository)) return;
  return `${owner}/${repository}`;
}

export async function readOriginRemote(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(gitExecutable(), ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim() || undefined;
  } catch { return; }
}

export function createGhTransport(): GithubTransport {
  return async (endpoint) => {
    if (!endpoint.startsWith('/repos/')) throw new Error('GitHub endpoint is not allowed');
    const { stdout } = await execFileAsync(ghExecutable(), [
      'api', endpoint,
      '--method', 'GET',
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
    ], { timeout: 30_000, maxBuffer: MAX_GITHUB_OUTPUT });
    return JSON.parse(stdout);
  };
}

type ApiPullRequest = {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  draft?: unknown;
  merged_at?: unknown;
  mergeable?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  head?: { sha?: unknown };
  base?: { ref?: unknown };
};

function pullRank(item: ApiPullRequest, expectedSha?: string): [number, number, number, number] {
  const state = item.state === 'open' ? 0 : item.merged_at ? 1 : 2;
  const sha = typeof item.head?.sha === 'string' && item.head.sha === expectedSha ? 0 : 1;
  const updated = typeof item.updated_at === 'string' ? -Date.parse(item.updated_at) || 0 : 0;
  const number = typeof item.number === 'number' ? -item.number : 0;
  return [state, sha, updated, number];
}

function compareRank(left: ApiPullRequest, right: ApiPullRequest, expectedSha?: string): number {
  const a = pullRank(left, expectedSha);
  const b = pullRank(right, expectedSha);
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

export function selectPullRequest(items: unknown, expectedSha?: string): ApiPullRequest | undefined {
  if (!Array.isArray(items)) return;
  return (items as ApiPullRequest[])
    .filter((item) => typeof item?.number === 'number' && typeof item?.head?.sha === 'string')
    .sort((left, right) => compareRank(left, right, expectedSha))[0];
}

function normalizeConclusion(value: unknown): CiStatus {
  if (value === 'success' || value === 'neutral' || value === 'skipped') return 'success';
  if (value === 'failure' || value === 'timed_out' || value === 'action_required' || value === 'startup_failure' || value === 'stale') return 'failed';
  if (value === 'cancelled') return 'cancelled';
  return 'unknown';
}

export function aggregateChecks(payload: unknown): { status: CiStatus; checks: GithubCheck[] } {
  const raw = payload && typeof payload === 'object' && Array.isArray((payload as { check_runs?: unknown }).check_runs)
    ? (payload as { check_runs: Array<Record<string, unknown>> }).check_runs : [];
  const checks = raw.map((item): GithubCheck => {
    const pending = item.status !== 'completed';
    return {
      name: typeof item.name === 'string' ? item.name.slice(0, 120) : 'GitHub Check',
      status: pending ? 'pending' : normalizeConclusion(item.conclusion),
      ...(typeof item.details_url === 'string' && item.details_url.startsWith('https://github.com/') ? { url: item.details_url } : {}),
    };
  });
  if (!checks.length) return { status: 'unknown', checks };
  if (checks.some((item) => item.status === 'failed')) return { status: 'failed', checks };
  if (checks.some((item) => item.status === 'pending')) return { status: 'pending', checks };
  if (checks.some((item) => item.status === 'cancelled')) return { status: 'cancelled', checks };
  if (checks.every((item) => item.status === 'success')) return { status: 'success', checks };
  return { status: 'unknown', checks };
}

function safePullState(item: ApiPullRequest): 'open' | 'merged' | 'closed' {
  if (item.merged_at) return 'merged';
  return item.state === 'open' ? 'open' : 'closed';
}

function withGithubSummary(result: DevelopmentResult, github: GithubDevelopmentStatus): DevelopmentResult {
  if (result.summary.status !== 'ready' || !github.pullRequest) return { ...result, github };
  let label = result.summary.label;
  const pull = github.pullRequest;
  if (pull.state === 'merged') label = 'PR 已合并，本次开发结果已进入目标分支';
  else if (pull.state === 'closed') label = 'PR 已关闭，请确认后续处理方式';
  else if (pull.draft) label = 'PR 仍为草稿';
  else if (pull.mergeable === false) label = 'PR 存在合并冲突，暂不建议合并';
  else if (github.ci?.status === 'success') label = '本地验证与 CI 均通过，可以合并';
  else if (github.ci?.status === 'pending') label = '代码验证通过，正在等待 CI';
  else if (github.ci?.status === 'failed') label = 'CI 验证失败，暂不建议合并';
  else if (github.ci?.status === 'cancelled') label = 'CI 已取消，暂不建议合并';
  else label = 'PR 已创建，CI 状态尚未确认';
  return { ...result, github, summary: { ...result.summary, label } };
}

function cacheLifetime(value: GithubDevelopmentStatus): number {
  if (value.error) return ERROR_CACHE_MS;
  if (value.ci?.status === 'pending') return PENDING_CACHE_MS;
  return TERMINAL_CACHE_MS;
}

export async function enrichDevelopmentResultWithGithub(
  cwd: string,
  result: DevelopmentResult,
  options: { refresh?: boolean; transport?: GithubTransport; remote?: string } = {},
): Promise<DevelopmentResult> {
  if (!result.detected || !result.git.available) return result;
  const remote = options.remote ?? await readOriginRemote(cwd);
  const repository = parseGithubRepository(remote);
  if (!repository) return { ...result, github: { available: false, pullRequestState: 'none' } };
  const branch = result.git.branch;
  if (!branch || result.git.detached) {
    return { ...result, github: { available: true, repository, pullRequestState: 'none', fetchedAt: new Date().toISOString() } };
  }
  const expectedSha = result.git.commit?.sha;
  const cacheKey = `${repository}\0${branch}\0${expectedSha ?? ''}`;
  const cached = statusCache.get(cacheKey);
  if (!options.refresh && cached && cached.expiresAt > Date.now()) return withGithubSummary(result, cached.value);
  const transport = options.transport ?? createGhTransport();
  try {
    const [owner] = repository.split('/');
    const pulls = await transport(`/repos/${repository}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&sort=updated&direction=desc&per_page=20`);
    const selected = selectPullRequest(pulls, expectedSha);
    let github: GithubDevelopmentStatus;
    if (!selected) {
      github = { available: true, repository, pullRequestState: 'none', fetchedAt: new Date().toISOString() };
    } else {
      const number = selected.number as number;
      const detail = await transport(`/repos/${repository}/pulls/${number}`) as ApiPullRequest;
      const source = detail && typeof detail === 'object' ? detail : selected;
      const headSha = typeof source.head?.sha === 'string' ? source.head.sha : String(selected.head?.sha ?? '');
      const state = safePullState(source);
      const url = typeof source.html_url === 'string' && source.html_url.startsWith('https://github.com/')
        ? source.html_url : `https://github.com/${repository}/pull/${number}`;
      github = {
        available: true,
        repository,
        pullRequestState: state,
        pullRequest: {
          number,
          title: typeof source.title === 'string' ? source.title.slice(0, 200) : `Pull request #${number}`,
          state,
          draft: source.draft === true,
          ...(typeof source.mergeable === 'boolean' ? { mergeable: source.mergeable } : {}),
          url,
          headSha,
          baseBranch: typeof source.base?.ref === 'string' ? source.base.ref : '',
        },
        fetchedAt: new Date().toISOString(),
      };
      const checks = await transport(`/repos/${repository}/commits/${encodeURIComponent(headSha)}/check-runs?filter=latest&per_page=100`);
      github.ci = { ...aggregateChecks(checks), url: `${url}/checks` };
    }
    statusCache.set(cacheKey, { value: github, expiresAt: Date.now() + cacheLifetime(github) });
    return withGithubSummary(result, github);
  } catch {
    const github: GithubDevelopmentStatus = {
      available: false,
      repository,
      pullRequestState: 'unknown',
      error: 'GitHub 状态暂时无法读取',
      fetchedAt: new Date().toISOString(),
    };
    statusCache.set(cacheKey, { value: github, expiresAt: Date.now() + ERROR_CACHE_MS });
    return withGithubSummary(result, github);
  }
}

export function clearGithubStatusCache(): void {
  statusCache.clear();
}
