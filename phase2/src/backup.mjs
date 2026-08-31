import { mkdir, readdir, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { isoNow } from './util.mjs';

export async function backupDatabase(store, backupDir, retain = 14) {
  await mkdir(backupDir, { recursive: true, mode: 0o700 }); const name = `useful-tech-manager-${isoNow().replace(/[:.]/g, '-')}.sqlite`; const target = path.join(backupDir, name);
  const escaped = target.replaceAll("'", "''"); store.db.exec(`VACUUM INTO '${escaped}'`); await chmod(target, 0o600);
  const backups = (await readdir(backupDir)).filter((file) => file.endsWith('.sqlite')).sort(); while (backups.length > retain) await rm(path.join(backupDir, backups.shift())); return target;
}
export function verifyDatabase(store) { const result = store.integrityCheck(); if (result.some((line) => line !== 'ok')) throw new Error(`SQLite integrity check failed: ${result.join('; ')}`); return result; }
