import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { DurableScheduler } from '../src/scheduler.mjs';
import { Phase2Service } from '../src/service.mjs';

const config = { dataDir: '/tmp/utm-stage-test', archiveDir: '/tmp/utm-stage-archive', dashboardHost: '127.0.0.1', dashboardPort: 0, tiktokEnv: 'sandbox', productionEnabled: false, telegram: {}, cartesiaVoiceId: 'test', geminiKeychainService: '', geminiKeychainAccount: '' };

test('automated content cannot be left in bare WAITING and ready review may wait only for approval', () => {
  const store = new Store(); const item = store.createContent({ topic: 'Stage test' });
  assert.throws(() => store.updateProgress({ contentId: item.content_id, stage: 'WRITING_SCRIPT', workerStatus: 'WAITING' }), /WAITING requires/);
  assert.throws(() => store.updateProgress({ contentId: item.content_id, stage: 'WRITING_SCRIPT', workerStatus: 'WAITING', waitingReason: 'WAITING_FOR_USER_APPROVAL' }), /Automated stages/);
  assert.doesNotThrow(() => store.updateProgress({ contentId: item.content_id, stage: 'READY_FOR_REVIEW', workerStatus: 'WAITING', waitingReason: 'WAITING_FOR_USER_APPROVAL' }));
  store.close();
});

test('worker claims persist ownership and heartbeats, while watchdog queues a stalled automated checkpoint exactly once', () => {
  const store = new Store(); const scheduler = new DurableScheduler(store); const item = store.createContent({ topic: 'Watchdog test' });
  const queued = store.queueStageIfAbsent({ contentId: item.content_id, revisionNumber: 1, stage: 'DISCOVERING_IDEAS' }); const claimed = scheduler.claimJob(queued.job.id, 'worker-a');
  assert.equal(claimed.worker_id, 'worker-a'); scheduler.extendLease(claimed.id, 'worker-a');
  const job = store.db.prepare('SELECT worker_id,claimed_at,heartbeat_at,lease_until FROM workflow_jobs WHERE id=?').get(claimed.id); assert.equal(job.worker_id, 'worker-a'); assert.ok(job.claimed_at && job.heartbeat_at && job.lease_until);
  store.db.prepare("UPDATE workflow_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id); scheduler.recoverExpiredLeases();
  const service = new Phase2Service(config); service.store = store; service.scheduler = scheduler; service.watchdog(); service.watchdog();
  const active = store.findActiveStageJob(item.content_id, 1, 'DISCOVERING_IDEAS'); assert.ok(active); assert.equal(store.db.prepare("SELECT count(*) AS n FROM workflow_jobs WHERE kind='RUN_STAGE' AND status IN ('QUEUED','CLAIMED')").get().n, 1);
  store.close();
});
