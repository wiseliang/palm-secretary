import { randomUUID } from 'node:crypto';
import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const endpoint = process.env.QUIZ_BENCHMARK_URL ?? 'http://127.0.0.1:4511/api/quiz-analysis';
const tests = [];
for (let n = 1; n <= 10; n += 1) {
  tests.push({ type: 'single_choice', question: `${n} 加 2 的结果是哪一项？`, expected: ['B'], options: [
    { optionId: 'A', text: String(n + 1) }, { optionId: 'B', text: String(n + 2) },
    { optionId: 'C', text: String(n + 3) }, { optionId: 'D', text: String(n + 4) },
  ] });
  const base = n * 4;
  tests.push({ type: 'multiple_choice', question: '下列数字中，哪些是偶数？', expected: ['B', 'D'], options: [
    { optionId: 'A', text: String(base + 1) }, { optionId: 'B', text: String(base + 2) },
    { optionId: 'C', text: String(base + 3) }, { optionId: 'D', text: String(base + 4) },
  ] });
  const trueStatement = n % 2 === 1;
  tests.push({ type: 'true_false', question: trueStatement
    ? `${n} 加 ${n} 等于 ${n * 2}。` : `${n} 加 ${n} 等于 ${n * 2 + 1}。`,
  expected: [trueStatement ? 'A' : 'B'], options: [
    { optionId: 'A', text: '正确' }, { optionId: 'B', text: '错误' },
  ] });
}

const rows = [];
let token = '';
for (let index = 0; index < tests.length; index += 1) {
  if (index % 5 === 0) token = createSession(config.sessionSecret, 1);
  const item = tests[index];
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `palm_session=${token}` },
    body: JSON.stringify({
      schemaVersion: '1', clientRequestId: randomUUID(), sourcePackage: 'com.example.benchmark',
      questionType: item.type, question: item.question, options: item.options, captureMode: 'accessibility',
    }),
  });
  const body = await response.json();
  const actual = Array.isArray(body.answer) ? [...body.answer].sort() : [];
  rows.push({
    type: item.type, ms: Math.round(performance.now() - started), status: response.status,
    correct: JSON.stringify(actual) === JSON.stringify([...item.expected].sort()),
    repair: response.headers.get('x-palm-quiz-repair') === '1',
    serverTiming: response.headers.get('server-timing') ?? '',
  });
  console.log(`QUIZ_BENCHMARK_PROGRESS ${index + 1}/${tests.length}`);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil((p / 100) * sorted.length) - 1];
}
function summarize(group) {
  const values = group.map((row) => row.ms);
  return {
    count: group.length,
    mean: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    median: percentile(values, 50), p75: percentile(values, 75), p95: percentile(values, 95),
    min: Math.min(...values), max: Math.max(...values),
    accuracy: group.filter((row) => row.correct).length / group.length,
    errors: group.filter((row) => row.status !== 200).length,
    repairs: group.filter((row) => row.repair).length,
  };
}
const result = { overall: summarize(rows), byType: {} };
for (const type of ['single_choice', 'multiple_choice', 'true_false']) {
  result.byType[type] = summarize(rows.filter((row) => row.type === type));
}
console.log(`QUIZ_BENCHMARK_RESULT ${JSON.stringify(result)}`);
