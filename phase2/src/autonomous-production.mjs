import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeWalidPcm, WALID_PRODUCTION_PROFILE } from './tts.mjs';
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
    path.join(sourceProject, 'src', 'icons', 'IconFamilyV4.tsx'),
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
  const narration = `إِذَا كَامِيرَة المَاك مَو بِالمُسْتَوَى، لَا تَشْتَرِي Webcam قَبْل مَا تُجَرِّب هالحَرْكَة.\n\nإِذَا عِنْدَكَ iPhone وَMac، تِقْدَر تِخَلِّي كَامِيرَة iPhone هِي Webcam لِلمَاك بِمِيزَة Continuity Camera.\n\nثَبِّت iPhone قَرِيب مِن Mac، وَخَلِّه مَقْفُول وَالكَامِيرَة الخَلْفِيَّة بَاتِّجَاهَك. بَعْدَهَا اِفْتَح FaceTime، أَو أَيّ تَطْبِيق يَدْعَم الكَامِيرَا، وَاخْتَر iPhone مِن إِعْدَادَات الفِيدْيُو.\n\nتِشْتَغِل لَا سِلْكِيًّا، أَو بِسِلْك USB إِذَا تِبْغَى تِشْحَن iPhone.\n\nوَقَبْل تَبْدَا: لَازِم iPhone XR أَو أَحْدَث مَع iOS 16، وَMac يَدْعَم macOS Ventura. وَالجِهَازَيْن عَلَى نَفْس Apple Account، مَع Wi-Fi وَBluetooth شَغَّالِينَ.\n\nاِحْفَظ اِسْم المِيزَة: Continuity Camera.`;
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

export async function generateWalidVoice({ config, workDir, narration }) {
  const voiceDir = path.join(workDir, 'voice'); await mkdir(voiceDir, { recursive: true, mode: 0o700 });
  const pcmPath = path.join(voiceDir, 'walid-production.pcm'); const wavPath = path.join(voiceDir, 'walid-production.wav');
  await writeFile(pcmPath, await synthesizeWalidPcm({ config, text: narration }), { mode: 0o600 });
  await run('ffmpeg', ['-y', '-f', 's16le', '-ar', String(WALID_PRODUCTION_PROFILE.sampleRate), '-ac', '1', '-i', pcmPath, '-c:a', 'pcm_s16le', wavPath]);
  await writeFile(path.join(voiceDir, 'voice-production.json'), JSON.stringify(WALID_PRODUCTION_PROFILE, null, 2), { mode: 0o600 });
  return wavPath;
}

export async function buildVisualWorkspace({ workDir }) {
  const visualDir = path.join(workDir, 'visuals'); await mkdir(visualDir, { recursive: true, mode: 0o700 });
  const reference = await loadCanonicalQualityReference();
  await writeFile(path.join(visualDir, 'visual-system.json'), JSON.stringify({ ...reference, sourceProject, builtAt: isoNow() }, null, 2), { mode: 0o600 });
  return visualDir;
}

export async function renderCanonicalIphoneWebcam({ workDir, voicePath, contentId }) {
  const reference = await loadCanonicalQualityReference();
  const renderDir = path.join(workDir, 'render'); await mkdir(renderDir, { recursive: true, mode: 0o700 });
  const publicVoice = path.join(sourceProject, 'public', 'audio', `pipeline-${contentId}.wav`);
  const intermediate = path.join(renderDir, 'iPhone-Webcam-intermediate.mp4');
  const output = path.join(renderDir, 'iPhone-Webcam.mp4');
  await cp(voicePath, publicVoice);
  try {
    await run(path.join(sourceProject, 'node_modules', '.bin', 'remotion'), ['render', 'src/index.ts', reference.composition, intermediate, '--props', JSON.stringify({ voiceSrc: `audio/pipeline-${contentId}.wav` }), '--codec', 'h264', '--crf', '14', '--pixel-format', 'yuv420p', '--audio-codec', 'aac', '--audio-bitrate', '192k'], { cwd: sourceProject });
    await run('ffmpeg', ['-y', '-i', intermediate, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-af', 'loudnorm=I=-14:TP=-1.5:LRA=7', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output]);
  } finally { await rm(publicVoice, { force: true }); await rm(intermediate, { force: true }); }
  return output;
}

export async function artifactHash(file) { return sha256(await readFile(file)); }
