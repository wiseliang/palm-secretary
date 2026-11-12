import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

let threadNumber = 0;
const threadTurns = new Map();
const liveTurns = new Map();
const questionId = 1000000;
const logFile = process.env.MOCK_LOG;

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }

createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (logFile && message.id) await appendFile(logFile, `${JSON.stringify(message)}\n`);
  if (!message.id) return;
  if (message.method === 'initialize') return send(process.env.MOCK_INITIALIZE_ERROR
    ? { id: message.id, error: { message: 'injected initialize failure' } }
    : { id: message.id, result: { userAgent: 'mock' } });
  if (message.method === 'account/rateLimits/read') return send({ id: message.id, result: { rateLimits: { planType: 'plus', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 37, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 } } } });
  if (message.method === 'account/usage/read') return send({ id: message.id, result: {} });
  if (message.method === 'model/list') return send({ id: message.id, result: { data: [
    { id: 'mock-fast', model: 'mock-fast', displayName: 'Mock Fast', description: 'Fast test model', isDefault: true, hidden: false, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'low' }, { reasoningEffort: 'medium', description: 'medium' }] },
    { id: 'mock-deep', model: 'mock-deep', displayName: 'Mock Deep', description: 'Deep test model', isDefault: false, hidden: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'medium' }, { reasoningEffort: 'high', description: 'high' }] },
  ] } });
  if (message.method === 'thread/start') {
    threadNumber += 1;
    return send({ id: message.id, result: { thread: { id: `thread-${threadNumber}` } } });
  }
  if (message.method === 'thread/resume') return send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === 'thread/read') return send({ id: message.id, result: { thread: { id: message.params.threadId, turns: threadTurns.get(message.params.threadId) ?? [] } } });
  if (message.method === 'turn/interrupt') {
    const { threadId, turnId } = message.params;
    send({ id: message.id, result: {} });
    if (liveTurns.get(threadId) === turnId) {
      liveTurns.delete(threadId);
      send({ method: 'serverRequest/resolved', params: { threadId, requestId: questionId } });
      send({ method: 'turn/interrupted', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
    }
    return;
  }
  if (message.id === questionId && message.result) {
    const answer = message.result.answers?.choice?.answers?.[0];
    for (const [threadId, turnId] of liveTurns) {
      liveTurns.delete(threadId);
      send({ method: 'item/agentMessage/delta', params: { threadId, turnId, delta: answer === '示例回答' ? 'FOLLOWED_NEW_DIRECTION' : 'INVALID_ANSWER' } });
      send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } });
    }
    return;
  }
  if (message.method === 'turn/steer') {
    const { threadId, expectedTurnId, input } = message.params;
    if (liveTurns.get(threadId) !== expectedTurnId || input?.[0]?.text !== '改为询问示例选项') {
      return send({ id: message.id, error: { message: 'Unexpected steer' } });
    }
    send({ id: message.id, result: { turnId: expectedTurnId } });
    send({ id: questionId, method: 'item/tool/requestUserInput', params: {
      threadId, turnId: expectedTurnId, questions: [{ id: 'choice', question: '请选择示例选项' }],
    } });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = `turn-${Date.now()}`;
    if (message.params.input?.[0]?.text === '测试运行中改变方向') {
      liveTurns.set(message.params.threadId, turnId);
      send({ id: message.id, result: { turn: { id: turnId, status: 'inProgress' } } });
      return;
    }
    if (!process.env.MOCK_EARLY_COMPLETION) send({ id: message.id, result: process.env.MOCK_LOST_START_RESPONSE ? {} : { turn: { id: turnId, status: 'inProgress' } } });
    setTimeout(async () => {
      const outbox = path.join(message.params.cwd, 'outbox');
      await mkdir(outbox, { recursive: true });
      await writeFile(path.join(outbox, `${turnId}-result.txt`), 'mock result');
      await writeFile(path.join(outbox, `${turnId}-二维码.png`), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
      const answer = `## 处理完成\n- 已读取当前任务\n- 已生成测试成果\n\n![测试二维码](outbox/${turnId}-二维码.png)\n\n\`\`\`txt\nMOCK_OK\n\`\`\``;
      const turns = threadTurns.get(message.params.threadId) ?? [];
      turns.push({ id: turnId, status: 'completed', items: [
        { type: 'userMessage', text: message.params.input?.[0]?.text ?? '' },
        { type: 'agentMessage', text: answer },
      ] });
      threadTurns.set(message.params.threadId, turns);
      // Intentionally emit only a partial delta. The UI must reconcile from
      // thread/read after the terminal event instead of trusting every delta.
      send({ method: 'item/agentMessage/delta', params: { threadId: message.params.threadId, turnId, delta: '正在处理…' } });
      if (!process.env.MOCK_SKIP_TERMINAL) send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: { id: turnId, status: 'completed' } } });
      if (process.env.MOCK_EARLY_COMPLETION) setTimeout(() => send({ id: message.id, result: { turn: { id: turnId, status: 'completed' } } }), 150);
    }, 20);
    return;
  }
  send({ id: message.id, result: {} });
});
