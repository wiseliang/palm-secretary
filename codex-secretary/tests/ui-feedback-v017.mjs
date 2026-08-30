import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
const styles = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);

const noticeIndex = page.indexOf('className="global-notice"');
const composerIndex = page.indexOf('className={`composer-wrap');
assert.ok(noticeIndex >= 0, "业务反馈应渲染为全局 notice");
assert.ok(
  noticeIndex < composerIndex,
  "全局 notice 必须位于 composer 外，记录和文件页也能看到",
);
assert.match(styles, /\.global-notice\s*\{[^}]*position:\s*fixed/s);

assert.match(
  page,
  /async function openGitReview\(\)\s*\{\s*setView\("history"\);\s*setGitOpen\(true\);\s*await loadGitStatus\(false\);/s,
  "代码变更入口应导航到记录页并打开审核面板",
);
assert.match(page, /setOpenMenu\(undefined\);\s*void openGitReview\(\);/);

assert.match(
  page,
  /const projectReadOnly = Boolean\(activeProject\?\.archivedAt\)/,
  "归档只读状态应统一派生",
);
for (const operation of [
  "newConversation",
  "renameProject",
  "duplicateProject",
  "runGitAction",
  "updateThread",
  "deleteThread",
  "saveModel",
  "deleteFile",
]) {
  const start = page.indexOf(`function ${operation}`);
  assert.ok(start >= 0, `应找到 ${operation}`);
  assert.ok(
    page.slice(start, start + 900).includes("projectReadOnly"),
    `${operation} 必须在函数层阻止归档项目写操作`,
  );
}
assert.doesNotMatch(page, /className="readonly-banner"/);

const previewAnchor = page.match(
  /<a\s+href=\{`\/api\/files\/preview\?\$\{query\}`\}[\s\S]*?>/,
)?.[0];
assert.ok(previewAnchor, "应存在文件预览入口");
assert.ok(!previewAnchor.includes("target="), "内部预览不得依赖 WebView 新窗口");

assert.match(page, /ref=\{imageFileRef\}[\s\S]*?accept="image\/\*"/);
assert.match(page, /imageFileRef\.current\?\.click\(\)/);

assert.match(
  page,
  /void openThreadById\(\s*task\.projectId,\s*task\.threadId,\s*task\.title/s,
  "最近任务应直接按项目和 threadId 定位，不依赖当前列表",
);

assert.match(page, /recordSearch\.trim\(\)\.length === 1/);
assert.match(page, /至少输入 2 个字/);
assert.match(page, /setTaskNotices\(\[\]\).*全部清除/s);
assert.match(page, /className="task-notice-dismiss"/);

const addButton = page.match(
  /<button\s+className="project-add"[\s\S]*?<\/button>/,
)?.[0];
assert.ok(addButton?.includes("onClick={newConversation}"));
assert.ok(addButton?.includes("新任务"));
assert.match(page, /openProjectDialog\("create"\)[\s\S]*?新建项目/);

console.log("PALM_V017_UI_FEEDBACK_OK");
