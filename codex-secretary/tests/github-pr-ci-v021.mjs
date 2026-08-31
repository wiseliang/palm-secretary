import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  aggregateChecks,
  clearGithubStatusCache,
  enrichDevelopmentResultWithGithub,
  parseGithubRepository,
  readOriginRemote,
  selectPullRequest,
} from "../dist-server/github-status.js";

const execFileAsync = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), "palm-github-status-"));
const baseResult = (summaryStatus = "ready") => ({
  detected: true,
  git: {
    available: true,
    branch: "feat/example",
    dirty: true,
    changedFiles: 2,
    additions: 12,
    deletions: 3,
    deltaComplete: true,
    commit: { sha: "abc123456789", message: "feat: example" },
  },
  verification: {
    status: summaryStatus === "failed" ? "failed" : "passed",
    commands: [{ command: "npm test", status: summaryStatus === "failed" ? "failed" : "passed", exitCode: summaryStatus === "failed" ? 1 : 0 }],
  },
  summary: {
    status: summaryStatus,
    label: summaryStatus === "failed" ? "任务执行失败，代码尚未达到可提交状态" : "修改已完成并通过验证，可以提交",
  },
});

function pull(overrides = {}) {
  return {
    number: 18,
    title: "Development result phase two",
    state: "open",
    draft: false,
    merged_at: null,
    mergeable: true,
    html_url: "https://github.com/wise/palm/pull/18",
    updated_at: "2026-08-31T08:00:00Z",
    head: { sha: "abc123456789" },
    base: { ref: "main" },
    ...overrides,
  };
}

function transportFor({ pulls = [pull()], detail = pull(), checks = [] } = {}) {
  return async (endpoint) => {
    if (endpoint.includes("/pulls?")) return pulls;
    if (endpoint.endsWith("/pulls/18")) return detail;
    if (endpoint.includes("/check-runs?")) return { check_runs: checks };
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
}

try {
  assert.equal(parseGithubRepository("https://github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGithubRepository("git@github.com:owner/repo.git"), "owner/repo");
  assert.equal(parseGithubRepository("ssh://git@github.com/owner/repo.git"), "owner/repo");
  assert.equal(parseGithubRepository("https://gitlab.com/owner/repo.git"), undefined);
  assert.equal(parseGithubRepository("https://github.com/owner/repo/extra"), undefined);

  const noOrigin = path.join(root, "no-origin");
  await mkdir(noOrigin);
  await execFileAsync("git", ["-C", noOrigin, "init"]);
  assert.equal(await readOriginRemote(noOrigin), undefined, "无 origin 必须正常降级");

  const openPreferred = selectPullRequest([
    pull({ number: 12, state: "closed", head: { sha: "abc123456789" } }),
    pull({ number: 19, state: "open", head: { sha: "other" } }),
    pull({ number: 18, state: "open", head: { sha: "abc123456789" } }),
  ], "abc123456789");
  assert.equal(openPreferred?.number, 18, "同分支异常多 PR 时应稳定优先 open 且匹配 HEAD 的 PR");

  assert.equal(aggregateChecks({ check_runs: [{ name: "Web", status: "in_progress", conclusion: null }] }).status, "pending");
  assert.equal(aggregateChecks({ check_runs: [
    { name: "Web", status: "completed", conclusion: "success" },
    { name: "Android", status: "completed", conclusion: "skipped" },
  ] }).status, "success");
  assert.equal(aggregateChecks({ check_runs: [
    { name: "Web", status: "completed", conclusion: "success" },
    { name: "Android", status: "completed", conclusion: "failure" },
  ] }).status, "failed");

  clearGithubStatusCache();
  const noPr = await enrichDevelopmentResultWithGithub(root, baseResult(), {
    remote: "https://github.com/wise/palm.git",
    transport: transportFor({ pulls: [] }),
  });
  assert.equal(noPr.github?.pullRequestState, "none");
  assert.equal(noPr.summary.label, "修改已完成并通过验证，可以提交", "没有 PR 时必须保留可提交语义");

  clearGithubStatusCache();
  const success = await enrichDevelopmentResultWithGithub(root, baseResult(), {
    remote: "git@github.com:wise/palm.git",
    transport: transportFor({ checks: [
      { name: "Web and Server CI", status: "completed", conclusion: "success", details_url: "https://github.com/wise/palm/actions/runs/1" },
      { name: "Android APK CI", status: "completed", conclusion: "success", details_url: "https://github.com/wise/palm/actions/runs/2" },
    ] }),
  });
  assert.equal(success.github?.pullRequest?.state, "open");
  assert.equal(success.github?.ci?.status, "success");
  assert.match(success.summary.label, /可以合并/);
  assert.deepEqual(success.github?.ci?.checks.map((check) => check.name), ["Web and Server CI", "Android APK CI"]);

  clearGithubStatusCache();
  const pending = await enrichDevelopmentResultWithGithub(root, baseResult(), {
    remote: "https://github.com/wise/palm",
    transport: transportFor({ checks: [{ name: "Web", status: "queued", conclusion: null }] }),
  });
  assert.equal(pending.github?.ci?.status, "pending");
  assert.match(pending.summary.label, /等待 CI/);

  clearGithubStatusCache();
  const ciFailed = await enrichDevelopmentResultWithGithub(root, baseResult(), {
    remote: "https://github.com/wise/palm",
    transport: transportFor({ checks: [{ name: "Web", status: "completed", conclusion: "failure" }] }),
  });
  assert.equal(ciFailed.github?.ci?.status, "failed");
  assert.match(ciFailed.summary.label, /暂不建议合并/);

  clearGithubStatusCache();
  const draft = await enrichDevelopmentResultWithGithub(root, baseResult(), {
    remote: "https://github.com/wise/palm",
    transport: transportFor({ detail: pull({ draft: true }), checks: [{ name: "Web", status: "completed", conclusion: "success" }] }),
  });
  assert.equal(draft.github?.pullRequest?.draft, true);
  assert.equal(draft.summary.label, "PR 仍为草稿");

  for (const [state, mergedAt, expected] of [["closed", "2026-08-31T09:00:00Z", "merged"], ["closed", null, "closed"]]) {
    clearGithubStatusCache();
    const result = await enrichDevelopmentResultWithGithub(root, baseResult(), {
      remote: "https://github.com/wise/palm",
      transport: transportFor({ detail: pull({ state, merged_at: mergedAt }), checks: [] }),
    });
    assert.equal(result.github?.pullRequest?.state, expected);
  }

  clearGithubStatusCache();
  const unavailable = await enrichDevelopmentResultWithGithub(root, baseResult(), {
    remote: "https://github.com/wise/palm",
    transport: async () => { throw new Error("rate limit"); },
  });
  assert.equal(unavailable.github?.available, false);
  assert.equal(unavailable.github?.error, "GitHub 状态暂时无法读取");
  assert.equal(unavailable.summary.label, "修改已完成并通过验证，可以提交", "GitHub 故障不得破坏本地结果");

  clearGithubStatusCache();
  const taskFailed = await enrichDevelopmentResultWithGithub(root, baseResult("failed"), {
    remote: "https://github.com/wise/palm",
    transport: transportFor({ checks: [{ name: "Web", status: "completed", conclusion: "success" }] }),
  });
  assert.equal(taskFailed.summary.status, "failed");
  assert.doesNotMatch(taskFailed.summary.label, /可以合并/, "任务失败不能被 CI success 覆盖");

  const nonGithub = await enrichDevelopmentResultWithGithub(root, baseResult(), { remote: "git@gitlab.com:wise/palm.git" });
  assert.equal(nonGithub.github?.available, false);
  assert.equal(nonGithub.github?.repository, undefined);

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/interaction-polish.css", import.meta.url), "utf8");
  assert.match(page, /查看 PR/);
  assert.match(page, /查看 CI/);
  assert.match(page, /loadDevelopmentStatus\(task, true\)/, "pending CI 必须使用受控的后端刷新入口");
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*\.development-result-actions \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "移动端按钮必须在卡片内换行且不溢出");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("PALM_V021_GITHUB_PR_CI_OK");
