import assert from 'node:assert/strict';
import { historyPage } from '../server/history-page.ts';
const turns = Array.from({length: 53}, (_, i) => ({id: String(i), items: [{type: 'agentMessage', text: `turn ${i}`}]}));
const value = {thread: {id: 'thread', turns}};
const pages = [];
let before;
do {
  const page = historyPage(value, before);
  pages.unshift(...page.thread.turns);
  before = page.history.hasMore ? page.history.before : undefined;
} while (before);
assert.deepEqual(pages, turns);
assert.equal(value.thread.turns.length, 53);
assert.equal(historyPage({thread: {turns: []}}).history.hasMore, false);
assert.throws(() => historyPage(value, 'missing'));
const output = 'x'.repeat(3_000_000);
const source = {thread: {turns: [{id: 't', items: [
  {id: 'u', type: 'userMessage', content: [{type:'inputText', text:'question'}]},
  {id: 'c', type: 'commandExecution', command: 'ls', exitCode: 0, aggregatedOutput: output},
  {id: 'f', type: 'fileChange', changes: [{path:'a.ts', diff:output}]},
  {id: 'a', type: 'agentMessage', text: 'answer'},
]}]}};
const compact = historyPage(source);
assert.ok(JSON.stringify(compact).length < 1000);
assert.equal(source.thread.turns[0].items[1].aggregatedOutput, output);
assert.deepEqual(compact.thread.turns[0].items[0], source.thread.turns[0].items[0]);
assert.equal(compact.thread.turns[0].items[1].command, 'ls');
assert.equal(compact.thread.turns[0].items[2].changes[0].path, 'a.ts');
console.log('HISTORY_PAGE_OK');
