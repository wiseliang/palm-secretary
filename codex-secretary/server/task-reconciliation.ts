import { createHash } from 'node:crypto';

export type SubmissionEvidence = { knownTurnIds: string[]; textHash: string };
export type ReconciledTurn = {
  id: string;
  status: 'running' | 'completed' | 'failed' | 'interrupted';
  items: unknown[];
  errorMessage?: string;
};

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const fingerprint = (text: string): string => createHash('sha256').update(text).digest('hex');

function historyTurns(history: unknown, threadId: string): Record<string, unknown>[] | undefined {
  const thread = record(record(history)?.thread);
  if (thread?.id !== threadId || !Array.isArray(thread.turns)) return undefined;
  if (thread.turns.some((turn) => typeof record(turn)?.id !== 'string')) return undefined;
  return thread.turns as Record<string, unknown>[];
}

export function submissionEvidence(history: unknown, threadId: string, text: string): SubmissionEvidence {
  const turns = historyTurns(history, threadId);
  if (!turns) throw new Error('无法确认对话历史，尚未提交任务，请稍后重试');
  return { knownTurnIds: turns.map((turn) => turn.id as string), textHash: fingerprint(text) };
}

function userText(turn: Record<string, unknown>): string | undefined {
  if (!Array.isArray(turn.items)) return undefined;
  const messages = turn.items.map(record).filter((item) => item?.type === 'userMessage');
  if (messages.length !== 1) return undefined;
  const message = messages[0]!;
  if (typeof message.text === 'string') return message.text;
  if (!Array.isArray(message.content)) return undefined;
  const text = message.content.map(record).filter((part) => part?.type === 'text');
  if (!text.length || text.some((part) => typeof part?.text !== 'string')) return undefined;
  return text.map((part) => part!.text).join('\n');
}

export function turnStatus(value: unknown): ReconciledTurn['status'] | undefined {
  if (value === 'inProgress') return 'running';
  if (value === 'completed' || value === 'failed' || value === 'interrupted') return value;
  return undefined;
}

/** Missing/ambiguous history never authorizes a retry or a guessed completion. */
export function reconcileTurn(task: { threadId: string; turnId: string; submissionEvidence?: SubmissionEvidence }, history: unknown): ReconciledTurn | undefined {
  const turns = historyTurns(history, task.threadId);
  if (!turns) return undefined;
  let candidates: Record<string, unknown>[];
  if (!task.turnId.startsWith('pending:')) {
    candidates = turns.filter((turn) => turn.id === task.turnId);
  } else {
    const evidence = task.submissionEvidence;
    if (!evidence) return undefined;
    const known = new Set(evidence.knownTurnIds);
    candidates = turns.filter((turn) => {
      const text = userText(turn);
      return !known.has(turn.id as string) && text !== undefined && fingerprint(text) === evidence.textHash;
    });
  }
  if (candidates.length !== 1) return undefined;
  const turn = candidates[0];
  const status = turnStatus(turn.status);
  if (!status) return undefined;
  const error = record(turn.error);
  return { id: turn.id as string, status, items: Array.isArray(turn.items) ? turn.items : [],
    errorMessage: typeof error?.message === 'string' ? error.message.slice(0, 500) : undefined };
}
