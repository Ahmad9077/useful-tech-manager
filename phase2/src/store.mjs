import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { isoNow, json, parseJson, randomId, secureEqual, sha256 } from './util.mjs';

export const STATES = Object.freeze(['IDEA_DISCOVERED', 'RESEARCHING', 'SCRIPTING', 'PRODUCING', 'QC', 'READY_FOR_REVIEW', 'REVISION_REQUESTED', 'REVISING', 'APPROVED', 'ARCHIVED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'SKIPPED', 'FAILED']);
export const ACTIVE_STATES = Object.freeze(['IDEA_DISCOVERED', 'RESEARCHING', 'SCRIPTING', 'PRODUCING', 'QC', 'READY_FOR_REVIEW', 'REVISION_REQUESTED', 'REVISING', 'APPROVED', 'ARCHIVED', 'PUBLISHING']);
export const PROGRESS_STAGES = Object.freeze(['DISCOVERING_IDEAS', 'RESEARCHING', 'FACT_CHECKING', 'SELECTING_IDEA', 'WRITING_SCRIPT', 'GENERATING_VOICE', 'BUILDING_VISUALS', 'RENDERING', 'QC', 'READY_FOR_REVIEW', 'REVISION_REQUESTED', 'REVISING', 'APPROVED', 'ARCHIVED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'SANDBOX_TEST_COMPLETE']);
export const AUTOMATED_STAGES = Object.freeze(['DISCOVERING_IDEAS', 'RESEARCHING', 'FACT_CHECKING', 'SELECTING_IDEA', 'WRITING_SCRIPT', 'GENERATING_VOICE', 'BUILDING_VISUALS', 'RENDERING', 'QC']);
export const WAITING_REASONS = Object.freeze(['WAITING_FOR_USER_APPROVAL', 'WAITING_FOR_REVISION_INSTRUCTIONS', 'WAITING_FOR_TIKTOK_REAUTH', 'WAITING_FOR_PROVIDER_RETRY', 'WAITING_FOR_RATE_LIMIT', 'WAITING_FOR_NETWORK']);
const canTransition = new Map([
  ['IDEA_DISCOVERED', new Set(['RESEARCHING', 'SKIPPED', 'FAILED'])],
  ['RESEARCHING', new Set(['SCRIPTING', 'SKIPPED', 'FAILED'])],
  ['SCRIPTING', new Set(['PRODUCING', 'SKIPPED', 'FAILED'])],
  ['PRODUCING', new Set(['QC', 'REVISING', 'FAILED'])],
  ['QC', new Set(['READY_FOR_REVIEW', 'REVISING', 'FAILED'])],
  ['READY_FOR_REVIEW', new Set(['REVISION_REQUESTED', 'APPROVED', 'REJECTED', 'SKIPPED', 'FAILED'])],
  ['REVISION_REQUESTED', new Set(['REVISING', 'REJECTED', 'SKIPPED'])],
  ['REVISING', new Set(['QC', 'FAILED'])],
  ['APPROVED', new Set(['ARCHIVED', 'PUBLISHING', 'REVISION_REQUESTED', 'FAILED'])],
  ['ARCHIVED', new Set(['PUBLISHING', 'REVISION_REQUESTED', 'FAILED'])],
  ['PUBLISHING', new Set(['PUBLISHED', 'APPROVED', 'FAILED'])],
  ['PUBLISHED', new Set()], ['REJECTED', new Set()], ['SKIPPED', new Set()], ['FAILED', new Set(['RESEARCHING', 'REVISING'])],
]);
export class Store {
  constructor(filename = ':memory:') {
    if (filename !== ':memory:') { mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 }); }
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') { try { chmodSync(filename, 0o600); } catch {} }
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content_items(
        content_id TEXT PRIMARY KEY, topic TEXT NOT NULL, category TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (${STATES.map((s) => `'${s}'`).join(',')})),
        current_revision INTEGER NOT NULL, idea_score REAL, selected_hook TEXT, hook_type TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, reject_reason TEXT, skip_reason TEXT
      );
      CREATE TABLE IF NOT EXISTS content_revisions(
        content_id TEXT NOT NULL REFERENCES content_items(content_id) ON DELETE CASCADE, revision_number INTEGER NOT NULL,
        script_json TEXT NOT NULL DEFAULT '{}', source_snapshot_json TEXT NOT NULL DEFAULT '{}', artifact_path TEXT, artifact_sha256 TEXT, posting_settings_json TEXT NOT NULL DEFAULT '{}', posting_settings_sha256 TEXT,
        qc_json TEXT NOT NULL DEFAULT '{}', qc_pass INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'WORKING', created_at TEXT NOT NULL, superseded_at TEXT,
        PRIMARY KEY(content_id, revision_number)
      );
      CREATE TABLE IF NOT EXISTS approvals(
        content_id TEXT NOT NULL, revision_number INTEGER NOT NULL, revision_fingerprint TEXT NOT NULL, artifact_sha256 TEXT NOT NULL, settings_sha256 TEXT NOT NULL,
        approved_by_user_id TEXT NOT NULL, approved_by_chat_id TEXT NOT NULL, source TEXT NOT NULL, approved_at TEXT NOT NULL, invalidated_at TEXT,
        PRIMARY KEY(content_id, revision_number), FOREIGN KEY(content_id, revision_number) REFERENCES content_revisions(content_id, revision_number)
      );
      CREATE TABLE IF NOT EXISTS publish_intents(
        id TEXT PRIMARY KEY, content_id TEXT NOT NULL, revision_number INTEGER NOT NULL, revision_fingerprint TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
        idempotency_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status IN ('QUEUED','CLAIMED','INITIALIZED','UPLOADING','POLLING','COMPLETE','FAILED')), remote_publish_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT,
        UNIQUE(content_id, revision_number, environment), FOREIGN KEY(content_id, revision_number) REFERENCES content_revisions(content_id, revision_number)
      );
      CREATE TABLE IF NOT EXISTS research_sources(id INTEGER PRIMARY KEY, content_id TEXT NOT NULL REFERENCES content_items(content_id), url TEXT NOT NULL, title TEXT NOT NULL, retrieved_at TEXT NOT NULL, claims_json TEXT NOT NULL DEFAULT '[]', UNIQUE(content_id,url));
      CREATE TABLE IF NOT EXISTS workflow_jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('QUEUED','CLAIMED','DONE','FAILED')), run_after TEXT NOT NULL, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0, idempotency_key TEXT UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('QUEUED','SENT','FAILED')), attempts INTEGER NOT NULL DEFAULT 0, run_after TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error_code TEXT);
      CREATE TABLE IF NOT EXISTS telegram_updates(update_id INTEGER PRIMARY KEY, received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_nonces(nonce TEXT PRIMARY KEY, action TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS telegram_callbacks(nonce TEXT PRIMARY KEY, action TEXT NOT NULL, content_id TEXT NOT NULL, revision_number INTEGER NOT NULL, revision_fingerprint TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS telegram_conversation_turns(
        id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, update_id INTEGER, role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        text TEXT NOT NULL, interpretation_json TEXT NOT NULL DEFAULT '{}', outcome TEXT, created_at TEXT NOT NULL,
        UNIQUE(chat_id, update_id, role)
      );
      CREATE TABLE IF NOT EXISTS telegram_conversation_state(
        chat_id TEXT PRIMARY KEY, active_content_id TEXT, active_revision_number INTEGER, idea_options_json TEXT NOT NULL DEFAULT '[]',
        one_time_preferences_json TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_progress(
        content_id TEXT PRIMARY KEY REFERENCES content_items(content_id) ON DELETE CASCADE,
        current_stage TEXT NOT NULL, worker_status TEXT NOT NULL CHECK(worker_status IN ('QUEUED','RUNNING','WAITING','IDLE','FAILED','COMPLETE')),
        job_id TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_successful_step TEXT, last_error TEXT
      );
      CREATE TABLE IF NOT EXISTS content_publication_classification(
        content_id TEXT PRIMARY KEY REFERENCES content_items(content_id) ON DELETE CASCADE,
        environment TEXT NOT NULL CHECK(environment IN ('sandbox','production','none')),
        visibility TEXT NOT NULL CHECK(visibility IN ('SELF_ONLY','PUBLIC','DRAFT','NOT_PUBLISHED')),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS telegram_semantic_rate_limits(
        chat_id TEXT PRIMARY KEY, window_started TEXT NOT NULL, call_count INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS editorial_preferences(id TEXT PRIMARY KEY, rule_text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_snapshots(id INTEGER PRIMARY KEY, content_id TEXT REFERENCES content_items(content_id), captured_at TEXT NOT NULL, views INTEGER, likes INTEGER, shares INTEGER, comments INTEGER, followers INTEGER, raw_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS archive_records(content_id TEXT PRIMARY KEY, revision_number INTEGER NOT NULL, archive_path TEXT NOT NULL UNIQUE, artifact_sha256 TEXT NOT NULL, archived_at TEXT NOT NULL, FOREIGN KEY(content_id,revision_number) REFERENCES content_revisions(content_id,revision_number));
      CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, content_id TEXT, revision_number INTEGER, event_type TEXT NOT NULL, actor TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    `);
    // Safe additive migrations for databases created before conversational progress existed.
    try { this.db.exec('ALTER TABLE telegram_conversation_state ADD COLUMN last_bot_action TEXT'); } catch { /* already present */ }
    for (const [table, column, type] of [
      ['workflow_jobs', 'worker_id', 'TEXT'], ['workflow_jobs', 'claimed_at', 'TEXT'], ['workflow_jobs', 'heartbeat_at', 'TEXT'],
      ['content_progress', 'worker_id', 'TEXT'], ['content_progress', 'claimed_at', 'TEXT'], ['content_progress', 'heartbeat_at', 'TEXT'], ['content_progress', 'lease_expires_at', 'TEXT'],
      ['content_progress', 'waiting_reason', 'TEXT'], ['content_progress', 'waiting_since', 'TEXT'], ['content_progress', 'next_retry_at', 'TEXT'], ['content_progress', 'attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
    ]) { try { this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`); } catch { /* already present */ } }
    const now = isoNow();
    this.db.prepare("INSERT OR IGNORE INTO content_progress(content_id,current_stage,worker_status,job_id,started_at,updated_at,last_successful_step,last_error) SELECT content_id,CASE WHEN state='PUBLISHED' THEN 'PUBLISHED' WHEN state='READY_FOR_REVIEW' THEN 'READY_FOR_REVIEW' WHEN state='FAILED' THEN 'FAILED' ELSE state END,CASE WHEN state IN ('PUBLISHED','REJECTED','SKIPPED','FAILED') THEN 'COMPLETE' ELSE 'IDLE' END,NULL,created_at,updated_at,NULL,NULL FROM content_items").run();
    this.db.prepare("INSERT OR IGNORE INTO content_publication_classification(content_id,environment,visibility,updated_at) SELECT content_id,'none','NOT_PUBLISHED',updated_at FROM content_items").run();
    this.db.prepare("UPDATE content_publication_classification SET environment='sandbox',visibility='SELF_ONLY',updated_at=? WHERE content_id IN (SELECT content_id FROM publish_intents WHERE environment='sandbox')").run(now);
    this.db.prepare("UPDATE content_progress SET current_stage='SANDBOX_TEST_COMPLETE',worker_status='COMPLETE',updated_at=? WHERE content_id IN (SELECT content_id FROM publish_intents WHERE environment='sandbox' AND status='COMPLETE')").run(now);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(eventType, actor, data = {}) { this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomId(), data.contentId || null, data.revisionNumber || null, eventType, actor, json(data), isoNow()); }
  createContent({ topic, category = 'useful-app', ideaScore = null, hook = '', hookType = '', contentId }) {
    return this.transaction(() => {
      const now = isoNow(); const id = contentId || `UT-${now.slice(0, 10).replaceAll('-', '')}-${randomId(4).toUpperCase()}`;
      this.db.prepare('INSERT INTO content_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, topic, category, 'IDEA_DISCOVERED', 1, ideaScore, hook, hookType, now, now, null, null);
      this.db.prepare('INSERT INTO content_revisions(content_id,revision_number,created_at) VALUES(?,?,?)').run(id, 1, now);
      this.db.prepare('INSERT INTO content_progress(content_id,current_stage,worker_status,job_id,started_at,updated_at,last_successful_step,last_error) VALUES(?,?,?,?,?,?,?,?)').run(id, 'DISCOVERING_IDEAS', 'QUEUED', null, now, now, null, null);
      this.db.prepare('INSERT INTO content_publication_classification VALUES(?,?,?,?)').run(id, 'none', 'NOT_PUBLISHED', now);
      this.audit('CONTENT_CREATED', 'system', { contentId: id, revisionNumber: 1 }); return this.getContent(id);
    });
  }
  createAndQueueContentTask({ chatId, topic, category = 'useful-app', hook = '', hookType = 'editorial-choice', ideaScore = null, payload = {} }) {
    return this.transaction(() => {
      const now = isoNow(); const contentId = `UT-${now.slice(0, 10).replaceAll('-', '')}-${randomId(4).toUpperCase()}`;
      this.db.prepare('INSERT INTO content_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(contentId, topic, category, 'IDEA_DISCOVERED', 1, ideaScore, hook, hookType, now, now, null, null);
      this.db.prepare('INSERT INTO content_revisions(content_id,revision_number,created_at) VALUES(?,?,?)').run(contentId, 1, now);
      this.db.prepare('INSERT INTO content_progress(content_id,current_stage,worker_status,job_id,started_at,updated_at,last_successful_step,last_error) VALUES(?,?,?,?,?,?,?,?)').run(contentId, 'DISCOVERING_IDEAS', 'QUEUED', null, now, now, null, null);
      this.db.prepare('INSERT INTO content_publication_classification VALUES(?,?,?,?)').run(contentId, 'none', 'NOT_PUBLISHED', now);
      const job = this.queueJob('RUN_CONTENT_PIPELINE', { contentId, revisionNumber: 1, ...payload }, now, `content-pipeline:${contentId}:r1`);
      if (!job.inserted || !job.job) throw new Error('Durable production job was not created');
      this.updateProgress({ contentId, stage: 'DISCOVERING_IDEAS', workerStatus: 'QUEUED', jobId: job.job.id, lastSuccessfulStep: null, lastError: null });
      const conversation = this.getConversationState(chatId);
      this.db.prepare('INSERT INTO telegram_conversation_state(chat_id,active_content_id,active_revision_number,idea_options_json,one_time_preferences_json,updated_at,last_bot_action) VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET active_content_id=excluded.active_content_id,active_revision_number=excluded.active_revision_number,updated_at=excluded.updated_at,last_bot_action=excluded.last_bot_action').run(String(chatId), contentId, 1, json(conversation.ideaOptions), json(conversation.oneTimePreferences), now, 'START_NEW_CONTENT');
      this.audit('CONTENT_TASK_QUEUED', 'telegram', { contentId, revisionNumber: 1, jobId: job.job.id });
      return { content: this.getContent(contentId), job: job.job };
    });
  }
  getContent(contentId) { const row = this.db.prepare('SELECT * FROM content_items WHERE content_id=?').get(contentId); return row && { ...row, current_revision: Number(row.current_revision) }; }
  getProgress(contentId) { return this.db.prepare('SELECT * FROM content_progress WHERE content_id=?').get(contentId) || null; }
  updateProgress({ contentId, stage, workerStatus, jobId = undefined, lastSuccessfulStep = undefined, lastError = undefined, workerId = undefined, claimedAt = undefined, heartbeatAt = undefined, leaseExpiresAt = undefined, waitingReason = undefined, waitingSince = undefined, nextRetryAt = undefined, attemptCount = undefined }) {
    if (!PROGRESS_STAGES.includes(stage)) throw new Error('Invalid content progress stage');
    if (!['QUEUED','RUNNING','WAITING','IDLE','FAILED','COMPLETE'].includes(workerStatus)) throw new Error('Invalid worker status');
    const current = this.getProgress(contentId); if (!current) throw new Error('Unknown content progress'); const now = isoNow();
    const resolvedReason = waitingReason === undefined ? current.waiting_reason : waitingReason;
    if (workerStatus === 'WAITING' && !WAITING_REASONS.includes(resolvedReason)) throw new Error('WAITING requires a valid waiting reason');
    if (workerStatus === 'WAITING' && AUTOMATED_STAGES.includes(stage) && resolvedReason !== 'WAITING_FOR_PROVIDER_RETRY' && resolvedReason !== 'WAITING_FOR_RATE_LIMIT' && resolvedReason !== 'WAITING_FOR_NETWORK') throw new Error('Automated stages cannot wait without an explicit retry reason');
    this.db.prepare('UPDATE content_progress SET current_stage=?,worker_status=?,job_id=?,updated_at=?,last_successful_step=?,last_error=?,worker_id=?,claimed_at=?,heartbeat_at=?,lease_expires_at=?,waiting_reason=?,waiting_since=?,next_retry_at=?,attempt_count=? WHERE content_id=?').run(stage, workerStatus, jobId === undefined ? current.job_id : jobId, now, lastSuccessfulStep === undefined ? current.last_successful_step : lastSuccessfulStep, lastError === undefined ? current.last_error : (lastError ? String(lastError).slice(0, 240) : null), workerId === undefined ? current.worker_id : workerId, claimedAt === undefined ? current.claimed_at : claimedAt, heartbeatAt === undefined ? current.heartbeat_at : heartbeatAt, leaseExpiresAt === undefined ? current.lease_expires_at : leaseExpiresAt, resolvedReason || null, waitingSince === undefined ? (workerStatus === 'WAITING' ? current.waiting_since || now : null) : waitingSince, nextRetryAt === undefined ? current.next_retry_at : nextRetryAt, attemptCount === undefined ? Number(current.attempt_count || 0) : Number(attemptCount), contentId);
    return this.getProgress(contentId);
  }
  activeTaskForChat(chatId) {
    const state = this.getConversationState(chatId); if (!state.active_content_id) return null;
    const item = this.getContent(state.active_content_id); if (!item || !ACTIVE_STATES.includes(item.state)) return null;
    return { item, progress: this.getProgress(item.content_id), conversation: state };
  }
  getRevision(contentId, revisionNumber) { const row = this.db.prepare('SELECT * FROM content_revisions WHERE content_id=? AND revision_number=?').get(contentId, revisionNumber); return row && { ...row, script: parseJson(row.script_json), sources: parseJson(row.source_snapshot_json), settings: parseJson(row.posting_settings_json), qc: parseJson(row.qc_json) }; }
  setRevisionPlan({ contentId, revisionNumber, script, sources, actor = 'research' }) {
    return this.transaction(() => {
      const item = this.getContent(contentId); if (!item || item.current_revision !== revisionNumber) throw new Error('Plan must belong to the current revision');
      this.db.prepare('UPDATE content_revisions SET script_json=?,source_snapshot_json=? WHERE content_id=? AND revision_number=?').run(json(script), json(sources), contentId, revisionNumber);
      this.audit('REVISION_PLANNED', actor, { contentId, revisionNumber }); return this.getRevision(contentId, revisionNumber);
    });
  }
  transition(contentId, next, actor = 'system') {
    return this.transaction(() => { const item = this.getContent(contentId); if (!item) throw new Error('Unknown content'); if (!canTransition.get(item.state)?.has(next)) throw new Error(`Illegal transition ${item.state} -> ${next}`); const now = isoNow(); this.db.prepare('UPDATE content_items SET state=?,updated_at=? WHERE content_id=?').run(next, now, contentId); this.audit('STATE_CHANGED', actor, { contentId, revisionNumber: item.current_revision, from: item.state, to: next }); return this.getContent(contentId); });
  }
  setRevisionArtifact({ contentId, revisionNumber, artifactPath, artifactSha256, settings = {}, qc = {}, actor = 'renderer' }) {
    return this.transaction(() => {
      const item = this.getContent(contentId); if (!item || item.current_revision !== revisionNumber) throw new Error('Artifact must belong to current revision');
      const settingsSha = sha256(json(settings));
      this.db.prepare('UPDATE content_revisions SET artifact_path=?,artifact_sha256=?,posting_settings_json=?,posting_settings_sha256=?,qc_json=?,qc_pass=?,status=? WHERE content_id=? AND revision_number=?').run(artifactPath, artifactSha256, json(settings), settingsSha, json(qc), qc.pass ? 1 : 0, qc.pass ? 'QC_PASSED' : 'QC_FAILED', contentId, revisionNumber);
      this.db.prepare('UPDATE approvals SET invalidated_at=? WHERE content_id=? AND revision_number=? AND invalidated_at IS NULL').run(isoNow(), contentId, revisionNumber);
      this.audit('ARTIFACT_SET', actor, { contentId, revisionNumber }); return this.getRevision(contentId, revisionNumber);
    });
  }
  revisionFingerprint(contentId, revisionNumber) { const r = this.getRevision(contentId, revisionNumber); if (!r?.artifact_sha256 || !r?.posting_settings_sha256) throw new Error('Revision is not render-ready'); return sha256(`${contentId}:${revisionNumber}:${r.artifact_sha256}:${r.posting_settings_sha256}`); }
  createRevision(contentId, reason, actor = 'telegram') {
    return this.transaction(() => {
      const item = this.getContent(contentId); if (!item) throw new Error('Unknown content'); if (['PUBLISHED','REJECTED','SKIPPED'].includes(item.state)) throw new Error('Cannot revise terminal content');
      const next = item.current_revision + 1; const now = isoNow();
      this.db.prepare('UPDATE content_revisions SET superseded_at=? WHERE content_id=? AND revision_number=?').run(now, contentId, item.current_revision);
      this.db.prepare('UPDATE approvals SET invalidated_at=? WHERE content_id=? AND invalidated_at IS NULL').run(now, contentId);
      this.db.prepare('INSERT INTO content_revisions(content_id,revision_number,script_json,source_snapshot_json,posting_settings_json,created_at) SELECT content_id,?,script_json,source_snapshot_json,posting_settings_json,? FROM content_revisions WHERE content_id=? AND revision_number=?').run(next, now, contentId, item.current_revision);
      this.db.prepare('UPDATE content_items SET current_revision=?,state=?,updated_at=? WHERE content_id=?').run(next, 'REVISING', now, contentId);
      this.audit('REVISION_REQUESTED', actor, { contentId, revisionNumber: next, reason: String(reason).slice(0, 500) }); return this.getContent(contentId);
    });
  }
  approveExact({ contentId, revisionNumber, fingerprint, userId, chatId, expectedUserId, expectedChatId, source = 'telegram-button', environment = 'sandbox' }) {
    return this.transaction(() => {
      if (!secureEqual(String(userId), String(expectedUserId)) || !secureEqual(String(chatId), String(expectedChatId))) throw new Error('Unauthorized Telegram sender');
      const item = this.getContent(contentId); const revision = this.getRevision(contentId, revisionNumber);
      if (!item || !revision || item.current_revision !== revisionNumber || item.state !== 'READY_FOR_REVIEW' || !revision.qc_pass) throw new Error('Revision is not eligible for approval');
      const actual = this.revisionFingerprint(contentId, revisionNumber); if (!secureEqual(actual, fingerprint)) throw new Error('Revision changed; approval invalid');
      const now = isoNow(); this.db.prepare('INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,NULL)').run(contentId, revisionNumber, actual, revision.artifact_sha256, revision.posting_settings_sha256, String(userId), String(chatId), source, now);
      this.db.prepare('UPDATE content_items SET state=?,updated_at=? WHERE content_id=?').run('APPROVED', now, contentId);
      const intentId = randomId(); this.db.prepare('INSERT INTO publish_intents VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(intentId, contentId, revisionNumber, actual, environment, sha256(`${contentId}:${revisionNumber}:${environment}`), 'QUEUED', null, 0, now, now, null);
      this.audit('REVISION_APPROVED', source, { contentId, revisionNumber }); return { intentId, approval: this.db.prepare('SELECT * FROM approvals WHERE content_id=? AND revision_number=?').get(contentId, revisionNumber) };
    });
  }
  assertPublishable(contentId, revisionNumber, environment = 'sandbox') {
    const item = this.getContent(contentId); const r = this.getRevision(contentId, revisionNumber); const a = this.db.prepare('SELECT * FROM approvals WHERE content_id=? AND revision_number=? AND invalidated_at IS NULL').get(contentId, revisionNumber); const intent = this.db.prepare('SELECT * FROM publish_intents WHERE content_id=? AND revision_number=? AND environment=?').get(contentId, revisionNumber, environment);
    if (!item || item.current_revision !== revisionNumber || !r || !a || !intent || !['APPROVED','ARCHIVED','PUBLISHING'].includes(item.state)) throw new Error('No exact active approval');
    const fp = this.revisionFingerprint(contentId, revisionNumber); if (!secureEqual(a.revision_fingerprint, fp) || !secureEqual(intent.revision_fingerprint, fp)) throw new Error('Approval fingerprint no longer matches'); return { item, revision: r, approval: a, intent };
  }
  claimPublishIntent(contentId, revisionNumber, environment = 'sandbox') { return this.transaction(() => { const result = this.assertPublishable(contentId, revisionNumber, environment); const changed = this.db.prepare("UPDATE publish_intents SET status='CLAIMED',attempts=attempts+1,updated_at=? WHERE id=? AND status='QUEUED'").run(isoNow(), result.intent.id); if (!changed.changes) throw new Error('Publish intent is not available to claim'); this.db.prepare('UPDATE content_items SET state=?,updated_at=? WHERE content_id=?').run('PUBLISHING', isoNow(), contentId); this.audit('PUBLISH_CLAIMED', 'publisher', { contentId, revisionNumber }); return { ...result, intent: { ...result.intent, status: 'CLAIMED' } }; }); }
  markPublishStatus(contentId, revisionNumber, { status, remotePublishId = null, error = null }) {
    const allowed = new Set(['POLLING', 'COMPLETE', 'FAILED']); if (!allowed.has(status)) throw new Error('Invalid publish status');
    this.db.prepare('UPDATE publish_intents SET status=?,remote_publish_id=COALESCE(?,remote_publish_id),error_code=?,updated_at=? WHERE content_id=? AND revision_number=? AND environment=?').run(status, remotePublishId, error ? String(error).slice(0, 160) : null, isoNow(), contentId, revisionNumber, 'sandbox');
    if (status === 'COMPLETE') {
      this.classifyPublication(contentId, { environment: 'sandbox', visibility: 'SELF_ONLY' });
      this.transition(contentId, 'PUBLISHED', 'sandbox-publisher');
      this.updateProgress({ contentId, stage: 'SANDBOX_TEST_COMPLETE', workerStatus: 'COMPLETE', lastSuccessfulStep: 'Sandbox SELF_ONLY Direct Post complete' });
    }
    if (status === 'FAILED') this.transition(contentId, 'APPROVED', 'sandbox-publisher');
  }
  retryFailedSandboxPublish(contentId, revisionNumber) {
    return this.transaction(() => {
      const result = this.assertPublishable(contentId, revisionNumber, 'sandbox');
      if (result.intent.status !== 'FAILED' || result.intent.remote_publish_id) throw new Error('Only an uninitialised failed Sandbox publish may be retried');
      this.db.prepare("UPDATE publish_intents SET status='QUEUED',error_code=NULL,updated_at=? WHERE id=? AND status='FAILED' AND remote_publish_id IS NULL").run(isoNow(), result.intent.id);
      this.audit('PUBLISH_RETRY_QUEUED', 'sandbox-publisher', { contentId, revisionNumber }); return this.assertPublishable(contentId, revisionNumber, 'sandbox');
    });
  }
  queueJob(kind, payload, runAfter = isoNow(), idempotencyKey = `${kind}:${randomId()}`) {
    const now = isoNow(); const id = randomId();
    const result = this.db.prepare('INSERT OR IGNORE INTO workflow_jobs(id,kind,payload_json,status,run_after,lease_until,attempts,idempotency_key,created_at,updated_at,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, kind, json(payload), 'QUEUED', runAfter, null, 0, idempotencyKey, now, now, null);
    const job = result.changes ? this.db.prepare('SELECT * FROM workflow_jobs WHERE id=?').get(id) : this.db.prepare('SELECT * FROM workflow_jobs WHERE idempotency_key=?').get(idempotencyKey);
    return { inserted: Boolean(result.changes), job };
  }
  queueOutbox(kind, payload, idempotencyKey) { const now = isoNow(); this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomId(), kind, json(payload), 'QUEUED', 0, now, idempotencyKey, now, now, null); }
  listContent(limit = 50) { return this.db.prepare('SELECT * FROM content_items ORDER BY updated_at DESC LIMIT ?').all(limit); }
  listPublicContent(limit = 50) {
    return this.db.prepare("SELECT c.*,p.environment AS publication_environment,p.visibility AS publication_visibility FROM content_items c JOIN content_publication_classification p ON p.content_id=c.content_id WHERE p.environment='production' AND p.visibility='PUBLIC' AND c.state='PUBLISHED' ORDER BY c.updated_at DESC LIMIT ?").all(limit);
  }
  classifyPublication(contentId, { environment, visibility }) {
    if (!['sandbox','production','none'].includes(environment)) throw new Error('Invalid publication environment');
    if (!['SELF_ONLY','PUBLIC','DRAFT','NOT_PUBLISHED'].includes(visibility)) throw new Error('Invalid publication visibility');
    this.db.prepare('INSERT INTO content_publication_classification VALUES(?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET environment=excluded.environment,visibility=excluded.visibility,updated_at=excluded.updated_at').run(contentId, environment, visibility, isoNow());
  }
  recordConversationTurn({ chatId, updateId = null, role, text, interpretation = {}, outcome = null }) {
    if (!['user', 'assistant'].includes(role)) throw new Error('Invalid conversation role');
    const safeText = String(text || '').replaceAll('\u0000', '').trim().slice(0, 1600); if (!safeText) return null;
    const now = isoNow(); const id = randomId();
    this.db.prepare('INSERT OR IGNORE INTO telegram_conversation_turns VALUES(?,?,?,?,?,?,?,?)').run(id, String(chatId), Number.isInteger(updateId) ? updateId : null, role, safeText, json(interpretation), outcome ? String(outcome).slice(0, 120) : null, now);
    return id;
  }
  getConversationTurns(chatId, limit = 12) {
    return this.db.prepare('SELECT role,text,outcome,created_at FROM telegram_conversation_turns WHERE chat_id=? ORDER BY created_at DESC LIMIT ?').all(String(chatId), Math.max(1, Math.min(Number(limit) || 12, 12))).reverse();
  }
  getConversationState(chatId) {
    const row = this.db.prepare('SELECT * FROM telegram_conversation_state WHERE chat_id=?').get(String(chatId));
    return row ? { ...row, active_revision_number: row.active_revision_number === null ? null : Number(row.active_revision_number), ideaOptions: parseJson(row.idea_options_json), oneTimePreferences: parseJson(row.one_time_preferences_json) } : { chat_id: String(chatId), active_content_id: null, active_revision_number: null, ideaOptions: [], oneTimePreferences: [], last_bot_action: null };
  }
  updateConversationState(chatId, { activeContentId = undefined, activeRevisionNumber = undefined, ideaOptions = undefined, oneTimePreferences = undefined, lastBotAction = undefined } = {}) {
    return this.transaction(() => {
      const current = this.getConversationState(chatId); const now = isoNow();
      const next = {
        activeContentId: activeContentId === undefined ? current.active_content_id : activeContentId,
        activeRevisionNumber: activeRevisionNumber === undefined ? current.active_revision_number : activeRevisionNumber,
        ideaOptions: ideaOptions === undefined ? current.ideaOptions : ideaOptions,
        oneTimePreferences: oneTimePreferences === undefined ? current.oneTimePreferences : oneTimePreferences,
        lastBotAction: lastBotAction === undefined ? current.last_bot_action : lastBotAction,
      };
      this.db.prepare('INSERT INTO telegram_conversation_state(chat_id,active_content_id,active_revision_number,idea_options_json,one_time_preferences_json,updated_at,last_bot_action) VALUES(?,?,?,?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET active_content_id=excluded.active_content_id,active_revision_number=excluded.active_revision_number,idea_options_json=excluded.idea_options_json,one_time_preferences_json=excluded.one_time_preferences_json,updated_at=excluded.updated_at,last_bot_action=excluded.last_bot_action').run(String(chatId), next.activeContentId || null, Number.isInteger(next.activeRevisionNumber) ? next.activeRevisionNumber : null, json(Array.isArray(next.ideaOptions) ? next.ideaOptions.slice(0, 8) : []), json(Array.isArray(next.oneTimePreferences) ? next.oneTimePreferences.slice(0, 8) : []), now, next.lastBotAction || null);
      return this.getConversationState(chatId);
    });
  }
  recordInterpretation({ chatId, updateId, interpretation, outcome }) {
    this.db.prepare("UPDATE telegram_conversation_turns SET interpretation_json=?,outcome=? WHERE chat_id=? AND update_id=? AND role='user'").run(json(interpretation), String(outcome || '').slice(0, 120), String(chatId), Number(updateId));
  }
  consumeSemanticQuota(chatId, { limit = 20, windowMs = 60_000 } = {}) {
    return this.transaction(() => {
      const now = isoNow(); const row = this.db.prepare('SELECT * FROM telegram_semantic_rate_limits WHERE chat_id=?').get(String(chatId));
      const fresh = !row || Date.now() - Date.parse(row.window_started) >= windowMs;
      const count = fresh ? 1 : Number(row.call_count) + 1;
      if (count > limit) return false;
      this.db.prepare('INSERT INTO telegram_semantic_rate_limits(chat_id,window_started,call_count,updated_at) VALUES(?,?,?,?) ON CONFLICT(chat_id) DO UPDATE SET window_started=excluded.window_started,call_count=excluded.call_count,updated_at=excluded.updated_at').run(String(chatId), fresh ? now : row.window_started, count, now);
      return true;
    });
  }
  activeConversationContent(chatId) {
    return this.activeTaskForChat(chatId)?.item || null;
  }
  recoverActiveJobs() {
    const rows = this.db.prepare("SELECT p.*,c.state FROM content_progress p JOIN content_items c ON c.content_id=p.content_id WHERE c.state IN ('IDEA_DISCOVERED','RESEARCHING','SCRIPTING','PRODUCING','QC','REVISION_REQUESTED','REVISING')").all();
    const recovered = [];
    for (const row of rows) {
      const job = row.job_id && this.db.prepare('SELECT * FROM workflow_jobs WHERE id=?').get(row.job_id);
      if (row.worker_status === 'WAITING' && !row.waiting_reason && AUTOMATED_STAGES.includes(row.current_stage)) { this.updateProgress({ contentId: row.content_id, stage: row.current_stage, workerStatus: 'QUEUED', jobId: null, waitingReason: null, waitingSince: null, lastError: 'Repaired invalid bare WAITING state' }); recovered.push(row.content_id); continue; }
      if (job?.status === 'QUEUED') { this.updateProgress({ contentId: row.content_id, stage: row.current_stage, workerStatus: 'QUEUED', jobId: job.id, lastError: null, waitingReason: null, waitingSince: null }); recovered.push(row.content_id); continue; }
      if (job?.status === 'CLAIMED') continue;
      if (row.worker_status === 'RUNNING' || row.worker_status === 'QUEUED') {
        const queued = this.queueJob('RUN_CONTENT_PIPELINE', { contentId: row.content_id, revisionNumber: this.getContent(row.content_id).current_revision }, isoNow(), `content-pipeline:${row.content_id}:r${this.getContent(row.content_id).current_revision}`);
        if (queued.job?.status === 'QUEUED') { this.updateProgress({ contentId: row.content_id, stage: row.current_stage, workerStatus: 'QUEUED', jobId: queued.job.id, lastError: null }); recovered.push(row.content_id); }
        else this.updateProgress({ contentId: row.content_id, stage: 'FAILED', workerStatus: 'FAILED', lastError: 'The durable worker job was not recoverable' });
      }
    }
    return recovered;
  }
  resumeFailedAtStage({ contentId, revisionNumber, stage, reason = 'Recovered after a corrected local worker error' }) {
    if (!AUTOMATED_STAGES.includes(stage)) throw new Error('Can only resume an automated stage');
    return this.transaction(() => {
      const item = this.getContent(contentId); if (!item || item.state !== 'FAILED' || item.current_revision !== Number(revisionNumber)) throw new Error('Content is not eligible for targeted resume');
      const state = ['WRITING_SCRIPT'].includes(stage) ? 'SCRIPTING' : ['GENERATING_VOICE','BUILDING_VISUALS','RENDERING'].includes(stage) ? 'PRODUCING' : stage === 'QC' ? 'QC' : 'RESEARCHING';
      this.db.prepare('UPDATE content_items SET state=?,updated_at=? WHERE content_id=?').run(state, isoNow(), contentId);
      this.updateProgress({ contentId, stage, workerStatus: 'QUEUED', jobId: null, waitingReason: null, waitingSince: null, nextRetryAt: null, lastError: null });
      this.audit('CONTENT_RESUMED_FROM_FAILURE', 'recovery', { contentId, revisionNumber, stage, reason }); return this.getContent(contentId);
    });
  }
  findActiveStageJob(contentId, revisionNumber, stage) { return this.db.prepare("SELECT * FROM workflow_jobs WHERE kind='RUN_STAGE' AND status IN ('QUEUED','CLAIMED') AND json_extract(payload_json,'$.contentId')=? AND json_extract(payload_json,'$.revisionNumber')=? AND json_extract(payload_json,'$.stage')=? ORDER BY created_at DESC LIMIT 1").get(contentId, Number(revisionNumber), stage) || null; }
  queueStageIfAbsent({ contentId, revisionNumber, stage, runAfter = isoNow(), attempt = 0 }) {
    const existing = this.findActiveStageJob(contentId, revisionNumber, stage); if (existing) return { inserted: false, job: existing };
    return this.queueJob('RUN_STAGE', { contentId, revisionNumber: Number(revisionNumber), stage }, runAfter, `stage:${contentId}:r${revisionNumber}:${stage}:${attempt}:${randomId(4)}`);
  }
  isNewTelegramUpdate(updateId) { try { this.db.prepare('INSERT INTO telegram_updates VALUES(?,?)').run(updateId, isoNow()); return true; } catch { return false; } }
  issueTelegramCallback({ action, contentId, revisionNumber, fingerprint, expiresAt }) { const nonce = randomId(9); this.db.prepare('INSERT INTO telegram_callbacks VALUES(?,?,?,?,?,?,NULL)').run(nonce, action, contentId, revisionNumber, fingerprint, new Date(expiresAt).toISOString()); return nonce; }
  consumeTelegramCallback(nonce) { return this.transaction(() => { const row = this.db.prepare('SELECT * FROM telegram_callbacks WHERE nonce=? AND used_at IS NULL AND expires_at>?').get(nonce, isoNow()); if (!row) return null; this.db.prepare('UPDATE telegram_callbacks SET used_at=? WHERE nonce=? AND used_at IS NULL').run(isoNow(), nonce); return row; }); }
  addSource(contentId, source) { this.db.prepare('INSERT OR IGNORE INTO research_sources(content_id,url,title,retrieved_at,claims_json) VALUES(?,?,?,?,?)').run(contentId, source.url, source.title, source.retrievedAt || isoNow(), json(source.claims || [])); }
  integrityCheck() { return this.db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]); }
}
