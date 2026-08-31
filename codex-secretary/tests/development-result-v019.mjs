import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  aggregateDevelopmentResult,
  readGitSnapshot,
  verificationCommand,
} from "../dist-server/development-status.js";
import { ProjectStore } from "../dist-server/project-store.js";

const execFileAsync = promisify(execFile);
const runGit = (cwd, ...args) => execFileAsync("git", ["-C", cwd, ...args]);
const root = await mkdtemp(path.join(tmpdir(), "palm-development-result-"));

try {
  const repository = path.join(root, "repository");
  await mkdir(repository);
  await runGit(repository, "init");
  await runGit(repository, "config", "user.email", "palm-test@example.invalid");
  await runGit(repository, "config", "user.name", "Palm Test");
  await writeFile(path.join(repository, "tracked.txt"), "one\n");
  await writeFile(path.join(repository, "delete.txt"), "remove me\n");
  await writeFile(path.join(repository, "rename-old.txt"), "same\n");
  await runGit(repository, "add", ".");
  await runGit(repository, "commit", "-m", "initial");

  const before = await readGitSnapshot(repository);
  assert.equal(before.available, true);
  assert.equal(before.dirty, false);
  const clean = await aggregateDevelopmentResult(repository, before, await readGitSnapshot(repository), [], false);
  assert.equal(clean.detected, false, "没有 Git 或文件事件变化时不得显示开发结果卡");
  assert.equal(clean.summary.status, "clean");
  assert.equal((await aggregateDevelopmentResult(repository, before, before, [], true)).summary.status, "clean", "已撤销的文件事件不能误报开发变化");

  await writeFile(path.join(repository, "tracked.txt"), "one\ntwo\nthree\n");
  await runGit(repository, "add", "tracked.txt");
  await appendFile(path.join(repository, "tracked.txt"), "four\n");
  await unlink(path.join(repository, "delete.txt"));
  await runGit(repository, "mv", "rename-old.txt", "rename-new.txt");
  await writeFile(path.join(repository, "untracked.txt"), "new one\nnew two\n");

  const after = await readGitSnapshot(repository, true);
  assert.equal(after.available, true);
  assert.equal(after.dirty, true);
  assert.equal(after.changes?.length, 4, "tracked、deleted、rename、untracked 应分别计数");
  assert.ok(after.changes?.some((item) => item.status === "MM" && item.path === "tracked.txt"), "必须识别 staged + unstaged");
  assert.ok(after.changes?.some((item) => item.status === "??" && item.path === "untracked.txt"), "必须识别 untracked");
  assert.ok((after.additions ?? 0) >= 5, "新增行数必须包含 tracked 与 untracked 文本");
  assert.ok((after.deletions ?? 0) >= 1, "删除行数必须来自真实 Git numstat");

  const passedCommand = verificationCommand("npm test", 0);
  const failedCommand = verificationCommand(["npm", "run", "build"], 1);
  assert.deepEqual(passedCommand?.status, "passed");
  assert.deepEqual(failedCommand?.status, "failed");
  assert.equal(verificationCommand(["/bin/bash", "-lc", "npm run build"], 0)?.status, "passed", "必须识别 Codex 常用 shell 包装命令");
  assert.equal(verificationCommand("echo tests passed", 0), undefined, "普通输出不得伪装成验证");

  const ready = await aggregateDevelopmentResult(repository, before, after, [passedCommand], false);
  assert.equal(ready.summary.status, "ready");
  assert.equal(ready.git.changedFiles, 4);
  const failed = await aggregateDevelopmentResult(repository, before, after, [passedCommand, failedCommand], false);
  assert.equal(failed.summary.status, "failed");
  const unverified = await aggregateDevelopmentResult(repository, before, after, [], false);
  assert.equal(unverified.summary.status, "unverified");
  const terminalFailed = await aggregateDevelopmentResult(repository, before, after, [passedCommand], false, "failed");
  assert.equal(terminalFailed.summary.status, "failed", "任务失败时绝不能显示 ready");
  const interrupted = await aggregateDevelopmentResult(repository, before, after, [passedCommand], false, "interrupted");
  assert.equal(interrupted.summary.status, "unknown", "任务中断时必须要求人工确认");

  const dirtyBefore = await readGitSnapshot(repository, false, true);
  await appendFile(path.join(repository, "tracked.txt"), "task-only\n");
  const dirtyAfter = await readGitSnapshot(repository);
  const taskOnly = await aggregateDevelopmentResult(repository, dirtyBefore, dirtyAfter, [], false);
  assert.equal(taskOnly.git.changedFiles, 1, "任务前已有脏文件不得计入本次执行文件数");
  assert.equal(taskOnly.git.additions, 1, "本次执行增量必须排除任务前已有行数");
  await writeFile(path.join(repository, "tracked.txt"), "one\ntwo\nthree\nfour\n");

  const unavailable = await readGitSnapshot(path.join(root, "missing"));
  assert.equal(unavailable.available, false);
  const unknown = await aggregateDevelopmentResult(repository, before, unavailable, [], true);
  assert.equal(unknown.summary.status, "unknown", "Git 读取失败必须安全降级");

  const initialRepository = path.join(root, "initial-repository");
  await mkdir(initialRepository);
  await runGit(initialRepository, "init");
  await writeFile(path.join(initialRepository, "first.txt"), "first line\n");
  const initialSnapshot = await readGitSnapshot(initialRepository);
  assert.equal(initialSnapshot.available, true);
  assert.equal(initialSnapshot.commit, undefined, "初始仓库没有 commit 时必须正常返回");
  assert.equal(initialSnapshot.changes?.length, 1);
  assert.equal(initialSnapshot.additions, 1);

  await runGit(repository, "add", ".");
  await runGit(repository, "commit", "-m", "development changes");
  const committed = await readGitSnapshot(repository);
  const committedResult = await aggregateDevelopmentResult(repository, before, committed, [passedCommand], false);
  assert.equal(committed.dirty, false);
  assert.equal(committedResult.git.changedFiles, 4, "任务内提交后仍须显示 before HEAD 到 after HEAD 的真实文件数");
  assert.ok((committedResult.git.additions ?? 0) >= 5, "任务内提交后不能显示 +0 / -0");
  await runGit(repository, "checkout", "--detach");
  const detached = await readGitSnapshot(repository);
  assert.equal(detached.detached, true);
  assert.equal(detached.branch, undefined, "detached HEAD 不得伪造分支名");

  const workspace = path.join(root, "workspace");
  const store = new ProjectStore(workspace);
  await store.initialize();
  const project = await store.createProject("开发结果测试");
  const projectRepository = path.join(store.projectRoot(project.id), "repository");
  await mkdir(projectRepository);
  await runGit(projectRepository, "init");
  await runGit(projectRepository, "config", "user.email", "palm-test@example.invalid");
  await runGit(projectRepository, "config", "user.name", "Palm Test");
  await writeFile(path.join(projectRepository, "app.js"), "export const value = 1;\n");
  await runGit(projectRepository, "add", ".");
  await runGit(projectRepository, "commit", "-m", "initial app");
  await store.setProjectWorkdir(project.id, "repository");
  await store.rememberThread("thread-dev", project.id, "修改应用");
  await store.rememberTask("turn-dev", "thread-dev", project.id, "修改应用");
  assert.equal(store.listTasks(project.id)[0].gitBaseline, undefined, "任务 API 数据不得暴露基线文件内容");
  await writeFile(path.join(projectRepository, "app.js"), "export const value = 2;\n");
  await store.recordTaskExecution("thread-dev", "turn-dev", { type: "fileChange", changes: [{ path: "app.js" }] });
  await store.recordTaskExecution("thread-dev", "turn-dev", { type: "commandExecution", command: "npm test", exitCode: 0 });
  const task = await store.finishTask("thread-dev", "turn-dev", "completed");
  assert.equal(task?.developmentResult?.detected, true);
  assert.equal(task?.developmentResult?.git.changedFiles, 1);
  assert.equal(task?.developmentResult?.verification.status, "passed");
  assert.equal(task?.developmentResult?.summary.status, "ready");

  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/interaction-polish.css", import.meta.url), "utf8");
  assert.match(page, /developmentByTurn\.get\(message\.turnId\)/, "结果卡必须绑定对应 turn");
  assert.match(page, /onReview=\{\(\) => void openGitReview\(\)\}/, "查看修改必须复用现有 Git Review");
  assert.match(css, /@media \(max-width: 759px\)[\s\S]*\.development-result-card \{[^}]*width: 100%/, "移动端卡片必须限制在可用宽度内");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log("PALM_V019_DEVELOPMENT_RESULT_OK");
