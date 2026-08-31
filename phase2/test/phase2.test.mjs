import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.mjs';
import { createCallbackToken, TelegramControl } from '../src/telegram.mjs';
import { archiveApproved } from '../src/archive.mjs';
import { inspectMp4 } from '../src/qc.mjs';
import { createDashboard } from '../src/dashboard.mjs';
import { DurableScheduler } from '../src/scheduler.mjs';
import { TikTokAdapter } from '../src/tiktok.mjs';

const exec = promisify(execFile); const config = { telegram: { ownerUserId: '99', ownerChatId: '77', token: '' }, dashboardHost: '127.0.0.1', dashboardPort: 0, tiktokEnv: 'sandbox', productionEnabled: false };
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'utm-phase2-')); const video = path.join(dir, 'test.mp4');
  await exec('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=0x162c47:s=1080x1920:r=30:d=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=25', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', video]);
  const qc = await inspectMp4(video); const hash = createHash('sha256').update(await (await import('node:fs/promises')).readFile(video)).digest('hex'); return { dir, video, hash, qc };
}
function ready(store, asset) {
  const content = store.createContent({ topic: 'Safe Test Video' }); for (const state of ['RESEARCHING','SCRIPTING','PRODUCING','QC']) store.transition(content.content_id, state); store.setRevisionArtifact({ contentId: content.content_id, revisionNumber: 1, artifactPath: asset.video, artifactSha256: asset.hash, settings: { privacy: 'SELF_ONLY' }, qc: asset.qc }); store.transition(content.content_id, 'READY_FOR_REVIEW'); return content.content_id;
}
test('approval binds exact current revision and invalidates after a revision', async (t) => {
  const asset = await fixture(); t.after(() => rm(asset.dir, { recursive: true, force: true })); assert.equal(asset.qc.pass, true); const store = new Store(); const contentId = ready(store, asset); const fingerprint = store.revisionFingerprint(contentId, 1);
  assert.throws(() => store.approveExact({ contentId, revisionNumber: 1, fingerprint, userId: 'x', chatId: '77', expectedUserId: '99', expectedChatId: '77' }), /Unauthorized/);
  store.approveExact({ contentId, revisionNumber: 1, fingerprint, userId: '99', chatId: '77', expectedUserId: '99', expectedChatId: '77' }); assert.doesNotThrow(() => store.assertPublishable(contentId, 1));
  store.createRevision(contentId, 'Stronger hook'); assert.throws(() => store.assertPublishable(contentId, 1), /No exact active approval/); store.close();
});
test('signed Telegram button is authorized and cannot approve a changed revision', async (t) => {
  const asset = await fixture(); t.after(() => rm(asset.dir, { recursive: true, force: true })); const store = new Store(); const contentId = ready(store, asset); const fingerprint = store.revisionFingerprint(contentId, 1); const secret = 'unit-test-secret'; const control = new TelegramControl({ store, config, signingSecret: secret }); const token = createCallbackToken({ action: 'approve', contentId, revisionNumber: 1, fingerprint, secret });
  const unauthorized = control.handleUpdate({ update_id: 1, callback_query: { data: token, from: { id: 1 }, message: { chat: { id: 77 } } } }); assert.equal(unauthorized.ignored, 'unauthorized');
  const approved = control.handleUpdate({ update_id: 2, callback_query: { data: token, from: { id: 99 }, message: { chat: { id: 77 } } } }); assert.equal(approved.type, 'approved'); assert.throws(() => control.handleUpdate({ update_id: 3, callback_query: { data: token, from: { id: 99 }, message: { chat: { id: 77 } } } }), /already used/); store.close();
});
test('archive contains exactly one verified approved MP4', async (t) => {
  const asset = await fixture(); t.after(() => rm(asset.dir, { recursive: true, force: true })); const store = new Store(); const contentId = ready(store, asset); const fingerprint = store.revisionFingerprint(contentId, 1); store.approveExact({ contentId, revisionNumber: 1, fingerprint, userId: '99', chatId: '77', expectedUserId: '99', expectedChatId: '77' }); const archive = path.join(asset.dir, 'archive'); const archived = await archiveApproved({ store, contentId, revisionNumber: 1, archiveRoot: archive, approvedWorkRoot: asset.dir }); assert.equal(path.basename(archived), 'Safe Test Video.mp4'); const entries = await (await import('node:fs/promises')).readdir(path.dirname(archived)); assert.deepEqual(entries, ['Safe Test Video.mp4']); store.close();
});
test('dashboard is loopback read-only', async (t) => {
  const store = new Store(); const server = createDashboard(store, config); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; t.after(() => server.close()); const post = await fetch(`http://127.0.0.1:${port}/api/content`, { method: 'POST' }); assert.equal(post.status, 405); const get = await fetch(`http://127.0.0.1:${port}/api/overview`); assert.equal(get.status, 200); store.close();
});
test('scheduler creates research only and TikTok Production is hard denied', () => {
  const store = new Store(); const scheduler = new DurableScheduler(store); scheduler.scheduleDailyResearch('2026-08-31'); const job = scheduler.claimDueJob(); assert.equal(job.kind, 'DISCOVER_IDEAS'); assert.equal(store.db.prepare('SELECT count(*) AS value FROM publish_intents').get().value, 0);
  assert.throws(() => new TikTokAdapter({ store, config: { ...config, tiktokEnv: 'production', productionEnabled: false } }), /Production TikTok is locked/); store.close();
});
test('publisher claims one exact approved intent and rechecks the fingerprint', async (t) => {
  const asset = await fixture(); t.after(() => rm(asset.dir, { recursive: true, force: true })); const store = new Store(); const contentId = ready(store, asset); const fingerprint = store.revisionFingerprint(contentId, 1); store.approveExact({ contentId, revisionNumber: 1, fingerprint, userId: '99', chatId: '77', expectedUserId: '99', expectedChatId: '77' }); const claim = store.claimPublishIntent(contentId, 1); assert.equal(claim.intent.status, 'CLAIMED'); assert.doesNotThrow(() => store.assertPublishable(contentId, 1)); assert.throws(() => store.claimPublishIntent(contentId, 1), /available to claim/); store.close();
});
