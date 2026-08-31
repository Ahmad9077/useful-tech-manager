import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isoNow, json, parseJson, secureEqual } from './util.mjs';
import { GeminiSemanticInterpreter, SEMANTIC_VERSION } from './semantic.mjs';

const ACTIONS = new Set(['approve', 'revise', 'reject', 'skip']);
const hmac = (secret, value) => createHmac('sha256', secret).update(value).digest('base64url');
const hasExplicitApprovalEvidence = (text) => /(?:^|\s)(?:اعتمد(?:ها|هذي|النسخة|ه)?|موافق|انشر(?:ها|ه)?|نز[ّز]ل(?:ها|ه)?|approve(?:\s+this)?|publish(?:\s+this)?)(?:\s|$)/iu.test(String(text || '').trim());

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
export function reviewKeyboard({ store, contentId, revisionNumber, fingerprint, secret }) {
  const button = (text, action) => ({ text, callback_data: registerCallback({ store, action, contentId, revisionNumber, fingerprint, secret }) });
  return { inline_keyboard: [[button('✅ Approve', 'approve'), button('✏️ Revise', 'revise')], [button('❌ Reject', 'reject'), button('⏭ Skip Today', 'skip')]] };
}
export class TelegramControl {
  constructor({ store, config, signingSecret, interpreter = new GeminiSemanticInterpreter({ config }), startContent = null }) { this.store = store; this.config = config; this.signingSecret = signingSecret; this.interpreter = interpreter; this.startContent = startContent; }
  async handleUpdate(update) {
    if (!this.store.isNewTelegramUpdate(update.update_id)) return { ignored: 'replayed' };
    const callback = update.callback_query; const message = callback?.message || update.message; const sender = callback?.from || update.message?.from; const chatId = message?.chat?.id;
    if (!sender || !chatId || !isAuthorized(this.config, sender.id, chatId)) return { ignored: 'unauthorized' };
    if (callback) return this.handleCallback(callback, sender.id, chatId);
    return this.handleMessage({ text: message?.text || '', userId: sender.id, chatId, updateId: update.update_id });
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
  ideasFor(chatId) {
    const existing = this.store.getConversationState(chatId).ideaOptions;
    if (existing.length) return existing;
    const ideas = [
      { title: 'أداة عملية تنقل الملفات بين الأجهزة', category: 'cross-device' },
      { title: 'ميزة مفيدة في الآيفون', category: 'iPhone' },
      { title: 'اختصار يوفر وقت على ويندوز أو ماك', category: 'desktop' },
    ];
    this.store.updateConversationState(chatId, { ideaOptions: ideas }); return ideas;
  }
  currentFor(chatId) {
    const current = this.store.activeConversationContent(chatId);
    if (current) this.store.updateConversationState(chatId, { activeContentId: current.content_id, activeRevisionNumber: current.current_revision });
    return current;
  }
  safeInterpretationRecord(interpretation) {
    return { version: SEMANTIC_VERSION, intent: interpretation.intent, confidence: interpretation.confidence, contentReference: interpretation.contentReference, revisionReference: interpretation.revisionReference, ideaIndex: interpretation.ideaIndex, editorialScope: interpretation.editorialScope, requiresClarification: interpretation.requiresClarification, explicitApproval: interpretation.explicitApproval };
  }
  async handleMessage({ text, userId, chatId, updateId }) {
    const message = String(text || '').trim();
    this.store.recordConversationTurn({ chatId, updateId, role: 'user', text: message });
    // These exact slash commands are a narrow offline safety fallback. Natural language always uses the semantic model.
    if (message === '/status') return this.activeStatusResult(chatId);
    if (message === '/cancel') return this.cancelCurrent(chatId);
    if (!message) return { type: 'clarify', text: 'اكتب لي اللي تبيه بطريقتك، وأنا أرتبه لك.' };
    if (!this.store.consumeSemanticQuota(chatId)) return { type: 'rate-limited', text: 'وصلتني الرسائل. عطِني لحظة وأكمل معك.' };
    const active = this.currentFor(chatId); const state = this.store.getConversationState(chatId);
    let interpretation;
    try { interpretation = await this.interpreter.interpret({ message, turns: this.store.getConversationTurns(chatId), active, ideas: state.ideaOptions }); }
    catch (error) { this.store.audit('SEMANTIC_INTERPRETATION_FAILED', 'telegram', { error: String(error.message || 'unknown').slice(0, 80) }); return { type: 'clarify', text: 'ما قدرت أفهم الطلب بشكل موثوق هالمرة. اكتبها بشكل مختلف وأنا أتابع.' }; }
    this.store.recordInterpretation({ chatId, updateId, interpretation: this.safeInterpretationRecord(interpretation), outcome: 'interpreted' });
    this.store.audit('SEMANTIC_INTERPRETATION', 'telegram', { intent: interpretation.intent, confidence: interpretation.confidence, contentReference: interpretation.contentReference, ideaIndex: interpretation.ideaIndex });
    if (interpretation.requiresClarification || interpretation.confidence < 0.55) return { type: 'clarify', text: 'أبي أتأكد من قصدك: تقصد الفيديو الحالي أو تبغى نبدأ فكرة جديدة؟' };
    const result = await this.executeSemanticIntent(interpretation, { message, userId, chatId });
    this.store.recordInterpretation({ chatId, updateId, interpretation: this.safeInterpretationRecord(interpretation), outcome: result.type }); return result;
  }
  activeStatusResult(chatId) {
    const active = this.store.activeTaskForChat(chatId);
    if (!active) return { type: 'active-status', active: null, text: 'ما عندي مهمة إنتاج شغالة حالياً.' };
    const stageNames = { DISCOVERING_IDEAS: 'أبحث وأقيّم الأفكار', RESEARCHING: 'أبحث في المصادر', FACT_CHECKING: 'أتأكد من المعلومات', SELECTING_IDEA: 'أختار الفكرة', WRITING_SCRIPT: 'أكتب النص', GENERATING_VOICE: 'أجهز التعليق الصوتي', BUILDING_VISUALS: 'أبني المشاهد', RENDERING: 'أرندر الفيديو', QC: 'أراجع الجودة', READY_FOR_REVIEW: 'النسخة جاهزة للمراجعة', REVISING: 'أجهز تعديل جديد', SANDBOX_TEST_COMPLETE: 'اكتمل اختبار Sandbox الخاص' };
    const p = active.progress || {}; const stage = stageNames[p.current_stage] || p.current_stage || active.item.state;
    const prefix = p.worker_status === 'RUNNING' ? 'إي، قاعد أشتغل على فيديو جديد.' : p.worker_status === 'QUEUED' ? 'إي، المهمة في طابور العامل وبتبدأ تلقائياً.' : p.worker_status === 'WAITING' ? 'لا، ما في عامل إنتاج شغّال الآن؛ المهمة واقفة عند مرحلة محفوظة.' : 'إي، المهمة محفوظة ومتابَعَة حالياً.';
    return { type: 'active-status', active, text: `${prefix}\nالموضوع: ${active.item.topic}\nالحالة: ${stage}` };
  }
  historyResult() {
    const items = this.store.listPublicContent(10);
    return { type: 'history', items, text: `الفيديوهات العامة السابقة:\n${items.map((item) => `${item.topic} — ${item.state}`).join('\n') || 'ما عندي فيديوهات عامة منشورة في السجل.'}` };
  }
  analyticsResult() { return { type: 'analytics', items: this.store.listPublicContent(10), text: 'بجهز لك ملخص الأداء من بيانات الإنتاج المتاحة.' }; }
  cancelCurrent(chatId) {
    const current = this.currentFor(chatId); if (!current) return { type: 'cancelled', text: 'ما عندنا شغل مفتوح ألغيّه حالياً.' };
    if (!['READY_FOR_REVIEW', 'REVISION_REQUESTED'].includes(current.state)) return { type: 'clarify', text: 'المحتوى الحالي في مرحلة تنفيذ، فخلني أكملها أو أعطني طلب تعديل محدد.' };
    this.store.transition(current.content_id, 'SKIPPED', 'telegram-cancel'); return { type: 'cancelled', text: 'تم إيقاف المحتوى الحالي، وما راح يننشر.' };
  }
  async executeSemanticIntent(interpretation, { message, userId, chatId }) {
    const current = this.currentFor(chatId);
    if (['ACTIVE_STATUS', 'PIPELINE_STATUS'].includes(interpretation.intent)) return this.activeStatusResult(chatId);
    if (interpretation.intent === 'CONTENT_HISTORY') return this.historyResult();
    if (['ACCOUNT_STATS', 'ANALYTICS'].includes(interpretation.intent)) return this.analyticsResult();
    if (interpretation.intent === 'SHOW_IDEAS') { const ideas = this.ideasFor(chatId); return { type: 'ideas', ideas, text: `عندي هالمسارات للبحث اليوم:\n${ideas.map((idea, index) => `${index + 1}. ${idea.title}`).join('\n')}\nإذا تبي، اختار واحد أو خلني أختار الأنسب.` }; }
    if (interpretation.intent === 'START_NEW_CONTENT') {
      if (!this.startContent) return { type: 'failed', text: 'ما قدرت أبدأ مهمة الإنتاج بشكل موثوق هالمرة.' };
      const ideas = this.ideasFor(chatId); const selected = ideas[0]; const started = await this.startContent({ chatId, requestedBy: 'telegram-semantic', selectedIdea: selected, parameters: interpretation.parameters, oneTimePreferences: this.store.getConversationState(chatId).oneTimePreferences });
      if (!started?.accepted) return { type: 'failed', text: 'ما قدرت أثبت تشغيل مهمة الإنتاج، فما راح أدّعي إنها بدأت.' };
      return { type: 'content-started', content: started.content, job: started.job, text: `تمام، بدأت المهمة فعلياً: ${started.content.topic}. أول ما تجهز النسخة بدزها لك للمراجعة، وما راح يننشر شي بدون موافقتك.` };
    }
    if (interpretation.intent === 'SELECT_IDEA') {
      const ideas = this.ideasFor(chatId); const selectedIndex = interpretation.ideaIndex || 1; const selected = ideas[selectedIndex - 1];
      if (!selected) return { type: 'clarify', text: 'أي فكرة تقصد؟ اكتب رقمها أو اسمها.' };
      if (!this.startContent) return { type: 'failed', text: 'ما قدرت أبدأ مهمة الإنتاج بشكل موثوق هالمرة.' };
      const started = await this.startContent({ chatId, requestedBy: 'telegram-semantic', selectedIdea: selected, parameters: interpretation.parameters, oneTimePreferences: this.store.getConversationState(chatId).oneTimePreferences });
      if (!started?.accepted) return { type: 'failed', text: 'ما قدرت أثبت تشغيل مهمة الإنتاج، فما راح أدّعي إنها بدأت.' };
      return { type: 'content-started', content: started.content, job: started.job, text: `تمام، بدأت تجهيز فكرة «${started.content.topic}» فعلياً.` };
    }
    if (interpretation.intent === 'REPLACE_TOPIC') {
      if (current && ['READY_FOR_REVIEW', 'REVISION_REQUESTED'].includes(current.state)) this.store.transition(current.content_id, 'SKIPPED', 'telegram-topic-replacement');
      this.store.updateConversationState(chatId, { activeContentId: null, activeRevisionNumber: null, ideaOptions: [] }); const ideas = this.ideasFor(chatId);
      return { type: 'ideas', ideas, text: `تمام، نترك الموضوع الحالي. هذي خيارات جديدة:\n${ideas.map((idea, index) => `${index + 1}. ${idea.title}`).join('\n')}` };
    }
    if (interpretation.intent === 'REVISE_CURRENT') {
      if (!current || ['PUBLISHED', 'REJECTED', 'SKIPPED', 'FAILED'].includes(current.state)) return { type: 'clarify', text: 'ما عندي نسخة مفتوحة أعدلها حالياً. تبغى نبدأ محتوى جديد؟' };
      const content = this.store.createRevision(current.content_id, interpretation.editorialInstruction || message, 'telegram-semantic'); this.store.updateConversationState(chatId, { activeContentId: content.content_id, activeRevisionNumber: content.current_revision });
      return { type: 'revision-requested', content, text: 'وصلت ملاحظتك. بسوي نسخة جديدة على نفس الفيديو وأدزها لك للمراجعة.' };
    }
    if (interpretation.intent === 'EDITORIAL_PREFERENCE') {
      const instruction = interpretation.editorialInstruction || message;
      if (interpretation.editorialScope === 'persistent') { const now = isoNow(); this.store.db.prepare('INSERT INTO editorial_preferences VALUES(?,?,?,?,?,?)').run(randomBytes(8).toString('hex'), instruction.slice(0, 500), 1, 'telegram-semantic', now, now); return { type: 'preference-recorded', text: 'تم، باعتبرها تفضيل مستمر في المحتوى الجاي.' }; }
      const state = this.store.getConversationState(chatId); this.store.updateConversationState(chatId, { oneTimePreferences: [...state.oneTimePreferences, instruction.slice(0, 500)] }); return { type: 'preference-recorded', text: 'تم، بطبقها على طلب اليوم فقط.' };
    }
    if (interpretation.intent === 'SKIP_TODAY') {
      if (current && ['READY_FOR_REVIEW', 'REVISION_REQUESTED'].includes(current.state)) this.store.transition(current.content_id, 'SKIPPED', 'telegram-semantic'); return { type: 'skipped', text: 'تمام، بنخلي اليوم بدون محتوى وما راح أجهز بديل تلقائياً.' };
    }
    if (interpretation.intent === 'REJECT_CURRENT') {
      if (!current || !['READY_FOR_REVIEW', 'REVISION_REQUESTED'].includes(current.state)) return { type: 'clarify', text: 'ما عندي نسخة جاهزة للرفض حالياً.' };
      this.store.transition(current.content_id, 'REJECTED', 'telegram-semantic'); return { type: 'rejected', text: 'تم رفض النسخة، وما راح تننشر.' };
    }
    if (interpretation.intent === 'CANCEL_CURRENT') return this.cancelCurrent(chatId);
    if (interpretation.intent === 'APPROVE_CURRENT') {
      if (!interpretation.explicitApproval || interpretation.confidence < 0.85 || !hasExplicitApprovalEvidence(message)) return { type: 'positive-feedback', text: 'وصلتني ملاحظتك الإيجابية. ما راح أعتبرها اعتماد أو نشر إلا إذا قلتها بشكل صريح.' };
      if (!current || current.state !== 'READY_FOR_REVIEW') return { type: 'clarify', text: 'ما عندي نسخة جاهزة للاعتماد حالياً.' };
      const revisionNumber = current.current_revision; const fingerprint = this.store.revisionFingerprint(current.content_id, revisionNumber); const approved = this.store.approveExact({ contentId: current.content_id, revisionNumber, fingerprint, userId, chatId, expectedUserId: this.config.telegram.ownerUserId, expectedChatId: this.config.telegram.ownerChatId, source: 'telegram-semantic-approval' });
      return { type: 'approved', ...approved, text: 'تم اعتماد النسخة الحالية بالضبط. جاري تنفيذ مسار النشر المسموح فقط.' };
    }
    if (interpretation.intent === 'POSITIVE_FEEDBACK') return { type: 'positive-feedback', text: 'حلو، وصلت ملاحظتك. ما راح أعتبرها اعتماد أو نشر إلا إذا قلتها بشكل صريح.' };
    if (interpretation.intent === 'DELIVERY_INSTRUCTION') return { type: 'delivery-instruction', text: 'تم، أول ما تجهز النسخة بدزها لك هنا للمراجعة.' };
    return { type: 'clarify', text: 'مو واضح لي المقصود بالكامل. قل لي تبي نبدأ محتوى، نعدل النسخة الحالية، أو نراجع الأفكار؟' };
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
