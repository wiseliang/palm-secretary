// Run on the server as codex with the service environment already loaded.
import { createSession } from '/opt/palm-secretary/current/dist-server/auth.js';
const origin = process.env.APP_ORIGIN;
const cookie = `palm_session=${createSession(process.env.SESSION_SECRET, 1 / 60)}`;
const headers = { Origin: origin, Cookie: cookie };
try {
  const response = await fetch('http://127.0.0.1:4511/api/codex/update', { method: 'POST', headers });
  console.log('update', response.status, await response.text());
  if (!response.ok) process.exitCode = 1;
} finally {
  await fetch('http://127.0.0.1:4511/api/auth/logout', { method: 'POST', headers });
}
