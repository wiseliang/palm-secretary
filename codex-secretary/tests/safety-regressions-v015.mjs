import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ProjectStore } from "../dist-server/project-store.js";

const execFileAsync = promisify(execFile);

const workspace = await mkdtemp(path.join(tmpdir(), "palm-v015-"));
try {
  const store = new ProjectStore(workspace);
  await store.initialize();
  const project = await store.createProject("GitHub 项目");
  const root = store.projectRoot(project.id);
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, "inbox"), { recursive: true });
  await mkdir(path.join(repository, "outbox"), { recursive: true });
  await execFileAsync("git", ["init", repository]);
  await store.setProjectWorkdir(project.id, "repository");

  const upload = "123e4567-e89b-42d3-a456-426614174000-contract.pdf";
  await writeFile(path.join(root, "inbox", upload), "existing");
  await writeFile(path.join(repository, "inbox", upload), "migrated");
  await writeFile(
    path.join(repository, "inbox", "source.ts"),
    "tracked repository file",
  );
  await writeFile(path.join(repository, "inbox", "draft.json"), "untracked repository asset");
  await writeFile(path.join(repository, ".gitignore"), "outbox/runtime-cache.db\n");
  await writeFile(path.join(repository, "outbox", "runtime-cache.db"), "ignored repository asset");
  await execFileAsync("git", ["-C", repository, "add", ".gitignore", "inbox/source.ts"]);
  await store.rememberThread("thread-1", project.id, "测试");
  await store.rememberTask("turn-1", "thread-1", project.id, "生成报告", [
    `inbox/${upload}`,
  ]);
  await writeFile(path.join(root, "outbox", "报告.xlsx"), "report");
  const firstFinish = await store.finishTask("thread-1", "turn-1", "completed");
  await writeFile(path.join(root, "outbox", "later.txt"), "later output");
  const repeatedFinish = await store.finishTask("thread-1", "turn-1", "failed", "late duplicate event");
  assert.equal(repeatedFinish.status, "completed", "重复终态事件不得覆盖首次终态");
  assert.equal(repeatedFinish.completedAt, firstFinish.completedAt);
  assert.deepEqual(repeatedFinish.outputPaths, firstFinish.outputPaths);
  await rename(
    path.join(root, "outbox", "报告.xlsx"),
    path.join(repository, "outbox", "报告.xlsx"),
  );

  const restarted = new ProjectStore(workspace);
  await restarted.initialize();
  assert.equal(restarted.projectWorkdir(project.id), repository);
  assert.equal(restarted.inbox(project.id), path.join(root, "inbox"));
  assert.equal(restarted.outbox(project.id), path.join(root, "outbox"));
  assert.ok(
    (await readdir(path.join(root, "inbox"))).some((name) =>
      name.includes("-migrated-"),
    ),
    "重名附件必须无覆盖迁移",
  );
  assert.ok(
    (await readdir(path.join(root, "outbox"))).includes("报告.xlsx"),
    "任务成果必须迁回项目私有 outbox",
  );
  assert.equal(
    await readFile(path.join(repository, "inbox", "source.ts"), "utf8"),
    "tracked repository file",
  );
  assert.equal(
    await readFile(path.join(repository, "inbox", "draft.json"), "utf8"),
    "untracked repository asset",
    "有效 Git 仓库中的 untracked 文件绝不能被迁移",
  );
  assert.equal(
    await readFile(path.join(repository, "outbox", "runtime-cache.db"), "utf8"),
    "ignored repository asset",
    "被 .gitignore 忽略的仓库运行时资产绝不能被迁移",
  );

  await restarted.rememberTask("turn-2", "thread-1", project.id, "运行中");
  await assert.rejects(
    () => restarted.archiveProject(project.id, true),
    /运行中的任务/,
  );
  await assert.rejects(
    () => restarted.updateThread("thread-1", project.id, { archived: true }),
    /当前对话仍有任务运行/,
  );
  await assert.rejects(
    () => restarted.deleteThread("thread-1", project.id),
    /当前对话仍有任务运行/,
  );
  await writeFile(path.join(root, "outbox", "中断前成果.txt"), "partial result");
  const crashedTaskIds = restarted.runningTaskIds();
  await restarted.rememberTask("turn-3", "thread-1", project.id, "恢复期间的新任务");
  assert.equal(await restarted.interruptRunningTasks("连接中断", crashedTaskIds), 1);
  const interrupted = restarted.listTasks(project.id).find((task) => task.turnId === "turn-2");
  assert.equal(interrupted.status, "interrupted");
  assert.ok(interrupted.outputPaths.includes("outbox/中断前成果.txt"));
  const newerTask = restarted.listTasks(project.id).find((task) => task.turnId === "turn-3");
  assert.equal(newerTask.status, "running", "恢复过程不得中断捕获集合之后创建的任务");
} finally {
  await rm(workspace, { recursive: true, force: true });
}

const server = await readFile(
  new URL("../server/index.ts", import.meta.url),
  "utf8",
);
const page = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const bridge = await readFile(
  new URL("../server/app-server.ts", import.meta.url),
  "utf8",
);
assert.match(server, /loadedThreads\.clear\(\)/);
assert.match(server, /startingProjects\.has\(message\.projectId\)/);
assert.match(server, /type: 'task\.finished'/);
assert.match(server, /completedAt: task\.completedAt/);
assert.match(server, /\/api\/tasks\/completed/);
assert.match(server, /operation, clientRequestId/);
assert.ok(
  server.indexOf("broadcast({ type: 'codex.offline'") < server.indexOf("void projects.interruptRunningTasks"),
  "offline 必须在异步成果核对前广播",
);
assert.match(server, /bridgeRecoveryPending/);
assert.match(server, /interruptedTaskIds = projects\.runningTaskIds\(\)/);
assert.match(server, /upload-complete[\s\S]{0,900}项目已归档/);
assert.match(server, /--porcelain=v1', '-z'/);
assert.match(page, /const visibleThreads = showArchived/);
assert.match(page, /message\.type === "task\.finished"/);
assert.match(page, /type: "thread\.subscribe", projectId, threadId/);
assert.match(page, /COMPLETION_CURSOR_KEY/);
assert.match(page, /rememberTaskNotification/);
assert.match(page, /projectLoadGenerationRef/);
assert.match(page, /task-notice-stack/);
assert.match(page, /message\.type === "codex\.online"/);
assert.equal(
  page.match(/advanceCompletionCursor\(/g)?.length,
  2,
  "恢复游标只能由函数定义和完整补偿请求推进，实时事件不得推进",
);
assert.match(bridge, /emit\('online'\)/);
const android = await readFile(
  new URL("../../palm-secretary-android/app/src/main/java/cloud/wiseliang/palmsecretary/MainActivity.java", import.meta.url),
  "utf8",
);
assert.match(android, /PalmSecretaryAndroid\/" \+ BuildConfig\.VERSION_NAME/);
assert.doesNotMatch(android, /PalmSecretaryAndroid\/0\.3\.3/);
const androidGradle = await readFile(
  new URL("../../palm-secretary-android/app/build.gradle", import.meta.url),
  "utf8",
);
assert.match(androidGradle, /buildConfig\s+true/);
const projectSelector =
  page.match(
    /<div className="project-picker"[\s\S]{0,1800}role="listbox"[\s\S]{0,1800}<\/div>/,
  )?.[0] ?? "";
assert.ok(projectSelector);
assert.match(projectSelector, /project\.archivedAt/);
assert.doesNotMatch(projectSelector, /disabled=\{Boolean\(project\.archivedAt\)\}/);
assert.match(bridge, /version: packageVersion/);

console.log("PALM_V015_SAFETY_REGRESSIONS_OK");
