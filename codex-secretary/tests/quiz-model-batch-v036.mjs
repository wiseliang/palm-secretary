import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { QuizAnalyzer, QuizAnalyzerError } from '../dist-server/quiz-analyzer.js';
import { quizModelCases } from './fixtures/quiz-model-v036.mjs';

const model = process.env.QUIZ_BENCHMARK_MODEL;
const start = Number(process.env.QUIZ_BENCHMARK_START || 0);
const count = Number(process.env.QUIZ_BENCHMARK_COUNT || 10);
const output = process.env.QUIZ_BENCHMARK_OUTPUT;
if (!['gpt-5.6-sol','gpt-5.6-terra'].includes(model) || !output) throw new Error('model/output required');
const cases = quizModelCases.slice(start, start + count);
if (cases.length !== count) throw new Error('invalid batch range');
const analyzer = new QuizAnalyzer(async () => ({model, effort:'low'}));
const sorted = (value) => [...value].map(String).sort();
const equalAnswer = (left,right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const rows = [];
try {
  await analyzer.warm();
  for (const item of cases) {
    const startedAt = performance.now();
    const base = {id:item.id,model,effort:'low',questionType:item.questionType,difficulty:item.difficulty,
      expected:item.expected,expectWarning:Boolean(item.expectWarning),accuracyEligible:item.accuracyEligible !== false};
    try {
      const outcome = await analyzer.analyze({schemaVersion:'1',clientRequestId:randomUUID(),
        sourcePackage:'com.example.quizbenchmark',questionType:item.questionType,question:item.question,
        options:item.options,captureMode:'accessibility'});
      rows.push({...base,actual:outcome.result.answer,correct:equalAnswer(item.expected,outcome.result.answer),
        firstSchemaValid:!outcome.metrics.repair,repair:outcome.metrics.repair,repairSuccess:outcome.metrics.repair,
        confidence:outcome.result.confidence,warnings:outcome.result.warnings,
        warningCount:outcome.result.warnings.length,shortExplanation:outcome.result.shortExplanation,
        fullExplanation:outcome.result.fullExplanation,optionAnalysis:outcome.result.optionAnalysis,
        knowledgePoints:outcome.result.knowledgePoints,memoryTip:outcome.result.memoryTip,
        threadCreateMs:outcome.metrics.threadCreateMs,firstContentMs:outcome.metrics.firstModelEventMs,
        modelTurnMs:outcome.metrics.modelTurnMs,totalMs:Math.round(performance.now()-startedAt),status:'ok'});
    } catch (error) {
      const metrics = error instanceof QuizAnalyzerError ? error.metrics : undefined;
      rows.push({...base,actual:[],correct:false,firstSchemaValid:false,repair:Boolean(metrics?.repair),
        repairSuccess:false,confidence:null,warnings:[],warningCount:0,threadCreateMs:metrics?.threadCreateMs,
        firstContentMs:metrics?.firstModelEventMs,modelTurnMs:metrics?.modelTurnMs,
        totalMs:Math.round(performance.now()-startedAt),status:error instanceof QuizAnalyzerError ? error.code : 'UNEXPECTED_ERROR',
        error:String(error?.message || error)});
    }
    await writeFile(output,JSON.stringify({model,start,count,rows},null,2),{mode:0o600});
    console.log(JSON.stringify({model,start,progress:rows.length,count,id:item.id,status:rows.at(-1).status,totalMs:rows.at(-1).totalMs,error:rows.at(-1).error}));
  }
} finally {
  await analyzer.close();
}
