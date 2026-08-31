import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { DurableScheduler } from '../src/scheduler.mjs';
import { TelegramControl } from '../src/telegram.mjs';
import { FixedSemanticInterpreter } from '../src/semantic.mjs';

const config = { telegram: { ownerUserId: '99', ownerChatId: '77', token: '' }, tiktokEnv: 'sandbox', productionEnabled: false };
const semantic = (intent) => ({ intent, confidence: 0.96, content_reference: 'current', revision_reference: 'current', idea_index: null, parameters: { topic: null, category: null, duration_preference: null }, editorial_instruction: null, editorial_scope: null, requires_clarification: false, explicit_approval: false });
const message = (id, text) => ({ update_id: id, message: { text, from: { id: 99 }, chat: { id: 77, type: 'private' } } });

test('start acknowledgement is gated on a durable claimed job and status reads active content, not history', async () => {
  const store = new Store(); const scheduler = new DurableScheduler(store);
  const intents = [semantic('START_NEW_CONTENT'), semantic('ACTIVE_STATUS'), semantic('ACTIVE_STATUS'), semantic('CONTENT_HISTORY'), semantic('ACCOUNT_STATS')];
  const control = new TelegramControl({
    store, config, signingSecret: 'test', interpreter: new FixedSemanticInterpreter(async () => intents.shift()),
    startContent: async ({ chatId, selectedIdea }) => {
      const task = store.createAndQueueContentTask({ chatId, topic: selectedIdea.title, category: selectedIdea.category });
      const claimed = scheduler.claimJob(task.job.id); if (!claimed) return { accepted: false };
      store.updateProgress({ contentId: task.content.content_id, stage: 'DISCOVERING_IDEAS', workerStatus: 'RUNNING', jobId: claimed.id, lastSuccessfulStep: 'Worker accepted durable job' });
      return { accepted: true, content: task.content, job: claimed };
    },
  });
  const started = await control.handleUpdate(message(1, 'شوف لنا فيديو بفكرة جديدة بدون نشر'));
  assert.equal(started.type, 'content-started'); assert.ok(started.content.content_id);
  const job = store.db.prepare('SELECT status,kind FROM workflow_jobs WHERE id=?').get(started.job.id); assert.equal(job.status, 'CLAIMED'); assert.equal(job.kind, 'RUN_CONTENT_PIPELINE');
  const progress = store.getProgress(started.content.content_id); assert.equal(progress.worker_status, 'RUNNING');
  store.updateProgress({ contentId: started.content.content_id, stage: 'RESEARCHING', workerStatus: 'RUNNING', lastSuccessfulStep: 'Source discovery complete' });
  const status = await control.handleUpdate(message(2, 'شنو وياك؟')); assert.equal(status.type, 'active-status'); assert.match(status.text, /أبحث في المصادر/); assert.match(status.text, new RegExp(started.content.topic));
  const running = await control.handleUpdate(message(3, 'قاعد تشتغل على فيديو جديد؟')); assert.equal(running.type, 'active-status'); assert.match(running.text, /قاعد أشتغل/);
  const sandbox = store.createContent({ topic: 'LocalSend Sandbox Test' }); store.classifyPublication(sandbox.content_id, { environment: 'sandbox', visibility: 'SELF_ONLY' });
  const history = await control.handleUpdate(message(4, 'شنو الفيديوهات السابقة؟')); assert.equal(history.type, 'history'); assert.doesNotMatch(history.text, /LocalSend Sandbox Test/);
  const analytics = await control.handleUpdate(message(5, 'شلون أداء الحساب؟')); assert.equal(analytics.type, 'analytics');
  store.updateConversationState('77', { activeContentId: null, activeRevisionNumber: null });
  const none = control.activeStatusResult('77'); assert.match(none.text, /ما عندي مهمة إنتاج شغالة/);
  store.close();
});

test('orphaned claimed work is re-queued safely after lease recovery without duplicating content', () => {
  const store = new Store(); const scheduler = new DurableScheduler(store);
  const task = store.createAndQueueContentTask({ chatId: '77', topic: 'Recovery Test' }); const claimed = scheduler.claimJob(task.job.id);
  assert.ok(claimed); store.updateProgress({ contentId: task.content.content_id, stage: 'RESEARCHING', workerStatus: 'RUNNING', jobId: claimed.id });
  store.db.prepare("UPDATE workflow_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id=?").run(claimed.id);
  scheduler.recoverExpiredLeases(); const recovered = store.recoverActiveJobs();
  assert.ok(recovered.includes(task.content.content_id)); assert.equal(store.getProgress(task.content.content_id).worker_status, 'QUEUED');
  assert.equal(store.db.prepare('SELECT count(*) AS value FROM content_items').get().value, 1);
  store.close();
});
