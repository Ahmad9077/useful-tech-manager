import { spawn } from 'node:child_process';
import { mkdir, stat, readFile, access } from 'node:fs/promises';
import path from 'node:path';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let error = '';
    process.stdout.on('data', (d) => { output += d; }); process.stderr.on('data', (d) => { error += d; }); process.on('error', reject);
    process.on('close', (code) => code === 0 ? resolve({ output, error }) : reject(new Error(`${command} exited ${code}: ${error.slice(0, 500)}`)));
  });
}
function fpsFrom(rate) { const [num, den] = String(rate || '0/1').split('/').map(Number); return den ? num / den : 0; }
export async function inspectMp4(file) {
  const fileStat = await stat(file); if (!fileStat.isFile() || fileStat.size < 1024) throw new Error('Video artifact is missing or too small');
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,profile,width,height,sample_aspect_ratio,display_aspect_ratio,r_frame_rate,pix_fmt,sample_rate,channels', '-of', 'json', file]);
  const metadata = JSON.parse(raw.output); const video = metadata.streams.find((stream) => stream.codec_type === 'video'); const audio = metadata.streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(metadata.format.duration); const fps = fpsFrom(video?.r_frame_rate);
  const dar = video?.display_aspect_ratio || `${video?.width || 0}:${video?.height || 0}`;
  const pass = Boolean(video && audio && video.codec_name === 'h264' && audio.codec_name === 'aac' && video.width === 1080 && video.height === 1920 && dar === '9:16' && Math.abs(fps - 30) < 0.05 && duration >= 25 && duration <= 55 && video.pix_fmt === 'yuv420p');
  const masterProfilePass = pass && Number(audio.sample_rate) === 48_000 && Number(audio.channels) === 2;
  return { pass, masterProfilePass, duration, dar, video: video && { codec: video.codec_name, profile: video.profile, width: video.width, height: video.height, fps, pixelFormat: video.pix_fmt }, audio: audio && { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: Number(audio.channels) }, bytes: fileStat.size };
}

export async function visualQc(file, { framesDir, sceneTimes = [0, 1, 2, 7, 13, 20, 28, 35, 43] } = {}) {
  const technical = await inspectMp4(file); if (!technical.masterProfilePass) return { pass: false, technical, frames: [], reason: 'TECHNICAL_MASTER_INVALID' };
  const root = framesDir || path.join(path.dirname(file), 'qc-frames'); await mkdir(root, { recursive: true, mode: 0o700 });
  // H.264's reported container duration may extend a fraction beyond the last
  // decodable video PTS. Keep every sample safely inside the final frame.
  const finalSample = Math.max(0, technical.duration - 0.25);
  const times = [...new Set([...sceneTimes.filter((time) => time <= finalSample), finalSample])]; const frames = [];
  for (const [index, time] of times.entries()) {
    const frame = path.join(root, `frame-${String(index).padStart(2, '0')}-${String(time).replace('.', '_')}.jpg`);
    await run('ffmpeg', ['-y', '-ss', String(time), '-i', file, '-frames:v', '1', '-q:v', '2', frame]);
    const info = await stat(frame); if (info.size < 20_000) throw new Error(`VISUAL_QC_FRAME_TOO_SMALL:${path.basename(frame)}`);
    frames.push({ time, path: frame, bytes: info.size });
  }
  // Decode the whole master and reject material black/frozen output. A very short fade is allowed.
  await run('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'null', '-']);
  const black = await run('ffmpeg', ['-v', 'info', '-i', file, '-vf', 'blackdetect=d=0.8:pic_th=0.98:pix_th=0.10', '-an', '-f', 'null', '-']);
  const frozen = await run('ffmpeg', ['-v', 'info', '-i', file, '-vf', 'freezedetect=n=0.001:d=1.5', '-an', '-f', 'null', '-']);
  const blackEvents = (black.error.match(/black_start:/g) || []).length; const frozenEvents = (frozen.error.match(/freeze_start:/g) || []).length;
  return { pass: blackEvents === 0 && frozenEvents === 0, technical, frames, blackEvents, frozenEvents, reason: blackEvents || frozenEvents ? 'BLACK_OR_FROZEN_OUTPUT' : null };
}

function asWords(raw) { return Array.isArray(raw?.timestamps) ? raw.timestamps.filter((word) => Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end))) : []; }
export async function captionSyncQc({ cues, timestampsPath }) {
  const words = asWords(JSON.parse(await readFile(timestampsPath, 'utf8'))).sort((a, b) => Number(a.start) - Number(b.start));
  const issues = []; const list = Array.isArray(cues) ? cues : [];
  if (!words.length) issues.push('NO_FINAL_NARRATION_WORD_TIMESTAMPS');
  if (!list.length) issues.push('NO_CAPTION_CUES');
  let previousEnd = -1;
  for (const cue of list) {
    if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || cue.end <= cue.start) issues.push(`INVALID_CUE:${cue.id || 'unknown'}`);
    if (cue.start < previousEnd - 0.05) issues.push(`OVERLAPPING_CUE:${cue.id || 'unknown'}`);
    const sourceStart = words[cue.sourceWordStart]; const sourceEnd = words[cue.sourceWordEnd];
    if (!sourceStart || !sourceEnd) issues.push(`CUE_WORD_REFERENCE_MISSING:${cue.id || 'unknown'}`);
    else {
      if (Math.abs(Number(cue.start) - Math.max(0, Number(sourceStart.start) - 0.03)) > 0.08) issues.push(`EARLY_OR_LATE_CAPTION:${cue.id}`);
      // A cue may cut at the next cue's actual spoken start; it must never
      // persist materially after the final word it represents.
      if (Number(cue.end) + 0.12 < Number(sourceEnd.end) || Number(cue.end) > Number(sourceEnd.end) + 0.16) issues.push(`PERSISTENCE_MISMATCH:${cue.id}`);
    }
    previousEnd = cue.end;
  }
  const speechEnd = words.length ? Number(words.at(-1).end) : 0;
  if (list.length && Number(list.at(-1).end) > speechEnd + 0.4) issues.push('CAPTIONS_PERSIST_AFTER_SPEECH');
  return { pass: issues.length === 0, cueCount: list.length, wordCount: words.length, speechEnd, issues, source: 'final-cartesia-word-timestamps' };
}

const forbiddenBidiControls = /[\u202A-\u202E\u2066-\u2068]/;
export async function usefulTechDesignQc({ sourceProject, visualSystemPath, cues }) {
  const [composition, system] = await Promise.all([
    readFile(path.join(sourceProject, 'src', 'IphoneWebcam.tsx'), 'utf8'),
    readFile(path.join(sourceProject, 'src', 'design', 'UsefulTechSystem.tsx'), 'utf8'),
  ]);
  const manifest = JSON.parse(await readFile(visualSystemPath, 'utf8'));
  const issues = []; const mixed = (cues || []).filter((cue) => /[\u0600-\u06FF]/.test(`${cue.line1} ${cue.line2 || ''}`) && /[A-Za-z]/.test(`${cue.line1} ${cue.line2 || ''}`));
  if (!composition.includes('<BrandBug/>') || !system.includes("staticFile('brand/useful-tech-logo.png')")) issues.push('MISSING_CANONICAL_BRAND_BUG');
  if (composition.includes('@useful.tech.ar') || composition.includes('TikTok')) issues.push('BRAND_GROUPED_WITH_PLATFORM_UI');
  if (!system.includes('top:64') || !system.includes("left:'50%'")) issues.push('BRAND_SAFE_PLACEMENT_INVALID');
  if (!composition.includes('<ActiveConcept/>') || !system.includes('zIndex:70')) issues.push('ACTIVE_ICON_NOT_FOREGROUND');
  if (!composition.includes('<CaptionRail cues={captionCues}/>') || !system.includes('AudioSyncedCaption')) issues.push('AUDIO_SYNCED_CAPTIONS_NOT_USED');
  if (!system.includes('dir="rtl"') || !system.includes('<bdi') || !system.includes("unicodeBidi:'isolate'")) issues.push('RTL_BIDI_RENDERER_INVALID');
  if (forbiddenBidiControls.test(composition) || forbiddenBidiControls.test(system) || mixed.some((cue) => forbiddenBidiControls.test(`${cue.line1}${cue.line2 || ''}`))) issues.push('FORBIDDEN_BIDI_CONTROL_FOUND');
  if (!system.includes('DARK_NAVY') || !system.includes('LIGHT_IVORY') || !system.includes('TEAL') || !system.includes('background:theme.surface')) issues.push('ADAPTIVE_CAPTION_SURFACE_INVALID');
  if (!manifest.enforcement?.activeForegroundRequired || !manifest.enforcement?.audioSyncedCaptionsRequired || !manifest.enforcement?.trueRtlRequired || !manifest.enforcement?.canonicalBrandBugRequired || !manifest.enforcement?.adaptiveCaptionSurfaceRequired) issues.push('DESIGN_ENFORCEMENT_MANIFEST_INVALID');
  try { await access(path.join(sourceProject, 'public', 'brand', 'useful-tech-logo.png')); } catch { issues.push('CANONICAL_LOGO_ASSET_MISSING'); }
  return { pass: issues.length === 0, issues, mixedCaptionCount: mixed.length, foreground: !issues.includes('ACTIVE_ICON_NOT_FOREGROUND'), brand: !issues.some((issue) => issue.startsWith('MISSING_CANONICAL') || issue.startsWith('BRAND_') || issue === 'CANONICAL_LOGO_ASSET_MISSING'), rtl: !issues.some((issue) => issue.includes('RTL') || issue.includes('BIDI')), captionSurface: !issues.includes('ADAPTIVE_CAPTION_SURFACE_INVALID') };
}
