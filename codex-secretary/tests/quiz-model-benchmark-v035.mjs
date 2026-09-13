import { randomUUID } from 'node:crypto';
import { QuizAnalyzer } from '../dist-server/quiz-analyzer.js';

const model = process.env.QUIZ_BENCHMARK_MODEL;
if (!model) throw new Error('QUIZ_BENCHMARK_MODEL is required');
const analyzer = new QuizAnalyzer(async () => ({ model, effort: 'low' }));
const cases = [
  ['single_choice', '十二加二等于多少？', ['B'], [['A', '十三'], ['B', '十四'], ['C', '十五'], ['D', '十六']]],
  ['single_choice', '水在标准大气压下的沸点是哪一项？', ['C'], [['A', '0℃'], ['B', '50℃'], ['C', '100℃'], ['D', '200℃']]],
  ['multiple_choice', '下列哪些数字是偶数？', ['B', 'D'], [['A', '一'], ['B', '二'], ['C', '三'], ['D', '四']]],
  ['multiple_choice', '下列哪些属于哺乳动物？', ['A', 'C'], [['A', '鲸'], ['B', '鲫鱼'], ['C', '蝙蝠'], ['D', '企鹅']]],
  ['true_false', '地球绕太阳公转。', ['A'], [['A', '正确'], ['B', '错误']]],
  ['true_false', '二加二等于五。', ['B'], [['A', '正确'], ['B', '错误']]],
];
const rows = [];
try {
  await analyzer.warm();
  for (const [questionType, question, expected, options] of cases) {
    const started = performance.now();
    try {
      const outcome = await analyzer.analyze({ schemaVersion: '1', clientRequestId: randomUUID(),
        sourcePackage: 'com.example.modelbenchmark', questionType, question,
        options: options.map(([optionId, text]) => ({ optionId, text })), captureMode: 'accessibility' });
      rows.push({ ms: Math.round(performance.now() - started), correct:
        JSON.stringify([...outcome.result.answer].sort()) === JSON.stringify([...expected].sort()),
      repair: outcome.metrics.repair });
    } catch { rows.push({ ms: Math.round(performance.now() - started), correct: false, error: true }); }
  }
} finally { await analyzer.close(); }
const durations = rows.map((row) => row.ms).sort((a, b) => a - b);
console.log(JSON.stringify({ model, count: rows.length, median: durations[2], max: durations.at(-1),
  accuracy: rows.filter((row) => row.correct).length / rows.length,
  errors: rows.filter((row) => row.error).length, repairs: rows.filter((row) => row.repair).length }));
