import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeWalidWithTimestamps, WALID_PRODUCTION_PROFILE } from './tts.mjs';
import { sha256, isoNow } from './util.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const sourceProject = path.resolve(here, '../../../LocalSend-Style-Test-v2');
export const qualityReferencePath = path.resolve(here, '../quality-reference.json');

const iPhoneWebcamSources = [
  { url: 'https://support.apple.com/en-us/102546', title: 'Apple Support: Use your iPhone as a webcam on your Mac', claims: ['Continuity Camera can use iPhone as a webcam or microphone for a Mac', 'Requires iPhone XR or later with iOS 16 or later and a Mac with macOS Ventura or later', 'Devices use the same Apple Account with two-factor authentication and have Wi-Fi and Bluetooth enabled', 'It works wirelessly or through USB after trusting the Mac', 'The iPhone needs to be nearby, locked, stable, with rear cameras facing the user'] },
  { url: 'https://support.apple.com/en-us/102438', title: 'Apple Support: Continuity Camera system requirements', claims: ['Compatibility requirements are device and operating-system dependent'] },
];

export const CANONICAL_TOPIC = Object.freeze({
  key: 'iphone-webcam', topic: 'iPhone Webcam', category: 'iPhone utility', hookType: 'before-after',
  hook: 'قبل تشتري Webcam للماك… جرّب كاميرا iPhone اللي عندك.',
});

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
  child.stderr.on('data', (d) => { error += d; });
  child.on('error', reject);
  child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${error.slice(0, 500)}`)));
});

export async function loadCanonicalQualityReference() {
  const reference = JSON.parse(await readFile(qualityReferencePath, 'utf8'));
  const required = [
    path.join(sourceProject, 'src', 'Root.tsx'),
    path.join(sourceProject, 'src', 'IphoneWebcam.tsx'),
    path.join(sourceProject, 'src', 'design', 'UsefulTechSystem.tsx'),
    path.join(sourceProject, 'src', 'icons', 'IconFamilyV4.tsx'),
    path.join(sourceProject, 'public', 'brand', 'useful-tech-logo.png'),
    path.join(sourceProject, 'public', 'audio', 'music-full.wav'),
    path.join(sourceProject, 'public', 'audio', 'sfx-success.wav'),
  ];
  const missing = required.filter((file) => !existsSync(file));
  if (missing.length || reference.composition !== 'TeqniaIphoneWebcam') throw new Error('QUALITY_REFERENCE_UNAVAILABLE');
  return reference;
}

export async function researchIphoneWebcam({ store, contentId }) {
  for (const source of iPhoneWebcamSources) {
    const response = await fetch(source.url, { headers: { 'user-agent': 'UsefulTechManager/0.3 research' }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`RESEARCH_SOURCE_UNAVAILABLE:${source.title}`);
    const document = await response.text();
    if (document.length < 500) throw new Error(`RESEARCH_SOURCE_INVALID:${source.title}`);
    store.addSource(contentId, { ...source, retrievedAt: isoNow() });
  }
  return iPhoneWebcamSources;
}

export async function writeVerifiedIphoneWebcamScript({ store, contentId, revisionNumber, sources }) {
  // Tashkeel below is intentionally narration-only. Captions use normal Arabic and Latin product names.
  const narration = `إِذَا كَامِيرَة المَاك مَو بِالمُسْتَوَى، لَا تَشْتَرِي Webcam قَبْل مَا تُجَرِّب هالحَرْكَة.\n\nإِذَا عِنْدَكَ iPhone وَMac، تِقْدَر تِخَلِّي كَامِيرَة iPhone هِي Webcam لِلمَاك بِمِيزَة Continuity Camera.\n\nثَبِّت iPhone قَرِيب مِن Mac، وَخَلِّه مَقْفُول وَالكَامِيرَة الخَلْفِيَّة بَاتِّجَاهَك. بَعْدَهَا اِفْتَح FaceTime، أَو أَيّ تَطْبِيق يَدْعَم الكَامِيرَا، وَاخْتَر iPhone مِن إِعْدَادَات الفِيدْيُو.\n\nتِشْتَغِل لَا سِلْكِيًّا، أَو بِسِلْك USB إِذَا تِبْغَى تِشْحَن iPhone.\n\nوَقَبْل تَبْدَا: لَازِم iPhone XR أَو أَحْدَث مَع iOS 16، وَMac يَدْعَم macOS Ventura. وَالجِهَازَيْن عَلَى نَفْس Apple Account، مَع وَايْ فَايْ وَBluetooth شَغَّالِينَ.\n\nاِحْفَظ اِسْم المِيزَة: Continuity Camera.`;
  const script = {
    narration,
    caption: 'حوّل iPhone إلى Webcam للـ Mac',
    hashtags: ['#تقنية_تفيدك', '#iPhone', '#Mac'],
    hook: CANONICAL_TOPIC.hook,
    ttsLanguage: 'ar-SA', voiceProfile: WALID_PRODUCTION_PROFILE,
  };
  store.setRevisionPlan({ contentId, revisionNumber, script, sources, actor: 'content-writer' });
  store.db.prepare('UPDATE content_items SET topic=?,category=?,selected_hook=?,hook_type=?,updated_at=? WHERE content_id=?').run(CANONICAL_TOPIC.topic, CANONICAL_TOPIC.category, script.hook, CANONICAL_TOPIC.hookType, isoNow(), contentId);
  return script;
}

// Caption text intentionally covers only the viewer-facing beats. Every cue is
// anchored to the final Cartesia word timings, not an estimated word count.
// This prevents a card from remaining on-screen after the narration has moved
// to the next instruction.
const CAPTION_PLAN = Object.freeze([
  { line1: 'كاميرا Mac مو بالمستوى؟', line2: 'لا تشتري Webcam قبل ما تجرب', start: ['كَامِيرَة', 'المَاك'], end: ['هالحَرْكَة'], theme: 'DARK_NAVY' },
  { line1: 'خلّ كاميرا iPhone تصير Webcam للـ Mac', line2: 'بميزة Continuity Camera', start: ['تِقْدَر', 'تِخَلِّي'], end: ['Camera'], theme: 'DARK_NAVY' },
  { line1: 'اختر iPhone من إعدادات الفيديو', start: ['وَاخْتَر', 'iPhone'], end: ['الفِيدْيُو'], theme: 'DARK_NAVY' },
  { line1: 'تشتغل لاسلكياً أو بسلك USB', line2: 'إذا تبغى تشحن iPhone', start: ['تِشْتَغِل', 'لَا'], end: ['iPhone'], theme: 'DARK_NAVY' },
  { line1: 'iPhone XR أو أحدث مع iOS 16', line2: 'و Mac يدعم macOS Ventura', start: ['لَازِم', 'iPhone'], end: ['Ventura'], theme: 'DARK_NAVY' },
  { line1: 'نفس Apple Account', line2: 'و Wi-Fi و Bluetooth شغالين', start: ['وَالجِهَازَيْن', 'عَلَى'], end: ['شَغَّالِينَ'], theme: 'DARK_NAVY' },
  { line1: 'احفظ الاسم', line2: 'Continuity Camera', start: ['اِحْفَظ', 'اِسْم'], end: ['Camera'], theme: 'DARK_NAVY' },
]);

const normalizeTimestampToken = (value) => String(value || '')
  .normalize('NFD')
  .replace(/\p{M}/gu, '')
  .replace(/[^\p{L}\p{N}]+/gu, '')
  .replace(/[أإآ]/g, 'ا')
  .replace(/ى/g, 'ي')
  .toLowerCase();

function findPhrase(words, phrase, fromIndex) {
  const targets = phrase.map(normalizeTimestampToken).filter(Boolean);
  for (let index = fromIndex; index <= words.length - targets.length; index += 1) {
    if (targets.every((target, offset) => normalizeTimestampToken(words[index + offset]?.text) === target)) return index + targets.length - 1;
  }
  return -1;
}

function buildAudioSyncedCaptionCues(timestamps) {
  const words = timestamps.filter((word) => Number.isFinite(word.start) && Number.isFinite(word.end) && word.end >= word.start).sort((a, b) => a.start - b.start);
  if (!words.length) throw new Error('CARTESIA_WORD_TIMESTAMPS_MISSING');
  const cues = []; let cursor = 0;
  for (let index = 0; index < CAPTION_PLAN.length; index += 1) {
    const plan = CAPTION_PLAN[index];
    const startIndex = findPhrase(words, plan.start, cursor);
    if (startIndex < 0) throw new Error(`CAPTION_START_ANCHOR_NOT_FOUND:${index + 1}`);
    const endIndex = findPhrase(words, plan.end, startIndex);
    if (endIndex < startIndex) throw new Error(`CAPTION_END_ANCHOR_NOT_FOUND:${index + 1}`);
    const start = Math.max(0, words[startIndex].start - 0.03);
    const end = Math.max(start + 0.45, words[endIndex].end + 0.14);
    cues.push({ id: `cue-${index + 1}`, start, end, line1: plan.line1, line2: plan.line2, theme: plan.theme, sourceWordStart: startIndex, sourceWordEnd: endIndex });
    cursor = endIndex + 1;
  }
  // Never show two caption cards at once. If Cartesia's adjacent word timing
  // overlaps slightly, the new spoken phrase wins at its actual start.
  for (let index = 0; index < cues.length - 1; index += 1) cues[index].end = Math.min(cues[index].end, Math.max(cues[index].start + 0.45, cues[index + 1].start - 0.02));
  if (cues.length < 5) throw new Error('CARTESIA_WORD_TIMESTAMPS_INSUFFICIENT');
  return cues;
}

export async function generateWalidVoice({ config, workDir, narration }) {
  const voiceDir = path.join(workDir, 'voice'); await mkdir(voiceDir, { recursive: true, mode: 0o700 });
  const pcmPath = path.join(voiceDir, 'walid-production.pcm'); const wavPath = path.join(voiceDir, 'walid-production.wav');
  const synthesis = await synthesizeWalidWithTimestamps({ config, text: narration });
  const captionCues = buildAudioSyncedCaptionCues(synthesis.timestamps);
  const timestampsPath = path.join(voiceDir, 'caption-word-timestamps.json'); const cuesPath = path.join(voiceDir, 'caption-cues.json');
  await writeFile(pcmPath, synthesis.pcm, { mode: 0o600 });
  await run('ffmpeg', ['-y', '-f', 's16le', '-ar', String(WALID_PRODUCTION_PROFILE.sampleRate), '-ac', '1', '-i', pcmPath, '-c:a', 'pcm_s16le', wavPath]);
  await writeFile(path.join(voiceDir, 'voice-production.json'), JSON.stringify(WALID_PRODUCTION_PROFILE, null, 2), { mode: 0o600 });
  await writeFile(timestampsPath, JSON.stringify({ provider: 'Cartesia', voice: 'Walid', timestamps: synthesis.timestamps }, null, 2), { mode: 0o600 });
  await writeFile(cuesPath, JSON.stringify({ version: 'audio-synced-v1', cues: captionCues }, null, 2), { mode: 0o600 });
  return { voicePath: wavPath, timestampsPath, cuesPath, captionCues };
}

export async function buildVisualWorkspace({ workDir }) {
  const visualDir = path.join(workDir, 'visuals'); await mkdir(visualDir, { recursive: true, mode: 0o700 });
  const reference = await loadCanonicalQualityReference();
  await writeFile(path.join(visualDir, 'visual-system.json'), JSON.stringify({ ...reference, sourceProject, builtAt: isoNow(), enforcement: { layers: ['background', 'support', 'device', 'active-foreground', 'captions', 'brand'], activeForegroundRequired: true, audioSyncedCaptionsRequired: true, trueRtlRequired: true, canonicalBrandBugRequired: true, adaptiveCaptionSurfaceRequired: true } }, null, 2), { mode: 0o600 });
  return visualDir;
}

export async function renderCanonicalIphoneWebcam({ workDir, voicePath, contentId, captionCues }) {
  const reference = await loadCanonicalQualityReference();
  const renderDir = path.join(workDir, 'render'); await mkdir(renderDir, { recursive: true, mode: 0o700 });
  const publicVoice = path.join(sourceProject, 'public', 'audio', `pipeline-${contentId}.wav`);
  const intermediate = path.join(renderDir, 'iPhone-Webcam-intermediate.mp4');
  const output = path.join(renderDir, 'iPhone-Webcam.mp4');
  await cp(voicePath, publicVoice);
  try {
    await run(path.join(sourceProject, 'node_modules', '.bin', 'remotion'), ['render', 'src/index.ts', reference.composition, intermediate, '--props', JSON.stringify({ voiceSrc: `audio/pipeline-${contentId}.wav`, captionCues }), '--codec', 'h264', '--crf', '14', '--pixel-format', 'yuv420p', '--audio-codec', 'aac', '--audio-bitrate', '192k'], { cwd: sourceProject });
    await run('ffmpeg', ['-y', '-i', intermediate, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=7', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output]);
  } finally { await rm(publicVoice, { force: true }); await rm(intermediate, { force: true }); }
  return output;
}

export async function artifactHash(file) { return sha256(await readFile(file)); }
