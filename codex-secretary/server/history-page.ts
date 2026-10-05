export function historyPage(value: unknown, before?: string) {
  const root = value as Record<string, unknown>;
  const thread = (root.thread ?? root) as Record<string, unknown>;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const cursor = before ? turns.findIndex(turn => turn.id === before) : turns.length;
  if (cursor < 0) throw new Error('历史记录游标已失效，请重新打开任务');
  const start = Math.max(0, cursor - 20);
  const page = { ...thread, turns: turns.slice(start, cursor) };
  return { ...(root.thread ? root : {}), thread: page,
    history: { hasMore: start > 0, before: turns[start]?.id ?? null, totalTurns: turns.length } };
}
