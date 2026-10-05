function displayItem(item: Record<string, unknown>) {
  if (item.type === 'userMessage' || item.type === 'agentMessage') return item;
  // The history UI displays step labels, commands and paths, not raw tool results.
  // Keep the source records intact for export and reconciliation.
  return { id: item.id, type: item.type, itemId: item.itemId,
    command: item.command, exitCode: item.exitCode, tool: item.tool,
    server: item.server, query: item.query,
    changes: Array.isArray(item.changes) ? item.changes.map(change => ({ path: change.path })) : undefined };
}

export function historyPage(value: unknown, before?: string) {
  const root = value as Record<string, unknown>;
  const thread = (root.thread ?? root) as Record<string, unknown>;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const cursor = before ? turns.findIndex(turn => turn.id === before) : turns.length;
  if (cursor < 0) throw new Error('历史记录游标已失效，请重新打开任务');
  const start = Math.max(0, cursor - 20);
  const page = { ...thread, turns: turns.slice(start, cursor).map(turn => ({
    ...turn, items: Array.isArray(turn.items) ? turn.items.map(displayItem) : [],
  })) };
  return { ...(root.thread ? root : {}), thread: page,
    history: { hasMore: start > 0, before: turns[start]?.id ?? null, totalTurns: turns.length } };
}
