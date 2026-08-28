import { readFile } from 'node:fs/promises';
import WebSocket from 'ws';

const cookieJar = await readFile(new URL('../.local-cookie.txt', import.meta.url), 'utf8');
const sessionLine = cookieJar.split('\n').find((line) => line.includes('palm_session'));
if (!sessionLine) throw new Error('测试会话不存在');
const token = sessionLine.trim().split(/\s+/).at(-1);

const socket = new WebSocket(process.env.WS_URL ?? 'ws://localhost:3000/api/ws', {
  headers: { Origin: 'http://localhost:3000', Cookie: `palm_session=${token}` },
});

let output = '';
const timeout = setTimeout(() => {
  console.error('WebSocket 冒烟测试超时');
  process.exit(1);
}, 90_000);

socket.on('message', (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.type === 'ready') {
    socket.send(JSON.stringify({ type: 'turn.start', text: '只回复 PALM_OK，不使用任何工具。' }));
    return;
  }
  if (message.type === 'error') throw new Error(message.message);
  if (message.type !== 'codex.event') return;
  const rpc = message.payload;
  if (rpc?.method === 'item/agentMessage/delta') output += String(rpc.params?.delta ?? '');
  if (rpc?.method === 'turn/completed') {
    clearTimeout(timeout);
    socket.close();
    if (!output.includes('PALM_OK')) throw new Error(`未收到预期回复：${output}`);
    console.log('PALM_WEBSOCKET_SMOKE_OK');
  }
});
