import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const cookie = `palm_session=${createSession(config.sessionSecret, 1)}`;
let threadId;
let matched = false;
let completed = false;
try {
  await new Promise((resolve, reject) => {
    const socket = new WebSocket('ws://127.0.0.1:4511/api/ws', { headers: { Cookie: cookie } });
    const timer = setTimeout(() => { socket.close(); reject(new Error('chat smoke timeout')); }, 120_000);
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'error') { clearTimeout(timer); socket.close(); reject(new Error(event.message)); return; }
      if (event.type === 'ready') socket.send(JSON.stringify({ type: 'turn.start',
        clientRequestId: randomUUID(), projectId: 'default', text: '请只回复 CHAT_SMOKE_OK' }));
      if (event.type === 'turn.accepted') threadId = event.threadId;
      const item = event.payload?.params?.item;
      if (event.type === 'codex.event' && item?.type === 'agentMessage' && typeof item.text === 'string') {
        matched ||= item.text.includes('CHAT_SMOKE_OK');
      }
      if (event.type === 'codex.event' && event.payload?.method === 'turn/completed') {
        completed = true; clearTimeout(timer); socket.close(); resolve();
      }
    });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
} finally {
  if (threadId) await fetch(`http://127.0.0.1:4511/api/threads/${encodeURIComponent(threadId)}?projectId=default`,
    { method: 'DELETE', headers: { cookie } });
}
console.log(JSON.stringify({ completed, matched, threadCleaned: Boolean(threadId) }));
if (!completed || !matched) process.exitCode = 1;
