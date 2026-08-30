import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const sourceText = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const source = ts.createSourceFile(
  "page.tsx",
  sourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

const effects = [];
const callbacks = new Map();
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    ts.isCallExpression(node.initializer) &&
    ts.isIdentifier(node.initializer.expression) &&
    node.initializer.expression.text === "useCallback"
  )
    callbacks.set(node.name.text, node.initializer);
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "useEffect"
  )
    effects.push(node);
  ts.forEachChild(node, visit);
}
visit(source);

const textOf = (node) => node?.getText(source) ?? "";
const dependencies = (effect) => {
  const value = effect.arguments[1];
  assert.ok(value && ts.isArrayLiteralExpression(value), "effect 必须声明依赖数组");
  return value.elements.map(textOf);
};

const projectResetEffect = effects.find((effect) =>
  textOf(effect.arguments[0]).includes("setMessages([])"),
);
assert.ok(projectResetEffect, "应存在项目切换时的 UI 重置 effect");
assert.deepEqual(
  dependencies(projectResetEffect),
  ["authenticated", "projectId", "loadProjectCore", "loadThreads"],
  "项目生命周期不能依赖归档筛选或会随筛选变化的聚合 callback",
);

const archiveFilterEffect = effects.find((effect) => {
  const body = textOf(effect.arguments[0]);
  const deps = dependencies(effect);
  return body.includes("loadThreads(projectId, showArchived)") && deps.includes("showArchived");
});
assert.ok(archiveFilterEffect, "归档筛选应有独立的记录列表 effect");
const archiveBody = textOf(archiveFilterEffect.arguments[0]);
for (const forbidden of [
  "setThreadId",
  "setMessages",
  "setRunning",
  "setAttachments",
  "new WebSocket",
])
  assert.ok(
    !archiveBody.includes(forbidden),
    `归档筛选不得执行 ${forbidden}`,
  );

const socketEffect = effects.find((effect) =>
  textOf(effect.arguments[0]).includes("new WebSocket"),
);
assert.ok(socketEffect, "应找到 WebSocket 生命周期 effect");
assert.ok(
  !dependencies(socketEffect).includes("showArchived"),
  "归档筛选不得重建 WebSocket",
);

const aggregateLoader = callbacks.get("loadProjectData");
assert.ok(aggregateLoader, "应保留稳定的统一刷新入口");
assert.deepEqual(
  textOf(aggregateLoader.arguments[1]),
  "[loadProjectCore, loadThreads]",
  "统一刷新入口只能依赖稳定的核心与列表加载器",
);

console.log("PALM_V016_ARCHIVE_FILTER_OK");
