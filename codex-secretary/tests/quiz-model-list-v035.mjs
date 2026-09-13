import { createSession } from '../dist-server/auth.js';
import { config } from '../dist-server/config.js';

const token = createSession(config.sessionSecret, 1);
const response = await fetch('http://127.0.0.1:4511/api/models?refresh=1', {
  headers: { cookie: `palm_session=${token}` },
});
const body = await response.json();
console.log(JSON.stringify((body.models ?? []).map((item) => ({ model: item.model, displayName: item.displayName }))));
