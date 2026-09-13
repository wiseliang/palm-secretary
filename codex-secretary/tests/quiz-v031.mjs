import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { quizAnalysisRequestSchema, quizAnalysisResultSchema } from '../dist-server/quiz-schema.js';
import { registerQuizRoutes } from '../dist-server/quiz-routes.js';

const request = {
  schemaVersion: '1',
  clientRequestId: 'b37d9d8e-629e-4e31-93b2-68d9ec38f251',
  sourcePackage: 'com.example.quiz',
  questionType: 'single_choice',
  question: '固定测试题的题干内容？',
  options: [
    { optionId: 'A', text: '固定选项一' },
    { optionId: 'B', text: '固定选项二' },
  ],
  captureMode: 'accessibility',
};
const result = {
  schemaVersion: '1',
  questionType: 'single_choice',
  answer: ['B'],
  confidence: 0.9,
  shortExplanation: '固定测试解释。',
  fullExplanation: '固定测试完整解释。',
  optionAnalysis: [
    { optionId: 'A', verdict: 'incorrect', explanation: '不符合。' },
    { optionId: 'B', verdict: 'correct', explanation: '符合。' },
  ],
  knowledgePoints: ['固定知识点'],
  memoryTip: '固定记忆提示。',
  warnings: [],
};
const outcome = { result, metrics: {
  bridgeAcquireMs: 0, threadCreateMs: 1, promptPrepareMs: 0, modelTurnMs: 2,
  finalModelEventMs: 2, outputParseMs: 0, repairMs: 0, repair: false,
  model: 'fixed-model', effort: 'low',
} };

assert.equal(quizAnalysisRequestSchema.safeParse(request).success, true);
assert.equal(quizAnalysisResultSchema.safeParse(result).success, true);
assert.equal(quizAnalysisRequestSchema.safeParse({ ...request, options: [] }).success, false);
assert.equal(quizAnalysisRequestSchema.safeParse({ ...request, question: 'x'.repeat(4001) }).success, false);
assert.equal(quizAnalysisResultSchema.safeParse({ ...result, answer: 'B' }).success, false);
assert.equal(quizAnalysisResultSchema.safeParse({ ...result, answer: ['Z'] }).success, false);

const app = Fastify({ logger: false });
await app.register(cookie);
registerQuizRoutes(app, () => true, { analyze: async () => outcome });
const ok = await app.inject({ method: 'POST', url: '/api/quiz-analysis',
  headers: { cookie: 'palm_session=fixed-test-session' }, payload: request });
assert.equal(ok.statusCode, 200);
assert.deepEqual(ok.json().answer, ['B']);
assert.match(ok.headers['server-timing'], /model;dur=2/);
assert.equal(ok.headers['x-palm-quiz-repair'], '0');

const invalid = await app.inject({ method: 'POST', url: '/api/quiz-analysis',
  headers: { cookie: 'palm_session=fixed-test-session' }, payload: { ...request, options: [] } });
assert.equal(invalid.statusCode, 400);

const unauthorizedApp = Fastify({ logger: false });
await unauthorizedApp.register(cookie);
registerQuizRoutes(unauthorizedApp, (_request, reply) => {
  void reply.code(401).send({ error: '请先登录' }); return false;
}, { analyze: async () => outcome });
const unauthorized = await unauthorizedApp.inject({ method: 'POST', url: '/api/quiz-analysis', payload: request });
assert.equal(unauthorized.statusCode, 401);

const modelErrorApp = Fastify({ logger: false });
await modelErrorApp.register(cookie);
registerQuizRoutes(modelErrorApp, () => true, {
  analyze: async () => { throw Object.assign(new Error('fixed model failure'), { code: 'MODEL_ERROR' }); },
});
const modelError = await modelErrorApp.inject({ method: 'POST', url: '/api/quiz-analysis', payload: request });
assert.equal(modelError.statusCode, 502);
assert.equal(modelError.json().code, 'MODEL_ERROR');

const invalidOutputApp = Fastify({ logger: false });
await invalidOutputApp.register(cookie);
registerQuizRoutes(invalidOutputApp, () => true, {
  analyze: async () => { throw Object.assign(new Error('fixed schema failure'), { code: 'MODEL_OUTPUT_INVALID' }); },
});
const invalidOutput = await invalidOutputApp.inject({ method: 'POST', url: '/api/quiz-analysis', payload: request });
assert.equal(invalidOutput.statusCode, 502);
assert.equal(invalidOutput.json().code, 'MODEL_OUTPUT_INVALID');

const serverErrorApp = Fastify({ logger: false });
await serverErrorApp.register(cookie);
registerQuizRoutes(serverErrorApp, () => true, { analyze: async () => { throw new Error('fixed server failure'); } });
const serverError = await serverErrorApp.inject({ method: 'POST', url: '/api/quiz-analysis', payload: request });
assert.equal(serverError.statusCode, 503);
assert.equal(serverError.json().code, 'SERVER_ERROR');

const rateApp = Fastify({ logger: false });
await rateApp.register(cookie);
registerQuizRoutes(rateApp, () => true, { analyze: async () => outcome });
for (let index = 0; index < 6; index += 1) {
  const response = await rateApp.inject({ method: 'POST', url: '/api/quiz-analysis',
    headers: { cookie: 'palm_session=stable-rate-test' },
    payload: { ...request, clientRequestId: `b37d9d8e-629e-4e31-93b2-68d9ec38f2${String(index).padStart(2, '0')}` } });
  assert.equal(response.statusCode, 200);
}
const limited = await rateApp.inject({ method: 'POST', url: '/api/quiz-analysis',
  headers: { cookie: 'palm_session=stable-rate-test' },
  payload: { ...request, clientRequestId: 'b37d9d8e-629e-4e31-93b2-68d9ec38f299' } });
assert.equal(limited.statusCode, 429);

const concurrentApp = Fastify({ logger: false });
await concurrentApp.register(cookie);
const releases = [];
registerQuizRoutes(concurrentApp, () => true, {
  analyze: async () => new Promise((resolve) => releases.push(() => resolve(outcome))),
});
const concurrentRequest = (suffix) => concurrentApp.inject({ method: 'POST', url: '/api/quiz-analysis',
  headers: { cookie: 'palm_session=stable-concurrency-test' },
  payload: { ...request, clientRequestId: `b37d9d8e-629e-4e31-93b2-68d9ec38f3${suffix}` } });
const first = concurrentRequest('01');
const second = concurrentRequest('02');
while (releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
const busy = await concurrentRequest('03');
assert.equal(busy.statusCode, 503);
releases.forEach((release) => release());
assert.equal((await first).statusCode, 200);
assert.equal((await second).statusCode, 200);

await app.close();
await unauthorizedApp.close();
await modelErrorApp.close();
await invalidOutputApp.close();
await serverErrorApp.close();
await rateApp.close();
await concurrentApp.close();

const configSource = await readFile(new URL('../server/config.ts', import.meta.url), 'utf8');
const indexSource = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
assert.match(configSource, /quizModel:\s*process\.env\.QUIZ_MODEL\?\.trim\(\)\s*\|\|\s*'gpt-5\.6-sol'/,
  'Quiz 必须支持独立 QUIZ_MODEL，并以 Sol 为安全默认值');
assert.match(indexSource, /new QuizAnalyzer\(async \(\) => \(\{ model: config\.quizModel, effort: 'low' \}\)\)/,
  'QuizAnalyzer 不得继续跟随聊天默认项目模型');
console.log('PALM_V031_QUIZ_OK');
