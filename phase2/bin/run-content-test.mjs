import path from 'node:path';
import { Store } from '../src/store.mjs';
import { loadConfig, assertSandboxOnly } from '../src/config.mjs';
import { createLocalSendIntegrationCandidate, renderRequestedRevision } from '../src/pipeline.mjs';
import { TelegramClient, TelegramControl, reviewKeyboard } from '../src/telegram.mjs';

const config = loadConfig(); assertSandboxOnly(config);
const store = new Store(path.join(config.dataDir, 'useful-tech-manager.sqlite'));
try {
  const contentIdFlag = process.argv.indexOf('--content-id'); const contentId = contentIdFlag >= 0 ? process.argv[contentIdFlag + 1] : undefined;
  const revisionMode = process.argv.includes('--revision');
  const result = revisionMode ? await renderRequestedRevision({ store, config, contentId }) : await createLocalSendIntegrationCandidate({ store, config, contentId });
  const item = result.content; const revision = result.revision; const control = new TelegramControl({ store, config, signingSecret: config.telegram.signingSecret });
  const keyboard = reviewKeyboard({ store, contentId: item.content_id, revisionNumber: item.current_revision, fingerprint: store.revisionFingerprint(item.content_id, item.current_revision), secret: control.signingSecret });
  const telegram = new TelegramClient(config.telegram.token);
  await telegram.sendReady({ chatId: config.telegram.ownerChatId, topic: item.topic, hook: item.selected_hook, duration: `${Math.round(result.output.qc.duration)}s`, filePath: revision.artifact_path, keyboard });
  console.log(`content-ready id=${item.content_id} revision=${item.current_revision} qc=passed`);
} finally { store.close(); }
