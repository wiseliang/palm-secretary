import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

assert.ok(/^0\.(?:1[0-9]|[2-9][0-9])\.\d+$/.test(pkg.version), `版本号 ${pkg.version} 低于视觉系统基线 0.10.0`);
assert.match(css, /--jade:\s*#275fc5/);
assert.match(css, /--radius-control:\s*10px/);
assert.match(css, /--radius-card:\s*14px/);
assert.match(css, /:focus-visible/);
assert.match(css, /button:not\(:disabled\):active/);
assert.match(css, /\.composer:focus-within/);
assert.match(css, /@media \(prefers-color-scheme: dark\)/);
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
assert.doesNotMatch(page, /[—–]/);

console.log('PALM_VISUAL_SYSTEM_V010_OK');
