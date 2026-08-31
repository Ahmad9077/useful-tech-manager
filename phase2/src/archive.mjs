import { mkdir, readdir, copyFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { assertWithin, safeTopicName } from './util.mjs';
import { inspectMp4 } from './qc.mjs';

async function fileHash(file) { return new Promise((resolve, reject) => { const hash = createHash('sha256'); const input = createReadStream(file); input.on('data', (chunk) => hash.update(chunk)); input.on('error', reject); input.on('end', () => resolve(hash.digest('hex'))); }); }
export async function archiveApproved({ store, contentId, revisionNumber, archiveRoot, approvedWorkRoot }) {
  const { item, revision } = store.assertPublishable(contentId, revisionNumber, 'sandbox'); if (!revision.artifact_path || !revision.artifact_sha256 || !revision.qc_pass) throw new Error('Approved revision lacks a verified artifact');
  if (!approvedWorkRoot) throw new Error('An approved working-media root is required for archiving');
  const root = path.resolve(archiveRoot); const workRoot = path.resolve(approvedWorkRoot); await mkdir(root, { recursive: true, mode: 0o700 }); await assertWithin(workRoot, revision.artifact_path);
  const topic = safeTopicName(item.topic); const folder = path.join(root, topic); const finalPath = path.join(folder, `${topic}.mp4`); const existing = store.db.prepare('SELECT * FROM archive_records WHERE content_id=?').get(contentId);
  if (existing && existing.revision_number !== revisionNumber) throw new Error('A new approval must explicitly replace an existing archive record');
  await mkdir(folder, { recursive: true, mode: 0o700 }); const entries = await readdir(folder); if (entries.length && !(existing && entries.length === 1 && entries[0] === `${topic}.mp4`)) throw new Error('Archive topic folder is not empty');
  await copyFile(revision.artifact_path, finalPath); await chmod(finalPath, 0o600); const [hash, qc] = await Promise.all([fileHash(finalPath), inspectMp4(finalPath)]); if (hash !== revision.artifact_sha256 || !qc.pass) throw new Error('Archived file verification failed');
  const now = new Date().toISOString(); store.db.prepare('INSERT OR REPLACE INTO archive_records VALUES(?,?,?,?,?)').run(contentId, revisionNumber, finalPath, hash, now); store.transition(contentId, 'ARCHIVED', 'archive'); return finalPath;
}
