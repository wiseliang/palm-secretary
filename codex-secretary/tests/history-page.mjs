import assert from 'node:assert/strict';
import { historyPage } from '../server/history-page.ts';
const turns = Array.from({length: 53}, (_, i) => ({id: String(i), items: [{text: `turn ${i}`}]}));
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
console.log('HISTORY_PAGE_OK');
