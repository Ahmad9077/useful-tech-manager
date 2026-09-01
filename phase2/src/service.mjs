import { mkdir, writeFile } from 'node:fs/promises';
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
import { randomId } from './util.mjs';
import { CANONICAL_TOPIC, researchIphoneWebcam, writeVerifiedIphoneWebcamScript, generateWalidVoice, buildVisualWorkspace, renderCanonicalIphoneWebcam, artifactHash } from './autonomous-production.mjs';
import { inspectMp4, visualQc } from './qc.mjs';
import { AUTOMATED_STAGES } from './store.mjs';

export class Phase2Service {
  constructor(config = loadConfig()) { assertSandboxOnly(config); this.config = config; this.workerId = `phase2-${randomId(8)}`; this.runningJobs = new Set(); }
  async start({ dashboard = true } = {}) {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    this.store = new Store(path.join(this.config.dataDir, 'useful-tech-manager.sqlite'));
    this.scheduler = new DurableScheduler(this.store); this.discovery = new DiscoveryEngine({ store: this.store }); this.scheduler.recoverExpiredLeases(); this.store.recoverActiveJobs(); this.watchdog();
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
    this.scheduler.scheduleDailyResearch(); this.watchdog(); const job = this.scheduler.claimDueJob(this.workerId); if (job) this.dispatchClaimedJob(job);
    if (this.config.telegram.token && !telegramReady(this.config)) await this.initializeTelegram();
    if (telegramReady(this.config)) { await this.pollTelegram(); await this.flushOutbox(); }
  }
  dispatchClaimedJob(job) {
    if (!job || this.runningJobs.has(job.id)) return;
    this.runningJobs.add(job.id); void this.handleJob(job).finally(() => this.runningJobs.delete(job.id));
  }
  async handleJob(job) {
    const stagePayload = parseJson(job.payload_json); const heartbeat = setInterval(() => {
      this.scheduler.extendLease(job.id, this.workerId);
      if (job.kind === 'RUN_STAGE' && stagePayload.contentId) {
        const progress = this.store.getProgress(stagePayload.contentId); if (progress?.job_id === job.id && progress.worker_status === 'RUNNING') this.store.updateProgress({ contentId: stagePayload.contentId, stage: progress.current_stage, workerStatus: 'RUNNING', jobId: job.id, workerId: this.workerId, heartbeatAt: isoNow(), leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() });
      }
    }, 15_000); let next = null;
    try {
      if (job.kind === 'DISCOVER_IDEAS') { const signals = await this.discovery.discover(); this.store.audit('DISCOVERY_COMPLETED', 'scheduler', { sourceCount: signals.length }); }
      else if (job.kind === 'RUN_STAGE') next = await this.runStage(job, parseJson(job.payload_json));
      else if (job.kind === 'RUN_CONTENT_PIPELINE') next = this.queueStageForLegacyPipeline(parseJson(job.payload_json));
      else if (job.kind === 'RENDER_REVISION') { const result = await renderRequestedRevision({ store: this.store, config: this.config, contentId: parseJson(job.payload_json).contentId }); await this.sendReady(result.content, result.revision, result.output.qc.duration); }
      else if (job.kind === 'PUBLISH_APPROVED') await this.publishApproved(parseJson(job.payload_json));
      else if (job.kind === 'POLL_PUBLISH_STATUS') await this.pollPublishStatus(parseJson(job.payload_json));
      this.scheduler.finish(job.id, null, this.workerId);
      if (next?.job) { const claimed = this.scheduler.claimJob(next.job.id, this.workerId); if (claimed) this.dispatchClaimedJob(claimed); }
    } catch (error) {
      const message = redact(error.message);
      const payload = parseJson(job.payload_json);
      // A superseded revision may finish/throw after a quality replacement. It is
      // obsolete work, never a failure of the current revision.
      if (job.kind === 'RUN_STAGE' && payload.contentId && payload.revisionNumber && this.store.getContent(payload.contentId)?.current_revision !== Number(payload.revisionNumber)) {
        this.scheduler.finish(job.id, 'STALE_SUPERSEDED_REVISION', this.workerId);
        this.store.audit('STALE_JOB_IGNORED', 'service', { contentId: payload.contentId, revisionNumber: payload.revisionNumber, currentRevision: this.store.getContent(payload.contentId)?.current_revision });
        return;
      }
      if (job.kind === 'RUN_STAGE' && payload.contentId) {
        const attempt = Number(job.attempts || 1); const transient = /TEMPORARY|timeout|network|fetch failed|Cartesia|RESEARCH_SOURCE_UNAVAILABLE/i.test(message);
        if (transient && attempt < 3) {
          const delay = [3_000, 15_000, 60_000][attempt - 1] || 60_000; const retryAt = new Date(Date.now() + delay).toISOString();
          const retry = this.store.queueStageIfAbsent({ contentId: payload.contentId, revisionNumber: Number(payload.revisionNumber), stage: payload.stage, runAfter: retryAt, attempt });
          this.store.updateProgress({ contentId: payload.contentId, stage: payload.stage, workerStatus: 'WAITING', jobId: retry.job?.id || null, waitingReason: 'WAITING_FOR_PROVIDER_RETRY', waitingSince: isoNow(), nextRetryAt: retryAt, attemptCount: attempt, lastError: message });
        } else {
          try { const item = this.store.getContent(payload.contentId); if (item && !['PUBLISHED','REJECTED','SKIPPED','FAILED'].includes(item.state)) { this.store.transition(payload.contentId, 'FAILED', 'pipeline'); this.store.updateProgress({ contentId: payload.contentId, stage: 'FAILED', workerStatus: 'FAILED', lastError: message, waitingReason: null, waitingSince: null }); this.store.queueTerminalFailureOnce(payload.contentId); } } catch { /* preserve error */ }
        }
      }
      if ((job.kind === 'PUBLISH_APPROVED' || job.kind === 'POLL_PUBLISH_STATUS') && payload.contentId && payload.revisionNumber) {
        try { this.store.markPublishStatus(payload.contentId, Number(payload.revisionNumber), { status: 'FAILED', error: message }); } catch { /* Preserve the original job failure if state changed independently. */ }
      }
      this.scheduler.finish(job.id, message, this.workerId); this.store.audit('JOB_FAILED', 'service', { contentId: payload.contentId, revisionNumber: payload.revisionNumber, error: message.slice(0, 160) });
    } finally { clearInterval(heartbeat); }
  }
  async initializeTelegram() {
    if (this.config.telegram.token && !telegramReady(this.config)) await this.bootstrapTelegramOwner();
    if (telegramReady(this.config) && !this.telegram) { this.telegram = new TelegramClient(this.config.telegram.token); this.control = new TelegramControl({ store: this.store, config: this.config, signingSecret: this.config.telegram.signingSecret, startContent: (input) => this.startContentTask(input) }); }
  }
  async startContentTask({ chatId, requestedBy, selectedIdea, parameters = {}, oneTimePreferences = [] }) {
    const existing = this.store.activeTaskForChat(chatId);
    if (existing) return { accepted: false, reason: 'ACTIVE_TASK_EXISTS' };
    const title = String(parameters.topic || selectedIdea?.title || 'فكرة تقنية عملية').slice(0, 160);
    const task = this.store.createAndQueueContentTask({ chatId, topic: title, category: parameters.category || selectedIdea?.category || 'useful-app', payload: { requestedBy, selectedIdea, oneTimePreferences, date: new Date().toISOString().slice(0, 10) } });
    const claimed = this.scheduler.claimJob(task.job.id, this.workerId);
    if (!claimed) return { accepted: false, reason: 'WORKER_DID_NOT_ACCEPT' };
    this.store.updateProgress({ contentId: task.content.content_id, stage: 'DISCOVERING_IDEAS', workerStatus: 'RUNNING', jobId: claimed.id, lastSuccessfulStep: 'Worker accepted durable job', lastError: null });
    // The job is now durable, claimed, and running before Telegram is allowed to say it started.
    this.dispatchClaimedJob(claimed);
    return { accepted: true, content: this.store.getContent(task.content.content_id), job: claimed };
  }
  queueStageForLegacyPipeline(payload) { return this.queueNextStage(payload.contentId, Number(payload.revisionNumber), this.store.getProgress(payload.contentId)?.current_stage || 'DISCOVERING_IDEAS'); }
  queueNextStage(contentId, revisionNumber, stage, runAfter = isoNow()) {
    const queued = this.store.queueStageIfAbsent({ contentId, revisionNumber, stage, runAfter, attempt: Number(this.store.getProgress(contentId)?.attempt_count || 0) });
    if (!queued.job) throw new Error('Failed to persist next stage job');
    this.store.updateProgress({ contentId, stage, workerStatus: 'QUEUED', jobId: queued.job.id, workerId: null, claimedAt: null, heartbeatAt: null, leaseExpiresAt: null, waitingReason: null, waitingSince: null, nextRetryAt: null, lastError: null });
    this.store.audit('STAGE_QUEUED', 'orchestrator', { contentId, revisionNumber, stage, jobId: queued.job.id }); return queued;
  }
  async runStage(job, payload) {
    const { contentId, revisionNumber, stage } = payload; const item = this.store.getContent(contentId); if (!item || item.current_revision !== Number(revisionNumber)) throw new Error('Stale or unknown stage task');
    if (!AUTOMATED_STAGES.includes(stage)) throw new Error('Unsupported automated stage');
    const now = isoNow(); this.store.updateProgress({ contentId, stage, workerStatus: 'RUNNING', jobId: job.id, workerId: this.workerId, claimedAt: job.claimed_at || now, heartbeatAt: now, leaseExpiresAt: job.lease_until || null, waitingReason: null, waitingSince: null, nextRetryAt: null, lastError: null });
    const workDir = path.join(this.config.dataDir, 'work', contentId, `r${revisionNumber}`); await mkdir(workDir, { recursive: true, mode: 0o700 });
    let nextStage = null;
    if (stage === 'DISCOVERING_IDEAS') { if (item.state === 'IDEA_DISCOVERED') this.store.transition(contentId, 'RESEARCHING', 'pipeline'); nextStage = 'RESEARCHING'; }
    else if (stage === 'RESEARCHING') { if (item.state === 'REVISING') this.store.transition(contentId, 'RESEARCHING', 'quality-pipeline'); await researchIphoneWebcam({ store: this.store, contentId }); nextStage = 'FACT_CHECKING'; }
    else if (stage === 'FACT_CHECKING') { const sources = this.store.db.prepare('SELECT url,title,retrieved_at AS retrievedAt,claims_json FROM research_sources WHERE content_id=?').all(contentId).map((row) => ({ url: row.url, title: row.title, retrievedAt: row.retrievedAt, claims: parseJson(row.claims_json) })); if (sources.length < 2) throw new Error('RESEARCH_SOURCE_UNAVAILABLE'); nextStage = 'SELECTING_IDEA'; }
    else if (stage === 'SELECTING_IDEA') { this.store.db.prepare('UPDATE content_items SET topic=?,category=?,selected_hook=?,hook_type=?,updated_at=? WHERE content_id=?').run(CANONICAL_TOPIC.topic, CANONICAL_TOPIC.category, CANONICAL_TOPIC.hook, CANONICAL_TOPIC.hookType, isoNow(), contentId); nextStage = 'WRITING_SCRIPT'; }
    else if (stage === 'WRITING_SCRIPT') { const sources = this.store.db.prepare('SELECT url,title,retrieved_at AS retrievedAt,claims_json FROM research_sources WHERE content_id=?').all(contentId).map((row) => ({ url: row.url, title: row.title, retrievedAt: row.retrievedAt, claims: parseJson(row.claims_json) })); if (item.state === 'RESEARCHING') this.store.transition(contentId, 'SCRIPTING', 'pipeline'); await writeVerifiedIphoneWebcamScript({ store: this.store, contentId, revisionNumber, sources }); nextStage = 'GENERATING_VOICE'; }
    else if (stage === 'GENERATING_VOICE') { const revision = this.store.getRevision(contentId, revisionNumber); const voice = await generateWalidVoice({ config: this.config, workDir, narration: revision.script.narration }); await writeFile(path.join(workDir, 'voice-path.txt'), voice, { mode: 0o600 }); if (this.store.getContent(contentId).state === 'SCRIPTING') this.store.transition(contentId, 'PRODUCING', 'pipeline'); nextStage = 'BUILDING_VISUALS'; }
    else if (stage === 'BUILDING_VISUALS') { await buildVisualWorkspace({ workDir }); nextStage = 'RENDERING'; }
    else if (stage === 'RENDERING') { const voice = (await (await import('node:fs/promises')).readFile(path.join(workDir, 'voice-path.txt'), 'utf8')).trim(); const artifact = await renderCanonicalIphoneWebcam({ workDir, voicePath: voice, contentId }); const qc = await inspectMp4(artifact); if (!qc.pass) throw new Error('RENDER_QC_FAILED'); this.store.setRevisionArtifact({ contentId, revisionNumber, artifactPath: artifact, artifactSha256: await artifactHash(artifact), settings: { title: this.store.getRevision(contentId, revisionNumber).script.caption, hashtags: this.store.getRevision(contentId, revisionNumber).script.hashtags, privacy: 'SELF_ONLY', allowComment: false, allowDuet: false, allowStitch: false, brandedContent: false, yourBrand: false }, qc, actor: 'canonical-autonomous-renderer' }); nextStage = 'QC'; }
    else if (stage === 'QC') { const revision = this.store.getRevision(contentId, revisionNumber); const qc = await visualQc(revision.artifact_path, { framesDir: path.join(workDir, 'qc-frames') }); if (!qc.pass) throw new Error(`RENDER_VISUAL_QC_FAILED:${qc.reason || 'unknown'}`); this.store.setRevisionArtifact({ contentId, revisionNumber, artifactPath: revision.artifact_path, artifactSha256: revision.artifact_sha256, settings: revision.settings, qc, actor: 'canonical-visual-qc' }); const contentState = this.store.getContent(contentId).state; if (contentState === 'PRODUCING') this.store.transition(contentId, 'QC', 'pipeline'); if (this.store.getContent(contentId).state === 'QC') this.store.transition(contentId, 'READY_FOR_REVIEW', 'pipeline'); await this.sendReady(this.store.getContent(contentId), this.store.getRevision(contentId, revisionNumber), qc.technical.duration); this.store.updateProgress({ contentId, stage: 'READY_FOR_REVIEW', workerStatus: 'WAITING', jobId: null, waitingReason: 'WAITING_FOR_USER_APPROVAL', waitingSince: isoNow(), lastSuccessfulStep: 'Technical and visual QC passed; MP4 delivered' }); this.store.audit('READY_FOR_REVIEW_DELIVERED', 'pipeline', { contentId, revisionNumber }); return null; }
    this.store.updateProgress({ contentId, stage, workerStatus: 'RUNNING', jobId: job.id, lastSuccessfulStep: `${stage} complete` });
    return this.queueNextStage(contentId, revisionNumber, nextStage);
  }
  watchdog() {
    // A service restart can leave a claimed child process behind. Recover leases on
    // every watchdog pass, not just at startup, so an expired claim is actionable.
    this.scheduler.recoverExpiredLeases();
    const now = isoNow(); const rows = this.store.db.prepare("SELECT c.content_id,c.current_revision,p.* FROM content_items c JOIN content_progress p ON p.content_id=c.content_id WHERE c.state IN ('IDEA_DISCOVERED','RESEARCHING','SCRIPTING','PRODUCING','QC','REVISING')").all();
    for (const row of rows) {
      const current = this.store.getProgress(row.content_id); const dueRetry = current.worker_status === 'WAITING' && current.next_retry_at && current.next_retry_at <= now;
      const invalidWait = current.worker_status === 'WAITING' && (!current.waiting_reason || (AUTOMATED_STAGES.includes(current.current_stage) && !dueRetry));
      const hasJob = this.store.findActiveStageJob(row.content_id, row.current_revision, current.current_stage);
      if ((current.worker_status === 'RUNNING' && !hasJob) || (current.worker_status === 'QUEUED' && !hasJob) || dueRetry || invalidWait) this.queueNextStage(row.content_id, row.current_revision, current.current_stage);
    }
  }
  async sendReady(content, revision, duration) {
    const keyboard = reviewKeyboard({ store: this.store, contentId: content.content_id, revisionNumber: content.current_revision, fingerprint: this.store.revisionFingerprint(content.content_id, content.current_revision), secret: this.config.telegram.signingSecret });
    await this.telegram.sendReady({ chatId: this.config.telegram.ownerChatId, topic: content.topic, hook: content.selected_hook, duration: `${Math.round(duration)}s`, filePath: revision.artifact_path, keyboard });
  }
  async pollTelegram() {
    const max = this.store.db.prepare('SELECT max(update_id) AS value FROM telegram_updates').get().value; const updates = await this.telegram.getUpdates(max === null ? undefined : Number(max) + 1);
    for (const update of updates) {
      try {
        const result = await this.control.handleUpdate(update); const callback = update.callback_query; if (callback) await this.telegram.answerCallback(callback.id, result.ignored ? 'Not authorized' : 'Saved');
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
        this.store.recordConversationTurn({ chatId: message.chat.id, role: 'assistant', text, outcome: result.type });
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
