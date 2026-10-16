import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSession } from '../dist-server/auth.js';
import { createDownloadTicket } from '../dist-server/download-ticket.js';
const root = process.cwd();
const workspace = await mkdtemp(path.join(os.tmpdir(), 'palm-direct-integration-'));
const secret = 'integration-test-secret-only';
const origin = 'https://download.example.test';
const now = new Date().toISOString();
await mkdir(path.join(workspace, '.palm'), {recursive: true});
await mkdir(path.join(workspace, 'projects/default/outbox'), {recursive: true});
await writeFile(path.join(workspace, '.palm/state.json'), JSON.stringify({version:8,
  projects:[{id:'default',name:'test',directory:'default',createdAt:now,updatedAt:now}],threads:[],tasks:[]}));
await writeFile(path.join(workspace, 'projects/default/outbox/test.txt'), '0123456789');
let child;
async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  if (process.platform === 'win32') current.kill();
  else process.kill(-current.pid, 'SIGTERM');
  const timer = setTimeout(() => {
    if (current.exitCode !== null) return;
    if (process.platform === 'win32') current.kill('SIGKILL');
    else process.kill(-current.pid, 'SIGKILL');
  }, 3000);
  try { await once(current,'exit'); } finally { clearTimeout(timer); }
}
try {
  for (const enabled of [true, false]) {
    const port = enabled ? 4597 : 4598;
    const base = `http://127.0.0.1:${port}`;
    let logs = '';
    child = spawn(process.execPath, ['dist-server/index.js'], {cwd: root, env: {...process.env,
      APP_HOST:'127.0.0.1', APP_PORT:String(port), APP_ORIGIN:base, SESSION_SECRET:secret,
      WORKSPACE_ROOT:workspace, DOWNLOAD_ORIGIN:enabled ? origin : '', CODEX_BIN:process.execPath,
      CODEX_ARGS_PREFIX_JSON:JSON.stringify([path.join(root,'tests/mock-app-server.mjs')]),
      MOCK_LOG:path.join(workspace, 'mock.jsonl'), CODEX_VERSION_CHECK_ENABLED:'0', LOG_LEVEL:'info',
    }, stdio:['ignore','pipe','pipe'], detached:process.platform !== 'win32'});
    child.stdout.on('data', chunk => { logs += chunk; });
    child.stderr.on('data', chunk => { logs += chunk; });
    let healthy = false;
    for (let i=0; i<100; i++) {
      if ((await fetch(base+'/api/health').catch(()=>null))?.ok) { healthy=true; break; }
      if (child.exitCode !== null) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(healthy, logs);
    const session = createSession(secret,1);
    const cookie = `palm_session=${session}`;
    const source = '/api/files/download?projectId=default&path=outbox%2Ftest.txt';
    assert.equal((await fetch(base+source,{redirect:'manual'})).status,401);
    const response = await fetch(base+source,{redirect:'manual',headers:{Cookie:cookie}});
    if (!enabled) {
      assert.equal(response.status,200);
      assert.equal(await response.text(),'0123456789');
      assert.equal((await fetch(base+'/api/files/direct')).status,404);
    } else {
      assert.equal(response.status,302);
      const location = new URL(response.headers.get('location'));
      assert.equal(location.origin,origin);
      assert.ok(!location.toString().includes(session));
      const direct=base+location.pathname+location.search;
      assert.equal((await fetch(base+'/api/files/direct')).status,401);
      const file=await fetch(direct);
      assert.equal(file.status,200);
      assert.equal(await file.text(),'0123456789');
      assert.equal(file.headers.get('cache-control'),'private, no-store');
      const range=await fetch(direct,{headers:{Range:'bytes=2-5'}});
      assert.equal(range.status,206);
      assert.equal(range.headers.get('content-range'),'bytes 2-5/10');
      assert.equal(await range.text(),'2345');
      assert.equal((await fetch(direct,{headers:{Range:'bytes=10-'}})).status,416);
      assert.equal((await fetch(direct+'tampered')).status,401);
      const escaped=createDownloadTicket(secret,session,'default','../../secret.txt',origin);
      assert.equal((await fetch(base+'/api/files/direct?ticket='+escaped)).status,404);
      const logout=await fetch(base+'/api/auth/logout',{method:'POST',headers:{Cookie:cookie,Origin:base}});
      assert.equal(logout.status,200);
      assert.equal((await fetch(direct)).status,401);
      assert.ok(!logs.includes(location.searchParams.get('ticket')), 'ticket leaked into logs');
    }
    await stopChild();
    child = undefined;
  }
  console.log('DIRECT_DOWNLOAD_INTEGRATION_OK');
} finally {
  await stopChild();
  await rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
