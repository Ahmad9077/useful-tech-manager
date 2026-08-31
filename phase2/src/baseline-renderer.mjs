import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] }); let error = '';
    child.stderr.on('data', (chunk) => { error += chunk; }); child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} failed: ${error.slice(0, 240)}`)));
  });
}

/**
 * Reuses the approved Remotion/FFmpeg LocalSend master only for the initial
 * Phase 2 integration test. New editorial jobs are expected to replace this
 * adapter with a composition-specific renderer, never a fabricated asset.
 */
export function approvedLocalSendTestRenderer({ sourceFile }) {
  return async (manifest) => {
    const outputDir = path.join(manifest.workDir, 'render'); await mkdir(outputDir, { recursive: true, mode: 0o700 });
    const output = path.join(outputDir, `LocalSend-r${manifest.revisionNumber}.mp4`);
    if (manifest.revisionNumber === 1) await copyFile(sourceFile, output);
    else await run('ffmpeg', ['-y', '-ss', '0', '-t', '35', '-i', sourceFile, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', output]);
    return { path: output, settings: { title: manifest.script.caption, hashtags: manifest.script.hashtags, allowComment: false, allowDuet: false, allowStitch: false, brandedContent: false, yourBrand: false, durationSeconds: manifest.revisionNumber === 1 ? 50 : 35, privacy: 'SELF_ONLY' } };
  };
}
