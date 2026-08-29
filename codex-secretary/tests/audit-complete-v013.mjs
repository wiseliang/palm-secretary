import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const server = await readFile(
  new URL("../server/index.ts", import.meta.url),
  "utf8",
);
const store = await readFile(
  new URL("../server/project-store.ts", import.meta.url),
  "utf8",
);
const page = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const css = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const android = await readFile(
  new URL(
    "../../palm-secretary-android/app/src/main/java/cloud/wiseliang/palmsecretary/MainActivity.java",
    import.meta.url,
  ),
  "utf8",
);
const harmony = await readFile(
  new URL(
    "../../palm-secretary-harmony/entry/src/main/ets/pages/Index.ets",
    import.meta.url,
  ),
  "utf8",
);

for (const route of ["upload-session", "upload-chunk", "upload-complete"])
  assert.match(server, new RegExp(`/api/files/${route}`));
assert.match(server, /UPLOAD_PART_TTL_MS = 24 \* 60 \* 60 \* 1000/);
assert.match(server, /app\.delete[^\n]*\/api\/files\/upload-session/);
assert.match(server, /reply\.code\(507\)/);
assert.match(store, /interruptRunningTasks\(reason: string\)/);
assert.match(server, /bridge\.on\('offline', async/);
assert.match(store, /projectWorkdir\(id: string\)/);
assert.match(server, /setProjectWorkdir\(project\.id, 'repository'\)/);
assert.match(server, /await projects\.deleteProject\(project\.id\)/);
assert.match(server, /stagedDiff/);
assert.match(server, /unstagedDiff/);
assert.match(page, /gitStatus\.projectId !== projectId/);
assert.match(page, /PendingNavigation/);
assert.match(page, /activeProject\?\.archivedAt/);
assert.match(page, /header-project-menu/);
assert.match(page, /aria-label="项目操作"/);
assert.match(css, /grid-template-columns: 1fr auto auto/);
assert.match(android, /window\.__PALM_OPEN_TASK__/);
assert.match(android, /ackTaskTarget/);
assert.match(harmony, /32 \* 1024 \* 1024/);

console.log("PALM_V013_AUDIT_COMPLETE_OK");
