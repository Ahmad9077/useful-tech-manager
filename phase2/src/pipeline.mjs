import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VideoProductionAdapter } from './production.mjs';
import { approvedLocalSendTestRenderer } from './baseline-renderer.mjs';
import { writeTtsSample } from './tts.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const approvedLocalSendMaster = path.resolve(here, '../../../LocalSend-Style-Test-v2/renders/localsend-full-final.mp4');
const sourceSnapshot = [
  { url: 'https://localsend.org/', title: 'LocalSend official website', claims: ['Local network sharing between nearby devices', 'No account required', 'Free and open source'] },
  { url: 'https://github.com/localsend/localsend', title: 'LocalSend official GitHub repository', claims: ['Open-source cross-platform alternative to AirDrop'] },
];
const hooks = [
  'لسه ترسل مَلَف من الآيفون للويندوز بالواتساب؟',
  'نقل المَلَفات بين أجهزتك ما يحتاج إيميل ولا حساب.',
  'إذا عندك آيفون وويندوز، هذا الحل يختصر عليك الطريق.'
];
const script = {
  narration: 'لِسَّه تُرْسِل مَلَف مِن الآيفون للوِيندوز بالواتساب؟ لوكل سِند ينقل المَلَفات بين أجهزتك على نفس الشبكة، بدون حساب. اختَر المَلَف، اختَر الجهاز، وخلاص. يشتغل على آيفون وويندوز وماك وأندرويد ولينكس. مجاني ومفتوح المصدر، بس لازم الأجهزة تقدر تتواصل على نفس الشبكة.',
  caption: 'انقل مَلَفاتك بين آيفون وويندوز بدون حساب',
  hashtags: ['#تقنية_تفيدك', '#LocalSend'],
};

function adapter(store, config) {
  return new VideoProductionAdapter({ store, workingRoot: path.join(config.dataDir, 'work'), renderer: approvedLocalSendTestRenderer({ sourceFile: approvedLocalSendMaster }) });
}
async function renderCurrent({ store, config, contentId, revisionNumber }) {
  const revision = store.getRevision(contentId, revisionNumber); const item = store.getContent(contentId);
  const production = adapter(store, config); const prepared = await production.prepare({ contentId, revisionNumber, script: revision.script, hooks, sources: revision.sources });
  // This verifies that the configured Saudi voice can render the diacritized production text.
  await writeTtsSample({ config, workspace: path.join(prepared.dir, 'voice'), text: revision.script.narration });
  const output = await production.render({ contentId, revisionNumber, manifest: prepared.manifest });
  if (item.state === 'PRODUCING' || item.state === 'REVISING') store.transition(contentId, 'QC', 'pipeline');
  store.transition(contentId, 'READY_FOR_REVIEW', 'pipeline');
  return { content: store.getContent(contentId), revision: store.getRevision(contentId, revisionNumber), output };
}

export async function createLocalSendIntegrationCandidate({ store, config, contentId } = {}) {
  const existing = contentId && store.getContent(contentId);
  if (existing) return renderCurrent({ store, config, contentId, revisionNumber: existing.current_revision });
  const item = store.createContent({ contentId, topic: 'LocalSend', category: 'useful-app', ideaScore: 8.7, hook: hooks[0], hookType: 'common-frustration' });
  store.transition(item.content_id, 'RESEARCHING', 'pipeline');
  sourceSnapshot.forEach((source) => store.addSource(item.content_id, { ...source, retrievedAt: new Date().toISOString() }));
  store.setRevisionPlan({ contentId: item.content_id, revisionNumber: 1, script, sources: sourceSnapshot, actor: 'pipeline' });
  store.transition(item.content_id, 'SCRIPTING', 'pipeline'); store.transition(item.content_id, 'PRODUCING', 'pipeline');
  return renderCurrent({ store, config, contentId: item.content_id, revisionNumber: 1 });
}

export async function renderRequestedRevision({ store, config, contentId }) {
  throw new Error('NON_CANONICAL_REVISION_RENDERER_DISABLED: revisions must be dispatched through the canonical Cartesia/Remotion pipeline');
}
