import { execFile } from 'node:child_process';

export type CliVersionStatus = {
  state: 'current' | 'update_available' | 'unavailable' | 'disabled';
  installedVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  checkedAt?: string;
  error?: string;
};

type CommandOptions = {
  env?: NodeJS.ProcessEnv;
  timeout: number;
  maxBuffer: number;
};

export type VersionCommandRunner = (
  file: string,
  args: string[],
  options: CommandOptions,
) => Promise<{ stdout: string; stderr: string }>;

type CheckerOptions = {
  codexBin: string;
  npmBin: string;
  proxyUrl?: string;
  enabled?: boolean;
  intervalMs?: number;
  failureRetryMs?: number;
  timeoutMs?: number;
  run?: VersionCommandRunner;
  now?: () => number;
};

const SEMVER = /(?:^|\s|v)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/;

export function parseCliVersion(value: string): string | undefined {
  return value.trim().match(SEMVER)?.[1];
}

function parseVersionParts(value: string): { core: number[]; prerelease?: string[] } | undefined {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.'),
  };
}

export function compareCliVersions(left: string, right: string): number {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = a.prerelease[index];
    const bPart = b.prerelease[index];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;
    if (aPart === bPart) continue;
    const aNumber = /^\d+$/.test(aPart) ? Number(aPart) : undefined;
    const bNumber = /^\d+$/.test(bPart) ? Number(bPart) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber ? 1 : -1;
    if (aNumber !== undefined) return -1;
    if (bNumber !== undefined) return 1;
    return aPart > bPart ? 1 : -1;
  }
  return 0;
}

const runCommand: VersionCommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
});

export class CliVersionChecker {
  private readonly options: Required<Pick<CheckerOptions, 'intervalMs' | 'failureRetryMs' | 'timeoutMs' | 'enabled'>> & CheckerOptions;
  private readonly run: VersionCommandRunner;
  private readonly now: () => number;
  private status: CliVersionStatus;
  private expiresAt = 0;
  private inFlight?: Promise<CliVersionStatus>;
  private timer?: NodeJS.Timeout;

  constructor(options: CheckerOptions) {
    this.options = {
      ...options,
      enabled: options.enabled ?? true,
      intervalMs: options.intervalMs ?? 12 * 60 * 60_000,
      failureRetryMs: options.failureRetryMs ?? 15 * 60_000,
      timeoutMs: options.timeoutMs ?? 15_000,
    };
    this.run = options.run ?? runCommand;
    this.now = options.now ?? Date.now;
    this.status = this.options.enabled
      ? { state: 'unavailable', updateAvailable: false }
      : { state: 'disabled', updateAvailable: false, error: '自动版本检查已关闭' };
  }

  current(): CliVersionStatus {
    return { ...this.status };
  }

  async get(force = false): Promise<CliVersionStatus> {
    if (!this.options.enabled) return this.current();
    if (!force && this.status.checkedAt && this.now() < this.expiresAt) return this.current();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  start(): void {
    if (!this.options.enabled || this.timer) return;
    void this.get(true);
    this.timer = setInterval(() => { void this.get(true); }, this.options.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async refresh(): Promise<CliVersionStatus> {
    const checkedAt = new Date(this.now()).toISOString();
    const commandOptions: CommandOptions = {
      timeout: this.options.timeoutMs,
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        ...(this.options.proxyUrl ? {
          HTTP_PROXY: this.options.proxyUrl,
          HTTPS_PROXY: this.options.proxyUrl,
          http_proxy: this.options.proxyUrl,
          https_proxy: this.options.proxyUrl,
        } : {}),
      },
    };
    try {
      const [installedResult, latestResult] = await Promise.all([
        this.run(this.options.codexBin, ['--version'], commandOptions),
        this.run(this.options.npmBin, ['view', '@openai/codex', 'version', '--json', '--silent'], commandOptions),
      ]);
      const installedVersion = parseCliVersion(installedResult.stdout);
      const latestRaw = JSON.parse(latestResult.stdout) as unknown;
      const latestVersion = typeof latestRaw === 'string' ? parseCliVersion(latestRaw) : undefined;
      if (!installedVersion || !latestVersion) throw new Error('无法识别 Codex CLI 版本');
      const updateAvailable = compareCliVersions(installedVersion, latestVersion) < 0;
      this.status = {
        state: updateAvailable ? 'update_available' : 'current',
        installedVersion,
        latestVersion,
        updateAvailable,
        checkedAt,
      };
      this.expiresAt = this.now() + this.options.intervalMs;
    } catch {
      this.status = {
        state: 'unavailable',
        installedVersion: this.status.installedVersion,
        latestVersion: this.status.latestVersion,
        updateAvailable: false,
        checkedAt,
        error: '暂时无法检查 Codex CLI 更新',
      };
      this.expiresAt = this.now() + this.options.failureRetryMs;
    }
    return this.current();
  }
}
