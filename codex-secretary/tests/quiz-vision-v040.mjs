import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { registerQuizRoutes } from '../dist-server/quiz-routes.js';
import { quizVisionMetadataSchema } from '../dist-server/quiz-schema.js';

const metadata={schemaVersion:'1',clientRequestId:'b37d9d8e-629e-4e31-93b2-68d9ec38f440',
  sourcePackage:'com.example.quiz',captureMode:'hybrid',questionType:'single_choice',
  question:'根据图示选择正确答案？',options:[{optionId:'A',text:'选项一'},{optionId:'B',text:'选项二'}],
  imageWidth:800,imageHeight:600};
const result={schemaVersion:'1',questionType:'single_choice',answer:['B'],confidence:.9,
  shortExplanation:'固定视觉解释。',fullExplanation:'固定视觉完整解释。',
  optionAnalysis:[{optionId:'A',verdict:'incorrect',explanation:'不符合。'},{optionId:'B',verdict:'correct',explanation:'符合。'}],
  knowledgePoints:['图示判断'],memoryTip:'结合图示。',warnings:[]};
const metrics={bridgeAcquireMs:0,threadCreateMs:1,promptPrepareMs:0,modelTurnMs:2,
  finalModelEventMs:2,outputParseMs:0,repairMs:0,repair:false,model:'fixed',effort:'low'};
const png=new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);
const form=(value=metadata,bytes=png,type='image/png')=>{const data=new FormData();
  data.append('metadata',JSON.stringify(value)); data.append('image',new Blob([bytes],{type}),'question.png'); return data;};
const jsonMultipart=()=>{const boundary='PalmQuizAndroidFixture'; return {boundary,payload:Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="question.png"\r\nContent-Type: image/png\r\n\r\n`),
  Buffer.from(png),Buffer.from(`\r\n--${boundary}--\r\n`)])};};
const missing=async path=>{try{await access(path);return false;}catch{return true;}};

assert.equal(quizVisionMetadataSchema.safeParse(metadata).success,true);
assert.equal(quizVisionMetadataSchema.safeParse({...metadata,captureMode:'vision',question:'',options:[]}).success,true);
assert.equal(quizVisionMetadataSchema.safeParse({...metadata,captureMode:'hybrid',question:''}).success,false);

let seenPath='';
const app=Fastify({logger:false}); await app.register(cookie); await app.register(multipart);
registerQuizRoutes(app,()=>true,{analyze:async()=>({result,metrics}),analyzeVision:async(input,path)=>{
  seenPath=path; await access(path); assert.equal(input.captureMode,'hybrid'); return {result,metrics};}});
const ok=await app.inject({method:'POST',url:'/api/quiz-analysis/vision',headers:{cookie:'palm_session=fixed'},payload:form()});
assert.equal(ok.statusCode,200); assert.deepEqual(ok.json().answer,['B']); assert.equal(await missing(seenPath),true);
const androidForm=jsonMultipart();
const jsonPart=await app.inject({method:'POST',url:'/api/quiz-analysis/vision',headers:{
  cookie:'palm_session=json-part','content-type':`multipart/form-data; boundary=${androidForm.boundary}`},
  payload:androidForm.payload});
assert.equal(jsonPart.statusCode,200);

const badType=await app.inject({method:'POST',url:'/api/quiz-analysis/vision',headers:{cookie:'palm_session=other'},payload:form(metadata,png,'image/gif')});
assert.equal(badType.statusCode,400);
const oversized=new Uint8Array(3*1024*1024+1); oversized.set(png);
const tooLarge=await app.inject({method:'POST',url:'/api/quiz-analysis/vision',headers:{cookie:'palm_session=large'},payload:form(metadata,oversized)});
assert.equal(tooLarge.statusCode,413);

let failedPath='';
const failure=Fastify({logger:false}); await failure.register(cookie); await failure.register(multipart);
registerQuizRoutes(failure,()=>true,{analyze:async()=>({result,metrics}),analyzeVision:async(_input,path)=>{failedPath=path;throw new Error('fixed');}});
const failed=await failure.inject({method:'POST',url:'/api/quiz-analysis/vision',headers:{cookie:'palm_session=failure'},payload:form()});
assert.equal(failed.statusCode,503); assert.notEqual(failedPath,''); assert.equal(await missing(failedPath),true);

const unauthorized=Fastify({logger:false}); await unauthorized.register(cookie); await unauthorized.register(multipart);
registerQuizRoutes(unauthorized,(_request,reply)=>{void reply.code(401).send({error:'请先登录'});return false;},
  {analyze:async()=>({result,metrics}),analyzeVision:async()=>{throw new Error('must not run');}});
const denied=await unauthorized.inject({method:'POST',url:'/api/quiz-analysis/vision',payload:form()});
assert.equal(denied.statusCode,401);

await app.close(); await failure.close(); await unauthorized.close();
console.log('PALM_V040_VISION_OK');
