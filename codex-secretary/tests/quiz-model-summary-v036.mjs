import { readFile } from 'node:fs/promises';

const input = process.argv[2];
if (!input) throw new Error('usage: node tests/quiz-model-summary-v036.mjs RESULTS.json');
const { rows } = JSON.parse(await readFile(input, 'utf8'));
const models = [...new Set(rows.map((row) => row.model))];
const percentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index), upper = Math.ceil(index);
  return Math.round(sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower));
};
const latency = (list, key) => {
  const values = list.map((row)=>row[key]).filter(Number.isFinite);
  return {n:values.length,min:Math.min(...values),mean:Math.round(values.reduce((a,b)=>a+b,0)/values.length),
    median:percentile(values,.5),p75:percentile(values,.75),p90:percentile(values,.9),
    p95:percentile(values,.95),max:Math.max(...values)};
};
const accuracy = (list) => ({n:list.length,correct:list.filter((row)=>row.correct).length,
  rate:Number((list.filter((row)=>row.correct).length/list.length).toFixed(4))});
const reports = {};
for (const model of models) {
  const list = rows.filter((row)=>row.model===model);
  const multiple = list.filter((row)=>row.questionType==='multiple_choice');
  const normal = list.filter((row)=>!row.expectWarning);
  const ambiguous = list.filter((row)=>row.expectWarning);
  reports[model] = {
    overall:accuracy(list), eligible:accuracy(list.filter((row)=>row.accuracyEligible)),
    byDifficulty:Object.fromEntries(['basic','medium','hard'].map((value)=>[value,accuracy(list.filter((row)=>row.difficulty===value))])),
    byType:Object.fromEntries(['single_choice','multiple_choice','true_false'].map((value)=>[value,accuracy(list.filter((row)=>row.questionType===value))])),
    multipleErrors:multiple.filter((row)=>!row.correct).map((row)=>({id:row.id,expected:row.expected,actual:row.actual})),
    schema:{firstTryValid:list.filter((row)=>row.firstSchemaValid).length,repairTriggered:list.filter((row)=>row.repair).length,
      repairSuccess:list.filter((row)=>row.repairSuccess).length,errors:list.filter((row)=>row.status!=='ok').length,
      errorRows:list.filter((row)=>row.status!=='ok').map((row)=>({id:row.id,status:row.status,error:row.error}))},
    confidence:{correctMean:Number((list.filter((row)=>row.correct&&Number.isFinite(row.confidence)).reduce((sum,row)=>sum+row.confidence,0)/Math.max(1,list.filter((row)=>row.correct&&Number.isFinite(row.confidence)).length)).toFixed(3)),
      wrongMean:Number((list.filter((row)=>!row.correct&&Number.isFinite(row.confidence)).reduce((sum,row)=>sum+row.confidence,0)/Math.max(1,list.filter((row)=>!row.correct&&Number.isFinite(row.confidence)).length)).toFixed(3))},
    warnings:{ambiguousWithWarning:ambiguous.filter((row)=>row.warningCount>0).length,ambiguousTotal:ambiguous.length,
      normalWithWarning:normal.filter((row)=>row.warningCount>0).length,normalTotal:normal.length,
      detail:list.filter((row)=>row.warningCount>0).map((row)=>({id:row.id,expected:row.expectWarning,warnings:row.warnings}))},
    totalLatency:latency(list,'totalMs'), firstContentMedian:latency(list,'firstContentMs').median,
    modelTurnMedian:latency(list,'modelTurnMs').median, threadCreateMedian:latency(list,'threadCreateMs').median,
  };
}
console.log(JSON.stringify(reports,null,2));
