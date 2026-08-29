import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../app/page.tsx', import.meta.url), 'utf8');
const server = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');

assert.match(server, /const socketThreads = new Map<SocketLike, string>\(\)/, '服务端必须记录每个 socket 当前唯一对话');
assert.match(server, /function setSocketThread[\s\S]*detachSocketFromThread\(socket\)[\s\S]*socketThreads\.set\(socket, threadId\)/, '切换对话前必须解除旧订阅');
assert.doesNotMatch(server, /function attachSocketToThread/, '不应保留可累积多对话订阅的旧实现');
assert.match(page, /eventThreadId && eventThreadId !== threadIdRef\.current\) return/, '前端必须拒绝非当前对话事件');
assert.match(page, /wouldDowngradeLongOutput[\s\S]*storedAssistant\.length < liveAssistant\.length/, '历史对账不得用较短内容覆盖长流式输出');
assert.match(page, /4_500/, '任务结束后必须为持久化延迟保留最终重试');
assert.match(page, /threadIdRef\.current = message\.threadId;[\s\S]*setThreadId\(message\.threadId\)/, '新对话 accepted 后必须同步更新事件过滤引用');

console.log('PALM_V012_STABILITY_OK');
