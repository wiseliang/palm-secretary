const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export function socketIsReusable(state: number | undefined) {
  return state === CONNECTING || state === OPEN;
}

export function socketNeedsResumeReconnect(state: number | undefined) {
  return state === undefined || state === CLOSING || state === CLOSED;
}

export function websocketReconnectDelay(
  attempt: number,
  randomValue = Math.random(),
) {
  const safeAttempt = Math.max(0, Math.min(10, Math.floor(attempt)));
  const safeRandom = Math.max(0, Math.min(0.999_999, randomValue));
  const baseDelay = Math.min(30_000, 1_800 * 2 ** safeAttempt);
  return baseDelay + Math.floor(safeRandom * 500);
}
