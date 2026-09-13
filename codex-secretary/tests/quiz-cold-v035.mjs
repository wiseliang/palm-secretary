import { randomUUID } from 'node:crypto';
import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const token = createSession(config.sessionSecret, 1);
const started = performance.now();
const response = await fetch('http://127.0.0.1:4511/api/quiz-analysis', {
  method: 'POST', headers: { 'content-type': 'application/json', cookie: `palm_session=${token}` },
  body: JSON.stringify({ schemaVersion: '1', clientRequestId: randomUUID(),
    sourcePackage: 'com.example.coldbenchmark', questionType: 'single_choice',
    question: '七加二的结果是哪一项？', options: [
      { optionId: 'A', text: '八' }, { optionId: 'B', text: '九' },
      { optionId: 'C', text: '十' }, { optionId: 'D', text: '十一' },
    ], captureMode: 'accessibility' }),
});
const body = await response.json();
console.log(JSON.stringify({ ms: Math.round(performance.now() - started), status: response.status,
  correct: Array.isArray(body.answer) && body.answer.length === 1 && body.answer[0] === 'B',
  serverTiming: response.headers.get('server-timing') }));
