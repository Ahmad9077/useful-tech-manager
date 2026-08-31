import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isoNow, json, parseJson } from './util.mjs';

const ACTIONS = new Set(['approve', 'revise', 'reject', 'skip']);
const b64 = (value) => Buffer.from(value).toString('base64url');
const fromB64 = (value) => Buffer.from(value, 'base64url').toString('utf8');
const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');

export function telegramReady(config) { return Boolean(config.telegram.token && config.telegram.ownerUserId && config.telegram.ownerChatId); }
export function isAuthorized(config, userId, chatId) { return String(userId) === String(config.telegram.ownerUserId) && String(chatId) === String(config.telegram.ownerChatId); }
export function createCallbackToken({ action, contentId, revisionNumber, fingerprint, secret, ttlMs = 1000 * 60 * 60 * 24 }) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported Telegram action');
  const payload = { a: action, c: contentId, r: revisionNumber, f: fingerprint.slice(0, 20), n: randomBytes(8).toString('base64url'), e: Date.now() + ttlMs };
  const encoded = b64(JSON.stringify(payload)); return `${encoded}.${hmac(secret, encoded)}`;
}
export function verifyCallbackToken(token, secret) {
  const [encoded, signature] = String(token || '').split('.'); if (!encoded || !signature) throw new Error('Malformed button token');
  const expected = hmac(secret, encoded); const left = Buffer.from(signature); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Invalid button signature');
  const payload = JSON.parse(fromB64(encoded)); if (!ACTIONS.has(payload.a) || !Number.isInteger(payload.r) || Date.now() > payload.e) throw new Error('Expired button token'); return payload;
}
export function classifyIntent(text) {
  const value = String(text || '').trim(); const low = value.toLowerCase();
  if (!value) return { type: 'empty' };
  if (/^(status|today|stats|report|ideas)\b/i.test(value)) return { type: 'status', query: low };
  if (/^(what performed best|what are the next ideas|show me yesterday|why did this video)/i.test(value)) return { type: 'analytics', query: value };
  if (/^(focus more|less |don.t cover|from now on|always |prefer )/i.test(value)) return { type: 'preference', text: value };
  if (/^(skip today|skip)$/i.test(value)) return { type: 'skip' };
  if (/^(reject|cancel)$/i.test(value)) return { type: 'reject' };
  if (/^(revise|regenerate|make a new version|make it shorter|make the opening|change |the voice|use fewer|i don.t like)/i.test(value)) return { type: 'revise', text: value };
  if (/^approve\s+UT-[\w-]+\s+(?:r|revision\s*)\d+$/i.test(value)) return { type: 'approve-command', text: value };
  if (/^publish\b/i.test(value)) return { type: 'publish-needs-approval' };
  return { type: 'unknown', text: value };
}
export function reviewKeyboard({ contentId, revisionNumber, fingerprint, secret }) {
  const button = (text, action) => ({ text, callback_data: createCallbackToken({ action, contentId, revisionNumber, fingerprint, secret }) });
  return { inline_keyboard: [[button('✅ Approve', 'approve'), button('✏️ Revise', 'revise')], [button('❌ Reject', 'reject'), button('⏭ Skip Today', 'skip')]] };
}
export class TelegramControl {
  constructor({ store, config, signingSecret }) { this.store = store; this.config = config; this.signingSecret = signingSecret; }
  handleUpdate(update) {
    if (!this.store.isNewTelegramUpdate(update.update_id)) return { ignored: 'replayed' };
    const callback = update.callback_query; const message = callback?.message || update.message; const sender = callback?.from || update.message?.from; const chatId = message?.chat?.id;
    if (!sender || !chatId || !isAuthorized(this.config, sender.id, chatId)) return { ignored: 'unauthorized' };
    if (callback) return this.handleCallback(callback, sender.id, chatId);
    return this.handleMessage(message?.text || '', sender.id, chatId);
  }
  handleCallback(callback, userId, chatId) {
    const data = verifyCallbackToken(callback.data, this.signingSecret); const content = this.store.getContent(data.c);
    if (!this.store.consumeTelegramNonce(data.n, data.a, data.e)) throw new Error('Button was already used');
    if (!content || content.current_revision !== data.r) throw new Error('Button refers to a non-current revision');
    const fingerprint = this.store.revisionFingerprint(data.c, data.r); if (!fingerprint.startsWith(data.f)) throw new Error('Button revision fingerprint changed');
    if (data.a === 'approve') return { type: 'approved', ...this.store.approveExact({ contentId: data.c, revisionNumber: data.r, fingerprint, userId, chatId, expectedUserId: this.config.telegram.ownerUserId, expectedChatId: this.config.telegram.ownerChatId }) };
    if (data.a === 'revise') return { type: 'revision-requested', content: this.store.createRevision(data.c, 'Telegram revision button', 'telegram-button') };
    if (data.a === 'reject') return { type: 'rejected', content: this.store.transition(data.c, 'REJECTED', 'telegram-button') };
    if (data.a === 'skip') return { type: 'skipped', content: this.store.transition(data.c, 'SKIPPED', 'telegram-button') };
    throw new Error('Unsupported Telegram action');
  }
  handleMessage(text, userId, chatId) {
    const intent = classifyIntent(text); if (intent.type === 'publish-needs-approval') return { type: 'help', text: 'Publishing is available only through approval of the exact ready revision.' };
    if (intent.type === 'preference') { const now = isoNow(); this.store.db.prepare('INSERT INTO editorial_preferences VALUES(?,?,?,?,?,?)').run(randomBytes(8).toString('hex'), intent.text, 1, 'telegram', now, now); return { type: 'preference-recorded' }; }
    if (intent.type === 'status' || intent.type === 'analytics') return { type: intent.type, items: this.store.listContent(10) };
    const current = this.store.db.prepare("SELECT * FROM content_items WHERE state IN ('READY_FOR_REVIEW','REVISION_REQUESTED','REVISING') ORDER BY updated_at DESC LIMIT 1").get();
    if (intent.type === 'revise' && current) return { type: 'revision-requested', content: this.store.createRevision(current.content_id, intent.text, 'telegram-natural-language') };
    if ((intent.type === 'skip' || intent.type === 'reject') && current) return { type: intent.type, content: this.store.transition(current.content_id, intent.type === 'skip' ? 'SKIPPED' : 'REJECTED', 'telegram-natural-language') };
    return { type: 'help', text: 'I understood this as a request for a clear review action; use the current video buttons or ask for status, ideas, stats, or a revision.' };
  }
}
export class TelegramClient {
  constructor(token) { this.token = token; this.endpoint = `https://api.telegram.org/bot${token}`; }
  async call(method, payload) { const response = await fetch(`${this.endpoint}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(payload) }); if (!response.ok) throw new Error(`Telegram ${method} failed: ${response.status}`); const body = await response.json(); if (!body.ok) throw new Error(`Telegram ${method} rejected request`); return body.result; }
  async sendReady({ chatId, topic, hook, duration, filePath, keyboard }) {
    const caption = `🎬 New video ready\n\nTopic: ${topic}\nHook: ${hook}\nDuration: ${duration}`;
    if (filePath) { const form = new FormData(); form.set('chat_id', String(chatId)); form.set('caption', caption); form.set('reply_markup', json(keyboard)); form.set('video', new Blob([await (await import('node:fs/promises')).readFile(filePath)], { type: 'video/mp4' }), 'video.mp4'); const response = await fetch(`${this.endpoint}/sendVideo`, { method: 'POST', body: form }); if (!response.ok) throw new Error(`Telegram sendVideo failed: ${response.status}`); return response.json(); }
    return this.call('sendMessage', { chat_id: chatId, text: caption, reply_markup: keyboard });
  }
}
