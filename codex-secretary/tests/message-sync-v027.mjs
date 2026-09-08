import assert from 'node:assert/strict';
import { mergeSnapshot, applyAgentText } from '../app/message-sync.ts';

const stored = { id: 't:i', itemId: 'i', turnId: 't', role: 'assistant', text: '这是新的回复', pending: true };
const live = { ...stored, id: 'optimistic' };
assert.equal(mergeSnapshot([live], [stored])[0], live, 'unchanged snapshot preserves object and DOM identity');
for (const size of [10, 100]) {
  const current = { ...live, text: 'a'.repeat(size) };
  assert.equal(mergeSnapshot([current], [{ ...stored, text: 'a' }])[0].text, current.text);
}
const user = { id: 'local-u', turnId: 't', role: 'user', text: 'question' };
assert.equal(mergeSnapshot([user, live], [stored])[0], user, 'missing items are retained');
assert.equal(mergeSnapshot([user], [{ ...user, id: 't:u', itemId: 'u' }])[0].id, user.id);
let messages = [{ id: 'placeholder', turnId: 't', role: 'assistant', text: '', pending: true }];
messages = applyAgentText(messages, { turnId: 't', itemId: 'one', text: 'first' });
messages = applyAgentText(messages, { turnId: 't', itemId: 'two', text: 'second' });
assert.deepEqual(messages.map(m => m.text), ['first', 'second']);
messages = applyAgentText(messages, { turnId: 't', itemId: 'one', text: 'final', completed: true });
assert.equal(messages[0].id, 'placeholder');
assert.equal(messages[0].text, 'final', 'authoritative completion can correct streamed text');
assert.equal(applyAgentText(messages, { turnId: 't', itemId: 'one', text: 'late' }), messages);
assert.equal(mergeSnapshot(messages, messages), messages);
console.log('PALM_V027_MESSAGE_SYNC_OK');

const { readFileSync } = await import('node:fs');
const { default: ts } = await import('typescript');
const page = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('function messagesFromThread('), page.indexOf('export default function Home'));
const parse = new Function('executionStep', 'textFromContent', 'mergeExecutionStep', 'parseUserMessage',
  ts.transpile(source, { target: ts.ScriptTarget.ES2022 }) + ';return messagesFromThread;')(
    () => null, () => '', () => [], text => ({ text }));
const snapshot = { turns: [{ id: 't', items: [{ id: 'i', type: 'agentMessage', text: 'answer' }] }] };
assert.deepEqual(parse(snapshot), parse(snapshot), 'history keys remain stable');
assert.equal(parse(snapshot)[0].itemId, 'i');
const legacy = { turns: [{ items: [{ type: 'agentMessage', text: 'legacy' }] }] };
assert.deepEqual(parse(legacy), parse(legacy), 'legacy keys remain stable');
