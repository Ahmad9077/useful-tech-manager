import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store.mjs';
import { loadConfig, assertSandboxOnly, persistTelegramOwner } from './config.mjs';
import { DurableScheduler } from './scheduler.mjs';
import { DiscoveryEngine } from './discovery.mjs';
import { createDashboard } from './dashboard.mjs';
import { telegramReady, TelegramClient, TelegramControl } from './telegram.mjs';
import { parseJson, isoNow, redact } from './util.mjs';

export class Phase2Service {
  constructor(config = loadConfig()) { assertSandboxOnly(config); this.config = config; }
  async start({ dashboard = true } = {}) {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 }); this.store = new Store(path.join(this.config.dataDir, 'useful-tech-manager.sqlite')); this.scheduler = new DurableScheduler(this.store); this.discovery = new DiscoveryEngine({ store: this.store }); this.scheduler.recoverExpiredLeases();
    await this.initializeTelegram();
    if (dashboard) { this.dashboard = createDashboard(this.store, this.config); await new Promise((resolve) => this.dashboard.listen(this.config.dashboardPort, this.config.dashboardHost, resolve)); }
    return this;
  }
  async bootstrapTelegramOwner() {
    const client = new TelegramClient(this.config.telegram.token); const updates = await client.getUpdates(); const privateMessage = [...updates].reverse().map((update) => update.message || update.callback_query?.message).find((message) => message?.chat?.type === 'private' && message.from?.id && message.chat?.id);
    if (!privateMessage) return;
    persistTelegramOwner(this.config, { userId: privateMessage.from.id, chatId: privateMessage.chat.id }); this.config = loadConfig(); this.telegram = new TelegramClient(this.config.telegram.token); await this.telegram.call('sendMessage', { chat_id: privateMessage.chat.id, text: 'تم ربط هذه المحادثة الخاصة كقناة التحكم في Useful Tech Manager.' });
  }
  async tick() {
    this.scheduler.scheduleDailyResearch(); const job = this.scheduler.claimDueJob(); if (job && job.kind === 'DISCOVER_IDEAS') { try { const signals = await this.discovery.discover(); this.store.audit('DISCOVERY_COMPLETED', 'scheduler', { sourceCount: signals.length }); this.scheduler.finish(job.id); } catch (error) { this.scheduler.finish(job.id, redact(error.message)); } }
    if (this.config.telegram.token && !telegramReady(this.config)) await this.initializeTelegram();
    if (telegramReady(this.config)) { await this.pollTelegram(); await this.flushOutbox(); }
  }
  async initializeTelegram() {
    if (this.config.telegram.token && !telegramReady(this.config)) await this.bootstrapTelegramOwner();
    if (telegramReady(this.config) && !this.telegram) { this.telegram = new TelegramClient(this.config.telegram.token); this.control = new TelegramControl({ store: this.store, config: this.config, signingSecret: this.config.telegram.signingSecret }); }
  }
  async pollTelegram() {
    const max = this.store.db.prepare('SELECT max(update_id) AS value FROM telegram_updates').get().value; const updates = await this.telegram.getUpdates(max === null ? undefined : Number(max) + 1);
    for (const update of updates) { try { const result = this.control.handleUpdate(update); const callback = update.callback_query; if (callback) await this.telegram.answerCallback(callback.id, result.ignored ? 'Not authorized' : 'Saved'); const message = callback?.message || update.message; if (!result.ignored && message?.chat?.id === Number(this.config.telegram.ownerChatId)) { const text = result.type === 'approved' ? 'تم اعتماد هذه المراجعة بالضبط. لن يتم النشر إلا عبر مسار TikTok Sandbox المعتمد.' : result.type === 'revision-requested' ? 'تم تسجيل طلب التعديل وإنشاء مراجعة جديدة.' : result.type === 'rejected' ? 'تم رفض الفيديو ولن يتم نشره.' : result.type === 'skipped' ? 'تم تخطي اليوم ولن يتم إنشاء بديل تلقائيًا.' : result.text || (result.type === 'status' ? `الحالة: ${result.items.map((item) => `${item.topic} — ${item.state}`).join('\n') || 'لا يوجد محتوى بعد'}` : 'تم استلام طلبك.'); await this.telegram.call('sendMessage', { chat_id: message.chat.id, text }); } } catch (error) { this.store.audit('TELEGRAM_UPDATE_FAILED', 'service', { error: redact(error.message).slice(0, 160) }); }
    }
  }
  async flushOutbox() {
    const client = new TelegramClient(this.config.telegram.token); const rows = this.store.db.prepare("SELECT * FROM outbox WHERE status='QUEUED' AND run_after<=? ORDER BY created_at LIMIT 10").all(isoNow());
    for (const row of rows) { try { const payload = parseJson(row.payload_json); if (row.kind === 'message') await client.call('sendMessage', { chat_id: this.config.telegram.ownerChatId, text: payload.text }); this.store.db.prepare("UPDATE outbox SET status='SENT',updated_at=? WHERE id=?").run(isoNow(), row.id); } catch (error) { this.store.db.prepare("UPDATE outbox SET status='FAILED',attempts=attempts+1,error_code=?,updated_at=? WHERE id=?").run(redact(error.message).slice(0, 160), isoNow(), row.id); } }
  }
  async stop() { if (this.dashboard) await new Promise((resolve) => this.dashboard.close(resolve)); this.store?.close(); }
}
