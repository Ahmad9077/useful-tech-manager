import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
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
  const times = [...new Set([...sceneTimes.filter((time) => time < technical.duration), Math.max(0, technical.duration - 0.25)])]; const frames = [];
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
