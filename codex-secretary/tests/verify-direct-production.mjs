// Operator check. Run --issue on the server as root and pipe stdout to --consume
// on the client. Short-lived ticket URLs stay in the pipe, never command arguments.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
if (process.argv.includes('--issue')) {
  const { createSession } = await import('/opt/palm-secretary/current/dist-server/auth.js');
  const env = await readFile('/etc/palm-secretary/app.env','utf8');
  const secret = env.split('\n').find(line=>line.startsWith('SESSION_SECRET=')).slice(15).trim().replace(/^["']|["']$/g,'');
  const state = JSON.parse(await readFile('/home/codex/workspace/.palm/state.json','utf8'));
  const files = [];
  for (const project of state.projects) {
    const root = path.join('/home/codex/workspace/projects', project.directory);
    const directory = path.join(root,'outbox');
    for (const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])) {
      if (!entry.isFile()) continue;
      const file = path.join(directory,entry.name);
      const info = await stat(file);
      if (info.size > 0 && info.size <= 3*1024*1024) files.push({file,size:info.size,projectId:project.id,relative:path.relative(root,file)});
    }
  }
  files.sort((a,b)=>b.size-a.size);
  const selected=files[0];
  assert.ok(selected,'No eligible existing outbox file');
  const response=await fetch('http://127.0.0.1:4511/api/files/download?'+new URLSearchParams({projectId:selected.projectId,path:selected.relative}),{
    headers:{Cookie:'palm_session='+createSession(secret,0.1)},redirect:'manual'});
  assert.equal(response.status,302);
  const url=response.headers.get('location');
  assert.equal(new URL(url).origin,'https://download.wiseliang.cloud');
  const hash=createHash('sha256');
  for await (const chunk of createReadStream(selected.file)) hash.update(chunk);
  console.log(JSON.stringify({url,size:selected.size,sha256:hash.digest('hex')}));
} else if(process.argv.includes('--consume')) {
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const {url,size,sha256}=JSON.parse(input);
  const started=performance.now();
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
  assert.equal(response.status,200);
  assert.equal(response.headers.get('server')?.includes('cloudflare'),false);
  const hash=createHash('sha256');let bytes=0;
  for await(const chunk of response.body){bytes+=chunk.length;hash.update(chunk);}
  const seconds=(performance.now()-started)/1000;
  assert.equal(bytes,size);assert.equal(hash.digest('hex'),sha256);
  const range=await fetch(url,{headers:{Range:'bytes=0-31'}});
  assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,Math.min(32,size));
  assert.equal((await fetch('https://download.wiseliang.cloud/api/files/direct')).status,401);
  assert.equal((await fetch(url+'invalid')).status,401);
  assert.equal((await fetch('https://download.wiseliang.cloud/api/status')).status,404);
  console.log(JSON.stringify({bytes,seconds:Number(seconds.toFixed(3)),KiBps:Math.round(bytes/seconds/1024),checksum:'matched',range:'206',unauthorized:'401',adminPath:'404'}));
} else throw new Error('Use --issue or --consume');
