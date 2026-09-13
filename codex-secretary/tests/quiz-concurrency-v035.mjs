import { randomUUID } from 'node:crypto';
import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const token = createSession(config.sessionSecret, 1);
const request = (index) => {
  const started = performance.now();
  return fetch('http://127.0.0.1:4511/api/quiz-analysis', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `palm_session=${token}` },
    body: JSON.stringify({ schemaVersion: '1', clientRequestId: randomUUID(),
      sourcePackage: 'com.example.concurrency', questionType: 'single_choice',
      question: `${index} 加 2 的结果是哪一项？`, options: [
        { optionId: 'A', text: String(index + 1) }, { optionId: 'B', text: String(index + 2) },
        { optionId: 'C', text: String(index + 3) }, { optionId: 'D', text: String(index + 4) },
      ], captureMode: 'accessibility' }),
  }).then(async (response) => ({ status: response.status, ms: Math.round(performance.now() - started),
    code: response.ok ? 'OK' : (await response.json()).code }));
};
console.log(JSON.stringify(await Promise.all([request(11), request(12), request(13)])));
