import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isoNow, json, parseJson, secureEqual } from './util.mjs';

const ACTIONS = new Set(['approve', 'revise', 'reject', 'skip']);
const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');

export function telegramReady(config) { return Boolean(config.telegram.token && config.telegram.ownerUserId && config.telegram.ownerChatId); }
export function isAuthorized(config, userId, chatId) { return String(userId) === String(config.telegram.ownerUserId) && String(chatId) === String(config.telegram.ownerChatId); }
export function createCallbackToken({ nonce, secret }) {
  if (!nonce) throw new Error('Callback nonce is required');
  return `u.${nonce}.${hmac(secret, nonce).slice(0, 22)}`;
}
export function registerCallback({ store, action, contentId, revisionNumber, fingerprint, secret, ttlMs = 1000 * 60 * 60 * 24 }) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported Telegram action');
  const nonce = store.issueTelegramCallback({ action, contentId, revisionNumber, fingerprint, expiresAt: Date.now() + ttlMs });
  return createCallbackToken({ nonce, secret });
}
export function verifyCallbackToken(token, secret) {
  const [version, nonce, signature] = String(token || '').split('.'); if (version !== 'u' || !nonce || !signature) throw new Error('Malformed button token');
  const expected = hmac(secret, nonce).slice(0, 22); const left = Buffer.from(signature); const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('Invalid button signature');
  return { nonce };
}
export function classifyIntent(text) {
  const value = String(text || '').trim(); const low = value.toLowerCase();
  if (!value) return { type: 'empty' };
  if (/^(status|today|stats|report|ideas)\b/i.test(value) || /^(الحالة|اليوم|إحصائيات|احصائيات|تقرير|أفكار|افكار)/.test(value)) return { type: 'status', query: low };
  if (/^(what performed best|what are the next ideas|show me yesterday|why did this video)/i.test(value)) return { type: 'analytics', query: value };
  if (/^(focus more|less |don.t cover|from now on|always |prefer )/i.test(value) || /^(من الآن|من الان|ركز أكثر|ركز اكثر|قلل|لا تغطي|أفضل|افضل)\b/.test(value)) return { type: 'preference', text: value };
  if (/^(skip today|skip)$/i.test(value) || /^(تخط|تخطي اليوم)$/.test(value)) return { type: 'skip' };
  if (/^(reject|cancel)$/i.test(value) || /^(ارفض|إلغاء|الغاء)$/.test(value)) return { type: 'reject' };
  if (/^(revise|regenerate|make a new version|make it shorter|make the opening|change |the voice|use fewer|i don.t like)/i.test(value) || /^(عد[ّلل]|قص[ّّر]|خلها أقصر|خلّه أقصر|غير|غيّر|الصوت|استخدم لقطات أكثر|استخدم لقطات اكثر|ما عجبني)/.test(value)) return { type: 'revise', text: value };
  if (/^approve\s+UT-[\w-]+\s+(?:r|revision\s*)\d+$/i.test(value)) return { type: 'approve-command', text: value };
  if (/^publish\b/i.test(value)) return { type: 'publish-needs-approval' };
  return { type: 'unknown', text: value };
}
export function reviewKeyboard({ store, contentId, revisionNumber, fingerprint, secret }) {
  const button = (text, action) => ({ text, callback_data: registerCallback({ store, action, contentId, revisionNumber, fingerprint, secret }) });
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
    const signed = verifyCallbackToken(callback.data, this.signingSecret); const data = this.store.consumeTelegramCallback(signed.nonce); if (!data) throw new Error('Button was already used or expired'); const content = this.store.getContent(data.content_id);
    if (!content || content.current_revision !== data.revision_number) throw new Error('Button refers to a non-current revision');
    const fingerprint = this.store.revisionFingerprint(data.content_id, data.revision_number); if (!secureEqual(fingerprint, data.revision_fingerprint)) throw new Error('Button revision fingerprint changed');
    if (data.action === 'approve') return { type: 'approved', ...this.store.approveExact({ contentId: data.content_id, revisionNumber: data.revision_number, fingerprint, userId, chatId, expectedUserId: this.config.telegram.ownerUserId, expectedChatId: this.config.telegram.ownerChatId }) };
    if (data.action === 'revise') return { type: 'revision-requested', content: this.store.createRevision(data.content_id, 'Telegram revision button', 'telegram-button') };
    if (data.action === 'reject') return { type: 'rejected', content: this.store.transition(data.content_id, 'REJECTED', 'telegram-button') };
    if (data.action === 'skip') return { type: 'skipped', content: this.store.transition(data.content_id, 'SKIPPED', 'telegram-button') };
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
  async getUpdates(offset) { return this.call('getUpdates', { offset, timeout: 0, allowed_updates: ['message', 'callback_query'] }); }
  async answerCallback(callbackQueryId, text = '') { return this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text, show_alert: false }); }
  async sendReady({ chatId, topic, hook, duration, filePath, keyboard }) {
    const caption = `🎬 New video ready\n\nTopic: ${topic}\nHook: ${hook}\nDuration: ${duration}`;
    if (filePath) { const form = new FormData(); form.set('chat_id', String(chatId)); form.set('caption', caption); form.set('reply_markup', json(keyboard)); form.set('video', new Blob([await (await import('node:fs/promises')).readFile(filePath)], { type: 'video/mp4' }), 'video.mp4'); const response = await fetch(`${this.endpoint}/sendVideo`, { method: 'POST', body: form }); if (!response.ok) throw new Error(`Telegram sendVideo failed: ${response.status}`); return response.json(); }
    return this.call('sendMessage', { chat_id: chatId, text: caption, reply_markup: keyboard });
  }
}
