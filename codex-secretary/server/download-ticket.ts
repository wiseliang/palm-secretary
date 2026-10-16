import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { sessionExpiry } from './auth.js';

export type DownloadTicket = { projectId: string; path: string; sessionHash: string; expiresAt: number; audience: string };
const LIFETIME = 120_000;
function signature(payload: string, secret: string) {
  return createHmac('sha256', secret).update(`palm-download-v1:${payload}`).digest('base64url');
}
export function downloadOrigin(value?: string): string | undefined {
  if (!value?.trim()) return undefined;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DOWNLOAD_ORIGIN 必须为不含路径的 HTTPS 地址');
  }
  return url.origin;
}
export function createDownloadTicket(secret: string, session: string, projectId: string, path: string, audience: string, now = Date.now()) {
  const ticket: DownloadTicket = { projectId, path, audience,
    sessionHash: createHash('sha256').update(session).digest('hex'),
    expiresAt: Math.min(now + LIFETIME, sessionExpiry(session)) };
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url');
  return `${payload}.${signature(payload, secret)}`;
}
export function verifyDownloadTicket(token: string | undefined, secret: string, audience: string, now = Date.now()): DownloadTicket | undefined {
  if (!token || token.length > 16_384) return;
  const [payload, supplied, extra] = token.split('.');
  if (!payload || !supplied || extra !== undefined) return;
  const expected = Buffer.from(signature(payload, secret));
  const actual = Buffer.from(supplied);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as DownloadTicket;
    if (value.audience !== audience || typeof value.projectId !== 'string' || !value.projectId
      || typeof value.path !== 'string' || !value.path || !/^[a-f0-9]{64}$/.test(value.sessionHash)
      || !Number.isFinite(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + LIFETIME) return;
    return value;
  } catch { return; }
}

export function downloadRange(header: string | undefined, size: number): { start: number; end: number } | undefined | false {
  if (header === undefined) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return false;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) return false;
  return { start, end };
}
