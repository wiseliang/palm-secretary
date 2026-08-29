import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const page = await readFile(
  new URL("../app/page.tsx", import.meta.url),
  "utf8",
);
const css = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const pkg = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

assert.ok(pkg.dependencies["@phosphor-icons/react"]);
assert.match(page, /aria-label="对话"[\s\S]{0,120}setView\("chat"\)/);
assert.match(page, /header-project-menu/);
assert.match(page, /runtime-toggle/);
assert.match(page, /new ResizeObserver\(update\)/);
assert.match(page, /--composer-height/);
assert.match(css, /--accent:\s*#275fc5/);
assert.match(
  css,
  /padding-bottom:\s*calc\(var\(--composer-height\)\s*\+\s*28px\)/,
);
assert.match(css, /@media\s*\(max-width:\s*899px\)/);
assert.match(css, /\.mobile-tabs button[\s\S]{0,180}min-height:\s*44px/);
assert.doesNotMatch(page, /项目操作 ⋯/);

console.log("PALM_V014_DESIGN_SYSTEM_OK");
