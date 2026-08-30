import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/interaction-polish.css", import.meta.url), "utf8");
const android = readFileSync(
  new URL("../../palm-secretary-android/app/src/main/java/cloud/wiseliang/palmsecretary/MainActivity.java", import.meta.url),
  "utf8",
);

assert.match(page, /data-popover-root/);
assert.match(page, /document\.addEventListener\("pointerdown", closeMenus\)/);
assert.match(page, /event\.key !== "Escape"/);
assert.doesNotMatch(page, /<details className="project-menu header-project-menu"/);
assert.doesNotMatch(page, /<details className="record-actions-menu"/);

assert.match(page, /className="project-picker-trigger"/);
assert.match(page, /role="listbox"/);
assert.match(page, /className="project-dialog"/);
assert.doesNotMatch(page, /window\.prompt\("新项目名称"/);
assert.doesNotMatch(css, /\.topbar \.project-add::before \{ content: ['"]\+['"]/);

assert.match(page, /添加到当前任务/);
assert.match(page, /上传文件/);
assert.match(page, /照片和图片/);
assert.match(page, /accept="image\/\*"/);
assert.doesNotMatch(page, /camera-button/);
assert.match(android, /boolean imagesOnly/);
assert.match(android, /imagesOnly \? Intent\.ACTION_GET_CONTENT : Intent\.ACTION_OPEN_DOCUMENT/);

assert.match(page, /setTimeout\(\(\) => setNotice\(""\), 4200\)/);
assert.match(page, /className="mobile-identity"/);
assert.match(page, /最近执行/);
assert.match(page, /任务记录/);
assert.doesNotMatch(page, /className="readonly-banner"/);

assert.match(page, /palm:pending-attachments:/);
assert.match(page, /readPendingAttachments\(projectId\)/);
assert.match(page, /已恢复 \$\{restoredAttachments\.length\} 个待发送附件/);
assert.doesNotMatch(page, /\| "usage"/);
assert.doesNotMatch(page, /const \[usageOpen, setUsageOpen\]/);
assert.match(page, /className="mobile-menu-only"/);
assert.match(css, /\.runtime-toggle \{ display: none; \}/);
assert.match(css, /max-height: calc\(100dvh - 32px\)/);
assert.match(css, /border-radius: 22px 22px 0 0/);
assert.match(page, /await openThreadById\(task\.projectId, task\.threadId, task\.title\)/);
assert.doesNotMatch(page, /threads\.find\(\(item\) => item\.threadId === task\.threadId\)/);
assert.match(page, /connection === "正在重连"\s*\? "重连"/);
assert.match(page, /function closeProjectDialog|const closeProjectDialog/);
assert.match(page, /if \(projectDialogBusyRef\.current \|\| projectDialogBusy\) return/);
assert.match(page, /disabled=\{projectDialogBusy\}/);
assert.match(page, /正在处理，请稍候/);
assert.match(page, /className="usage-overview"/);
assert.match(page, /className="usage-overview-window"/);
assert.doesNotMatch(page, /className="usage-popover"/);
assert.match(css, /grid-template-columns: auto minmax\(0, 1fr\) 38px/);

console.log("interaction polish v018 passed");
