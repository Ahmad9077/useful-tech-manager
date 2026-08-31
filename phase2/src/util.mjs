import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const isoNow = () => new Date().toISOString();
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const randomId = (bytes = 18) => randomBytes(bytes).toString('base64url');
export const json = (value) => JSON.stringify(value ?? {});
export const parseJson = (value, fallback = {}) => { try { return value ? JSON.parse(value) : fallback; } catch { return fallback; } };
export function secureEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function safeTopicName(topic) {
  const result = String(topic || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 72);
  if (!result || result === '.' || result === '..') throw new Error('Invalid archive topic name');
  return result;
}
export async function assertWithin(root, candidate) {
  const [rootPath, candidatePath] = await Promise.all([realpath(root), realpath(candidate)]);
  if (candidatePath !== rootPath && !candidatePath.startsWith(`${rootPath}${path.sep}`)) throw new Error('Path escapes approved media root');
  return candidatePath;
}
export async function regularFile(file) { return (await stat(file)).isFile(); }
export function redact(message) {
  return String(message).replace(/(access_token|refresh_token|client_secret|bot_token|authorization|cookie|code)=?[^\s,}]+/gi, '$1=[REDACTED]').replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}
