import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const imagePath = process.argv[2];
const count = Number(process.argv[3] || 1);
const requestedMode = process.argv[4] || 'both';
if (!imagePath || !Number.isInteger(count) || count < 1) throw new Error('usage: script image.png [count]');
const image = await readFile(imagePath);
const cookie = `palm_session=${createSession(config.sessionSecret, 1)}`;

async function run(captureMode) {
  const times = [];
  let ok = 0;
  for (let index = 0; index < count; index += 1) {
    const metadata = {
      schemaVersion: '1', clientRequestId: randomUUID(), sourcePackage: 'com.example.vision.smoke',
      captureMode, questionType: captureMode === 'hybrid' ? 'single_choice' : 'unknown',
      question: captureMode === 'hybrid' ? 'Which planet is known as the Red Planet?' : '',
      options: captureMode === 'hybrid' ? [
        { optionId: 'A', text: 'Venus' }, { optionId: 'B', text: 'Mars' },
        { optionId: 'C', text: 'Jupiter' }, { optionId: 'D', text: 'Neptune' },
      ] : [], imageWidth: 900, imageHeight: 600,
    };
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('image', new Blob([image], { type: 'image/png' }), 'question.png');
    const started = performance.now();
    const response = await fetch('http://127.0.0.1:4511/api/quiz-analysis/vision', {
      method: 'POST', headers: { cookie }, body: form,
    });
    const body = await response.json();
    const elapsed = Math.round(performance.now() - started);
    times.push(elapsed);
    if (response.ok && Array.isArray(body.answer) && body.answer.includes('B')) ok += 1;
    console.log(JSON.stringify({ captureMode, run: index + 1, status: response.status, elapsedMs: elapsed }));
  }
  const sorted = [...times].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
  return { count, ok, medianMs: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) };
}

const result = {};
if (requestedMode === 'both' || requestedMode === 'hybrid') result.hybrid = await run('hybrid');
if (requestedMode === 'both' || requestedMode === 'vision') result.vision = await run('vision');
console.log(JSON.stringify(result));
