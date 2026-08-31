import { loadConfig, assertSandboxOnly } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { TelegramControl } from '../src/telegram.mjs';

const config = loadConfig(); assertSandboxOnly(config);
const ownerId = Number(config.telegram.ownerUserId); const chatId = Number(config.telegram.ownerChatId);
if (!Number.isInteger(ownerId) || !Number.isInteger(chatId)) throw new Error('Telegram owner is not configured');
const store = new Store();
const item = store.createContent({ topic: 'Semantic routing test', category: 'test' });
for (const state of ['RESEARCHING', 'SCRIPTING', 'PRODUCING', 'QC']) store.transition(item.content_id, state);
store.setRevisionArtifact({ contentId: item.content_id, revisionNumber: 1, artifactPath: '/private/tmp/semantic-routing-test.mp4', artifactSha256: 'a'.repeat(64), settings: { privacy: 'SELF_ONLY' }, qc: { pass: true } });
store.transition(item.content_id, 'READY_FOR_REVIEW'); store.updateConversationState(chatId, { activeContentId: item.content_id, activeRevisionNumber: 1 });
const control = new TelegramControl({ store, config, signingSecret: config.telegram.signingSecret });
const update = (id, text) => ({ update_id: id, message: { text, from: { id: ownerId }, chat: { id: chatId, type: 'private' } } });
const sequence = ['شنو عندك حق اليوم؟', 'انت اختار احسن واحد وسوه', 'اذا خلصت دزه لي', 'البداية ما عجبتني غيرها', 'اي هذي احسن', 'اعتمد هذي النسخة'];
const results = [];
for (const [index, text] of sequence.entries()) {
  const result = await control.handleUpdate(update(9_001 + index, text)); results.push(result.type);
  if (index === 3) {
    const current = store.getContent(item.content_id); store.transition(item.content_id, 'QC'); store.setRevisionArtifact({ contentId: item.content_id, revisionNumber: current.current_revision, artifactPath: '/private/tmp/semantic-routing-test-r2.mp4', artifactSha256: 'b'.repeat(64), settings: { privacy: 'SELF_ONLY' }, qc: { pass: true } }); store.transition(item.content_id, 'READY_FOR_REVIEW');
  }
}
const expected = ['ideas', 'content-started', 'delivery-instruction', 'revision-requested', 'positive-feedback', 'approved'];
if (JSON.stringify(results) !== JSON.stringify(expected)) throw new Error(`Semantic live sequence mismatch: ${results.join(',')}`);
console.log('semantic-live-test: PASS'); store.close();
