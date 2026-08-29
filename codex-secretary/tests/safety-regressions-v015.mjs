import assert from "node:assert/strict";
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
import { ProjectStore } from "../dist-server/project-store.js";

const workspace = await mkdtemp(path.join(tmpdir(), "palm-v015-"));
try {
  const store = new ProjectStore(workspace);
  await store.initialize();
  const project = await store.createProject("GitHub 项目");
  const root = store.projectRoot(project.id);
  const repository = path.join(root, "repository");
  await mkdir(path.join(repository, ".git"), { recursive: true });
  await mkdir(path.join(repository, "inbox"), { recursive: true });
  await mkdir(path.join(repository, "outbox"), { recursive: true });
  await store.setProjectWorkdir(project.id, "repository");

  const upload = "123e4567-e89b-42d3-a456-426614174000-contract.pdf";
  await writeFile(path.join(root, "inbox", upload), "existing");
  await writeFile(path.join(repository, "inbox", upload), "migrated");
  await writeFile(
    path.join(repository, "inbox", "source.ts"),
    "tracked-looking repository file",
  );
  await store.rememberThread("thread-1", project.id, "测试");
  await store.rememberTask("turn-1", "thread-1", project.id, "生成报告", [
    `inbox/${upload}`,
  ]);
  await writeFile(path.join(root, "outbox", "报告.xlsx"), "report");
  await store.finishTask("thread-1", "turn-1", "completed");
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
    "tracked-looking repository file",
  );

  await restarted.rememberTask("turn-2", "thread-1", project.id, "运行中");
  await assert.rejects(
    () => restarted.archiveProject(project.id, true),
    /运行中的任务/,
  );
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
assert.match(server, /upload-complete[\s\S]{0,900}项目已归档/);
assert.match(server, /--porcelain=v1', '-z'/);
assert.match(page, /const visibleThreads = showArchived/);
assert.match(page, /message\.type === "task\.finished"/);
const projectSelector =
  page.match(
    /<select[\s\S]{0,500}aria-label="当前项目"[\s\S]{0,500}<\/select>/,
  )?.[0] ?? "";
assert.ok(projectSelector);
assert.doesNotMatch(projectSelector, /activeProject\?\.archivedAt/);
assert.match(bridge, /version: packageVersion/);

console.log("PALM_V015_SAFETY_REGRESSIONS_OK");
