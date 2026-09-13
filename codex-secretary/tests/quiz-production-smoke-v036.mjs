import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const cookie = `palm_session=${createSession(config.sessionSecret, 1)}`;
const cases = [
  ['single_choice','3+4 等于多少？',['B'],[['A','6'],['B','7'],['C','8'],['D','9']]],
  ['multiple_choice','下列哪些是偶数？',['A','C'],[['A','2'],['B','3'],['C','4'],['D','5']]],
  ['true_false','地球绕太阳公转。',['A'],[['A','正确'],['B','错误']]],
];
const quiz = [];
for (const [questionType,question,expected,options] of cases) {
  const response = await fetch('http://127.0.0.1:4511/api/quiz-analysis',{method:'POST',
    headers:{'content-type':'application/json',cookie},body:JSON.stringify({schemaVersion:'1',
      clientRequestId:randomUUID(),sourcePackage:'com.example.production.smoke',questionType,question,
      options:options.map(([optionId,text])=>({optionId,text})),captureMode:'accessibility'})});
  const body = await response.json();
  quiz.push({questionType,status:response.status,correct:JSON.stringify([...body.answer||[]].sort())===JSON.stringify([...expected].sort()),
    repair:response.headers.get('x-palm-quiz-repair')==='1'});
}

let threadId;
const chat = await new Promise((resolve,reject)=>{
  const socket = new WebSocket('ws://127.0.0.1:4511/api/ws',{headers:{Cookie:cookie}});
  const timer=setTimeout(()=>{socket.close();reject(new Error('chat smoke timeout'));},45_000);
  let text='';
  socket.on('message',(raw)=>{
    const event=JSON.parse(raw.toString());
    if(event.type==='ready') socket.send(JSON.stringify({type:'turn.start',clientRequestId:randomUUID(),projectId:'default',text:'请只回复 CHAT_SMOKE_OK'}));
    if(event.type==='turn.accepted') threadId=event.threadId;
    const item=event.payload?.params?.item;
    if(event.type==='codex.event'&&item?.type==='agentMessage'&&typeof item.text==='string') text+=item.text;
    if(event.type==='codex.event'&&event.payload?.method==='turn/completed'){clearTimeout(timer);socket.close();resolve({completed:true,matched:text.includes('CHAT_SMOKE_OK')});}
  });
  socket.on('error',(error)=>{clearTimeout(timer);reject(error);});
});
if(threadId) await fetch(`http://127.0.0.1:4511/api/threads/${encodeURIComponent(threadId)}?projectId=default`,{method:'DELETE',headers:{cookie}});
console.log(JSON.stringify({quiz,chat,threadCleaned:Boolean(threadId)}));
