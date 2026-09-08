export type SyncMessage = {
  id: string;
  itemId?: string;
  turnId?: string;
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  sealed?: boolean;
};

// Preserve DOM identity and locally visible items until the server confirms them.
export function mergeSnapshot<T extends SyncMessage>(current: T[], snapshot: T[]): T[] {
  const next = [...current];
  const matched = new Set<number>();
  for (const [position, stored] of snapshot.entries()) {
    let index = next.findIndex((live, i) => !matched.has(i) &&
      (live.id === stored.id || (live.itemId && live.itemId === stored.itemId && live.turnId === stored.turnId)));
    if (index < 0) index = next.findIndex((live, i) => !matched.has(i) && !live.itemId &&
      live.turnId === stored.turnId && live.role === stored.role &&
      (live.text === stored.text || (live.role === "assistant" && live.pending)));
    if (index < 0) {
      // Missing older history belongs before the next known message, not after
      // the active reply. Keep locally visible messages absent from the snapshot.
      const following = snapshot.slice(position + 1);
      const anchor = next.findIndex(live => following.some(item =>
        item.id === live.id || (item.itemId && item.itemId === live.itemId && item.turnId === live.turnId)));
      const insertion = anchor < 0 ? next.length : anchor;
      const shifted = [...matched].map(i => i >= insertion ? i + 1 : i);
      matched.clear();
      shifted.forEach(i => matched.add(i));
      next.splice(insertion, 0, stored);
      matched.add(insertion);
      continue;
    }
    matched.add(index);
    const live = next[index];
    if (live.sealed) continue;
    if (live.itemId && live.pending === false && stored.pending) continue;
    // A stale partial snapshot must never erase streamed characters.
    const text = stored.sealed || stored.text.startsWith(live.text) ? stored.text : live.text;
    const merged = { ...live, ...stored, id: live.id, text };
    next[index] = JSON.stringify(merged) === JSON.stringify(live) ? live : merged;
  }
  return next.length === current.length && next.every((item, i) => item === current[i]) ? current : next;
}

export function applyAgentText<T extends SyncMessage>(messages: T[], event: {
  turnId: string; itemId: string; text: string; completed?: boolean;
}): T[] {
  let index = messages.findIndex(item => item.turnId === event.turnId && item.itemId === event.itemId);
  if (index < 0) index = messages.findIndex(item => item.role === "assistant" && item.pending &&
    !item.itemId && (!item.turnId || item.turnId === event.turnId));
  const previous = index < 0 ? undefined : messages[index];
  const message = { ...previous, id: previous?.id ?? `${event.turnId}:${event.itemId}`,
    role: "assistant", turnId: event.turnId, itemId: event.itemId,
    text: event.completed ? event.text : (previous?.text ?? "") + event.text,
    pending: !event.completed, sealed: !!event.completed } as T;
  if (index < 0) return [...messages, message];
  if (previous && !previous.pending && !event.completed) return messages;
  return messages.map((item, i) => i === index ? message : item);
}
