import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');

assert.match(page, /function safeServerFilePath/);
assert.match(page, /\^\(inbox\|outbox\)/);
assert.match(page, /function ServerImage/);
assert.match(page, /api\/files\/preview/);
assert.match(page, /data-message-id=\{message\.id\}/);
assert.match(page, /scrollIntoView\(\{\s*behavior:\s*["']smooth["'],\s*block:\s*["']center["'],?\s*\}\)/);
assert.match(page, /openThread\(thread, task\.title\)/);
assert.match(css, /\.inline-server-image/);
assert.match(css, /@keyframes message-focus/);
assert.match(server, /!\[图片说明\]\(outbox\/实际文件名\.png\)/);

console.log('v0.9 inline image and exact history focus checks passed');
