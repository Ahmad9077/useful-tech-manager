import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Store } from './store.mjs';
import { loadConfig, assertSandboxOnly, persistTelegramOwner } from './config.mjs';
import { DurableScheduler } from './scheduler.mjs';
import { DiscoveryEngine } from './discovery.mjs';
import { createDashboard } from './dashboard.mjs';
import { telegramReady, TelegramClient, TelegramControl, reviewKeyboard } from './telegram.mjs';
import { parseJson, isoNow, redact } from './util.mjs';
import { archiveApproved } from './archive.mjs';
import { TikTokAdapter, OfficialTikTokSandboxClient } from './tiktok.mjs';
import { sandboxAccessTokenProvider } from './sandbox-token.mjs';
import { renderRequestedRevision } from './pipeline.mjs';

export class Phase2Service {
  constructor(config = loadConfig()) { assertSandboxOnly(config); this.config = config; }
  async start({ dashboard = true } = {}) {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.store = new Store(path.join(this.config.dataDir, 'useful-tech-manager.sqlite'));
    this.scheduler = new DurableScheduler(this.store); this.discovery = new DiscoveryEngine({ store: this.store }); this.scheduler.recoverExpiredLeases();
    await this.initializeTelegram();
    if (dashboard) { this.dashboard = createDashboard(this.store, this.config); await new Promise((resolve) => this.dashboard.listen(this.config.dashboardPort, this.config.dashboardHost, resolve)); }
    return this;
  }
  async bootstrapTelegramOwner() {
    const client = new TelegramClient(this.config.telegram.token); const updates = await client.getUpdates();
    const message = [...updates].reverse().map((update) => update.message || update.callback_query?.message).find((entry) => entry?.chat?.type === 'private' && entry.from?.id && entry.chat?.id);
    if (!message) return;
    persistTelegramOwner(this.config, { userId: message.from.id, chatId: message.chat.id }); this.config = loadConfig(); this.telegram = new TelegramClient(this.config.telegram.token);
    await this.telegram.call('sendMessage', { chat_id: message.chat.id, text: 'تم ربط هذه المحادثة الخاصة كقناة التحكم في Useful Tech Manager.' });
  }
  async tick() {
    this.scheduler.scheduleDailyResearch(); const job = this.scheduler.claimDueJob(); if (job) await this.handleJob(job);
    if (this.config.telegram.token && !telegramReady(this.config)) await this.initializeTelegram();
    if (telegramReady(this.config)) { await this.pollTelegram(); await this.flushOutbox(); }
  }
  async handleJob(job) {
    try {
      if (job.kind === 'DISCOVER_IDEAS') { const signals = await this.discovery.discover(); this.store.audit('DISCOVERY_COMPLETED', 'scheduler', { sourceCount: signals.length }); }
      else if (job.kind === 'RENDER_REVISION') { const result = await renderRequestedRevision({ store: this.store, config: this.config, contentId: parseJson(job.payload_json).contentId }); await this.sendReady(result.content, result.revision, result.output.qc.duration); }
      else if (job.kind === 'PUBLISH_APPROVED') await this.publishApproved(parseJson(job.payload_json));
      else if (job.kind === 'POLL_PUBLISH_STATUS') await this.pollPublishStatus(parseJson(job.payload_json));
      this.scheduler.finish(job.id);
    } catch (error) {
      const message = redact(error.message);
      const payload = parseJson(job.payload_json);
      if ((job.kind === 'PUBLISH_APPROVED' || job.kind === 'POLL_PUBLISH_STATUS') && payload.contentId && payload.revisionNumber) {
        try { this.store.markPublishStatus(payload.contentId, Number(payload.revisionNumber), { status: 'FAILED', error: message }); } catch { /* Preserve the original job failure if state changed independently. */ }
      }
      this.scheduler.finish(job.id, message); this.store.audit('JOB_FAILED', 'service', { error: message.slice(0, 160) });
    }
  }
  async initializeTelegram() {
    if (this.config.telegram.token && !telegramReady(this.config)) await this.bootstrapTelegramOwner();
    if (telegramReady(this.config) && !this.telegram) { this.telegram = new TelegramClient(this.config.telegram.token); this.control = new TelegramControl({ store: this.store, config: this.config, signingSecret: this.config.telegram.signingSecret }); }
  }
  async sendReady(content, revision, duration) {
    const keyboard = reviewKeyboard({ store: this.store, contentId: content.content_id, revisionNumber: content.current_revision, fingerprint: this.store.revisionFingerprint(content.content_id, content.current_revision), secret: this.config.telegram.signingSecret });
    await this.telegram.sendReady({ chatId: this.config.telegram.ownerChatId, topic: content.topic, hook: content.selected_hook, duration: `${Math.round(duration)}s`, filePath: revision.artifact_path, keyboard });
  }
  async pollTelegram() {
    const max = this.store.db.prepare('SELECT max(update_id) AS value FROM telegram_updates').get().value; const updates = await this.telegram.getUpdates(max === null ? undefined : Number(max) + 1);
    for (const update of updates) {
      try {
        const result = this.control.handleUpdate(update); const callback = update.callback_query; if (callback) await this.telegram.answerCallback(callback.id, result.ignored ? 'Not authorized' : 'Saved');
        const message = callback?.message || update.message; if (result.ignored || message?.chat?.id !== Number(this.config.telegram.ownerChatId)) continue;
        let text;
        if (result.type === 'approved') {
          const archivePath = await archiveApproved({ store: this.store, contentId: result.approval.content_id, revisionNumber: Number(result.approval.revision_number), archiveRoot: this.config.archiveDir, approvedWorkRoot: path.join(this.config.dataDir, 'work') });
          this.store.queueJob('PUBLISH_APPROVED', { contentId: result.approval.content_id, revisionNumber: Number(result.approval.revision_number), environment: 'sandbox' }, isoNow(), `publish:${result.approval.content_id}:${result.approval.revision_number}:sandbox`);
          text = `تم اعتماد المراجعة وحفظ النسخة النهائية في الأرشيف: ${path.basename(archivePath)}`;
        } else if (result.type === 'revision-requested') {
          this.store.queueJob('RENDER_REVISION', { contentId: result.content.content_id }, isoNow(), `render:${result.content.content_id}:${result.content.current_revision}`);
          text = 'تم تسجيل طلب التعديل وإنشاء مراجعة جديدة.';
        } else text = result.type === 'rejected' ? 'تم رفض الفيديو ولن يتم نشره.' : result.type === 'skipped' ? 'تم تخطي اليوم ولن يتم إنشاء بديل تلقائيًا.' : result.text || (result.type === 'status' ? `الحالة: ${result.items.map((item) => `${item.topic} — ${item.state}`).join('\n') || 'لا يوجد محتوى بعد'}` : 'تم استلام طلبك.');
        await this.telegram.call('sendMessage', { chat_id: message.chat.id, text });
      } catch (error) { this.store.audit('TELEGRAM_UPDATE_FAILED', 'service', { error: redact(error.message).slice(0, 160) }); }
    }
  }
  sandboxClient() { return new OfficialTikTokSandboxClient({ accessToken: sandboxAccessTokenProvider(this.config) }); }
  async publishApproved({ contentId, revisionNumber }) {
    const client = this.sandboxClient(); const adapter = new TikTokAdapter({ store: this.store, config: this.config, client }); const post = await adapter.publishApproved(contentId, Number(revisionNumber));
    this.store.markPublishStatus(contentId, Number(revisionNumber), { status: 'POLLING', remotePublishId: post.publishId });
    this.store.queueJob('POLL_PUBLISH_STATUS', { contentId, revisionNumber: Number(revisionNumber), publishId: post.publishId }, new Date(Date.now() + 12_000).toISOString(), `poll:${contentId}:${revisionNumber}:${post.publishId}`);
    this.store.queueOutbox('message', { text: 'تم إرسال النسخة المعتمدة إلى TikTok Sandbox بخصوصية SELF_ONLY. جاري التحقق من الحالة.' }, `publish-start:${contentId}:${revisionNumber}`);
  }
  async pollPublishStatus({ contentId, revisionNumber, publishId }) {
    const data = await this.sandboxClient().status(publishId); const status = String(data.status || 'PROCESSING');
    if (status === 'PUBLISH_COMPLETE') { this.store.markPublishStatus(contentId, revisionNumber, { status: 'COMPLETE', remotePublishId: publishId }); this.store.queueOutbox('message', { text: 'اكتمل نشر اختبار Sandbox بخصوصية SELF_ONLY.' }, `publish-complete:${contentId}:${revisionNumber}`); return; }
    if (status === 'FAILED') { this.store.markPublishStatus(contentId, revisionNumber, { status: 'FAILED', remotePublishId: publishId, error: data.fail_reason || 'TikTok publish failed' }); this.store.queueOutbox('message', { text: 'فشل اختبار النشر في Sandbox؛ لم يتم نشر أي محتوى عام.' }, `publish-failed:${contentId}:${revisionNumber}`); return; }
    this.store.markPublishStatus(contentId, revisionNumber, { status: 'POLLING', remotePublishId: publishId }); this.store.queueJob('POLL_PUBLISH_STATUS', { contentId, revisionNumber, publishId }, new Date(Date.now() + 20_000).toISOString(), `poll:${contentId}:${revisionNumber}:${publishId}:${Date.now()}`);
  }
  async flushOutbox() {
    const client = new TelegramClient(this.config.telegram.token); const rows = this.store.db.prepare("SELECT * FROM outbox WHERE status='QUEUED' AND run_after<=? ORDER BY created_at LIMIT 10").all(isoNow());
    for (const row of rows) { try { const payload = parseJson(row.payload_json); if (row.kind === 'message') await client.call('sendMessage', { chat_id: this.config.telegram.ownerChatId, text: payload.text }); this.store.db.prepare("UPDATE outbox SET status='SENT',updated_at=? WHERE id=?").run(isoNow(), row.id); } catch (error) { this.store.db.prepare("UPDATE outbox SET status='FAILED',attempts=attempts+1,error_code=?,updated_at=? WHERE id=?").run(redact(error.message).slice(0, 160), isoNow(), row.id); } }
  }
  async stop() { if (this.dashboard) await new Promise((resolve) => this.dashboard.close(resolve)); this.store?.close(); }
}
