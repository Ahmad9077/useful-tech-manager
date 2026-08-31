import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';

function run(command, args) { return new Promise((resolve, reject) => { const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let error = ''; process.stdout.on('data', (d) => { output += d; }); process.stderr.on('data', (d) => { error += d; }); process.on('error', reject); process.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`${command} exited ${code}: ${error.slice(0, 300)}`))); }); }
export async function inspectMp4(file) {
  const fileStat = await stat(file); if (!fileStat.isFile() || fileStat.size < 1024) throw new Error('Video artifact is missing or too small');
  const raw = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file]); const metadata = JSON.parse(raw); const video = metadata.streams.find((stream) => stream.codec_type === 'video'); const audio = metadata.streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(metadata.format.duration); const [num, den] = String(video?.r_frame_rate || '0/1').split('/').map(Number); const fps = den ? num / den : 0;
  return { pass: Boolean(video && audio && video.codec_name === 'h264' && audio.codec_name === 'aac' && video.width === 1080 && video.height === 1920 && duration >= 20 && duration <= 60 && fps > 29 && fps < 31), duration, video: video && { codec: video.codec_name, width: video.width, height: video.height, fps }, audio: audio?.codec_name, bytes: fileStat.size };
}
