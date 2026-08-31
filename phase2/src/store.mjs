import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { isoNow, json, parseJson, randomId, secureEqual, sha256 } from './util.mjs';

export const STATES = Object.freeze(['IDEA_DISCOVERED', 'RESEARCHING', 'SCRIPTING', 'PRODUCING', 'QC', 'READY_FOR_REVIEW', 'REVISION_REQUESTED', 'REVISING', 'APPROVED', 'ARCHIVED', 'PUBLISHING', 'PUBLISHED', 'REJECTED', 'SKIPPED', 'FAILED']);
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
      CREATE TABLE IF NOT EXISTS editorial_preferences(id TEXT PRIMARY KEY, rule_text TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_snapshots(id INTEGER PRIMARY KEY, content_id TEXT REFERENCES content_items(content_id), captured_at TEXT NOT NULL, views INTEGER, likes INTEGER, shares INTEGER, comments INTEGER, followers INTEGER, raw_json TEXT NOT NULL DEFAULT '{}');
      CREATE TABLE IF NOT EXISTS archive_records(content_id TEXT PRIMARY KEY, revision_number INTEGER NOT NULL, archive_path TEXT NOT NULL UNIQUE, artifact_sha256 TEXT NOT NULL, archived_at TEXT NOT NULL, FOREIGN KEY(content_id,revision_number) REFERENCES content_revisions(content_id,revision_number));
      CREATE TABLE IF NOT EXISTS audit_events(id TEXT PRIMARY KEY, content_id TEXT, revision_number INTEGER, event_type TEXT NOT NULL, actor TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
    `);
  }
  close() { this.db.close(); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  audit(eventType, actor, data = {}) { this.db.prepare('INSERT INTO audit_events VALUES(?,?,?,?,?,?,?)').run(randomId(), data.contentId || null, data.revisionNumber || null, eventType, actor, json(data), isoNow()); }
  createContent({ topic, category = 'useful-app', ideaScore = null, hook = '', hookType = '', contentId }) {
    return this.transaction(() => {
      const now = isoNow(); const id = contentId || `UT-${now.slice(0, 10).replaceAll('-', '')}-${randomId(4).toUpperCase()}`;
      this.db.prepare('INSERT INTO content_items VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, topic, category, 'IDEA_DISCOVERED', 1, ideaScore, hook, hookType, now, now, null, null);
      this.db.prepare('INSERT INTO content_revisions(content_id,revision_number,created_at) VALUES(?,?,?)').run(id, 1, now);
      this.audit('CONTENT_CREATED', 'system', { contentId: id, revisionNumber: 1 }); return this.getContent(id);
    });
  }
  getContent(contentId) { const row = this.db.prepare('SELECT * FROM content_items WHERE content_id=?').get(contentId); return row && { ...row, current_revision: Number(row.current_revision) }; }
  getRevision(contentId, revisionNumber) { const row = this.db.prepare('SELECT * FROM content_revisions WHERE content_id=? AND revision_number=?').get(contentId, revisionNumber); return row && { ...row, script: parseJson(row.script_json), sources: parseJson(row.source_snapshot_json), settings: parseJson(row.posting_settings_json), qc: parseJson(row.qc_json) }; }
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
  queueJob(kind, payload, runAfter = isoNow(), idempotencyKey = `${kind}:${randomId()}`) { const now = isoNow(); this.db.prepare('INSERT OR IGNORE INTO workflow_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomId(), kind, json(payload), 'QUEUED', runAfter, null, 0, idempotencyKey, now, now, null); }
  queueOutbox(kind, payload, idempotencyKey) { const now = isoNow(); this.db.prepare('INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomId(), kind, json(payload), 'QUEUED', 0, now, idempotencyKey, now, now, null); }
  listContent(limit = 50) { return this.db.prepare('SELECT * FROM content_items ORDER BY updated_at DESC LIMIT ?').all(limit); }
  isNewTelegramUpdate(updateId) { try { this.db.prepare('INSERT INTO telegram_updates VALUES(?,?)').run(updateId, isoNow()); return true; } catch { return false; } }
  consumeTelegramNonce(nonce, action, expiresAt) { try { this.db.prepare('INSERT INTO telegram_nonces(nonce,action,expires_at,used_at) VALUES(?,?,?,?)').run(nonce, action, new Date(expiresAt).toISOString(), isoNow()); return true; } catch { return false; } }
  addSource(contentId, source) { this.db.prepare('INSERT OR IGNORE INTO research_sources(content_id,url,title,retrieved_at,claims_json) VALUES(?,?,?,?,?)').run(contentId, source.url, source.title, source.retrievedAt || isoNow(), json(source.claims || [])); }
  integrityCheck() { return this.db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]); }
}
