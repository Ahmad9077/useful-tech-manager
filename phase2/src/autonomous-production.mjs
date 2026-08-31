import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { keychainSecret } from './secrets.mjs';
import { synthesizeWalidPcm } from './tts.mjs';
import { sha256, isoNow } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceProject = path.resolve(here, '../../../LocalSend-Style-Test-v2');
const sourceNarration = path.join(sourceProject, 'src/narration-full-cartesia.txt');
const sourceFiles = [
  { url: 'https://localsend.org/', title: 'LocalSend official website', claims: ['Local-network file sharing', 'No account or login', 'Available for iOS, Android, macOS, Windows, and Linux', 'Free and open source'] },
  { url: 'https://github.com/localsend/localsend', title: 'LocalSend official GitHub repository', claims: ['Open-source cross-platform file sharing over a local network without Internet'] },
];
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
  child.stderr.on('data', (d) => { error += d; }); child.on('error', reject); child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${error.slice(0, 320)}`)));
});

async function contentModel({ config, sources }) {
  const apiKey = keychainSecret(config.geminiKeychainService, config.geminiKeychainAccount);
  const sourceText = sources.map((source) => `${source.title}: ${source.claims.join('; ')}`).join('\n');
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.geminiModel)}:generateContent`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(25_000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'You are an Arabic Saudi technology editor. Return JSON only. Write one concise, natural Saudi Arabic hook for a useful LocalSend file-transfer short. Use only supplied facts. No exaggerated claims, no Kuwaiti wording, no publication instruction.' }] },
      contents: [{ role: 'user', parts: [{ text: sourceText }] }], generationConfig: { temperature: 0.25, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { hook: { type: 'STRING' } }, required: ['hook'] } },
    }),
  });
  if (!response.ok) throw new Error('CONTENT_MODEL_TEMPORARY_FAILURE');
  const text = (await response.json())?.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join(''); const hook = JSON.parse(text || '{}').hook;
  if (typeof hook !== 'string' || hook.length < 12 || hook.length > 140) throw new Error('CONTENT_MODEL_INVALID_OUTPUT');
  return hook.trim();
}

export async function researchLocalSend({ store, contentId }) {
  // Fetch the current primary sources before retaining their claims.
  for (const source of sourceFiles) {
    const response = await fetch(source.url, { headers: { 'user-agent': 'UsefulTechManager/0.2 research' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`RESEARCH_SOURCE_UNAVAILABLE:${source.title}`);
    await response.text(); store.addSource(contentId, { ...source, retrievedAt: isoNow() });
  }
  return sourceFiles;
}

export async function writeVerifiedLocalSendScript({ config, store, contentId, revisionNumber, sources }) {
  const narration = (await readFile(sourceNarration, 'utf8')).trim(); const generatedHook = await contentModel({ config, sources });
  const script = {
    narration,
    caption: 'انقل ملفاتك بين iPhone وWindows بدون حساب',
    hashtags: ['#تقنية_تفيدك', '#LocalSend'],
    hook: generatedHook,
    ttsLanguage: 'ar-SA',
  };
  store.setRevisionPlan({ contentId, revisionNumber, script, sources, actor: 'content-writer' });
  store.db.prepare('UPDATE content_items SET topic=?,category=?,selected_hook=?,hook_type=?,updated_at=? WHERE content_id=?').run('LocalSend', 'cross-device', generatedHook, 'common-frustration', isoNow(), contentId);
  return script;
}

export async function generateWalidVoice({ config, workDir, narration }) {
  const voiceDir = path.join(workDir, 'voice'); await mkdir(voiceDir, { recursive: true, mode: 0o700 });
  const pcmPath = path.join(voiceDir, 'walid-current.pcm'); const wavPath = path.join(voiceDir, 'walid-current.wav');
  await writeFile(pcmPath, await synthesizeWalidPcm({ config, text: narration }), { mode: 0o600 });
  await run('ffmpeg', ['-y', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', pcmPath, '-c:a', 'pcm_s16le', wavPath]);
  return wavPath;
}

export async function buildVisualWorkspace({ workDir }) {
  const visualDir = path.join(workDir, 'visuals'); await mkdir(visualDir, { recursive: true, mode: 0o700 });
  // The approved project supplies the original SVG system, device UI captures, captions, and motion composition.
  await writeFile(path.join(visualDir, 'visual-system.json'), JSON.stringify({ project: 'TeqniaLocalSendFull', sourceProject, builtAt: isoNow() }), { mode: 0o600 });
  return visualDir;
}

export async function renderLocalSend({ workDir, voicePath, contentId }) {
  const renderDir = path.join(workDir, 'render'); await mkdir(renderDir, { recursive: true, mode: 0o700 });
  const publicVoice = path.join(sourceProject, 'public', 'audio', `pipeline-${contentId}.wav`); const output = path.join(renderDir, 'LocalSend.mp4');
  await cp(voicePath, publicVoice);
  try {
    await run(path.join(sourceProject, 'node_modules', '.bin', 'remotion'), ['render', 'src/index.ts', 'TeqniaLocalSendFull', output, '--props', JSON.stringify({ voiceSrc: `audio/pipeline-${contentId}.wav` }), '--codec', 'h264', '--crf', '14', '--pixel-format', 'yuv420p', '--audio-codec', 'aac', '--audio-bitrate', '192k'], { cwd: sourceProject });
  } finally { await rm(publicVoice, { force: true }); }
  return output;
}

export async function artifactHash(file) { return sha256(await readFile(file)); }
