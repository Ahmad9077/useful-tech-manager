import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { sha256, json } from './util.mjs';
import { inspectMp4 } from './qc.mjs';

export class VideoProductionAdapter {
  constructor({ store, workingRoot, renderer = null }) { this.store = store; this.workingRoot = path.resolve(workingRoot); this.renderer = renderer; }
  async prepare({ contentId, revisionNumber, script, hooks, sources }) {
    const item = this.store.getContent(contentId); if (!item || item.current_revision !== revisionNumber) throw new Error('Production must use the current revision');
    const dir = path.join(this.workingRoot, contentId, `r${revisionNumber}`); await mkdir(dir, { recursive: true, mode: 0o700 }); const manifest = { contentId, revisionNumber, topic: item.topic, script, hooks, sources, workDir: dir, visualSystem: 'teqnia-tech-shorts-v2', createdAt: new Date().toISOString() }; await writeFile(path.join(dir, 'manifest.json'), `${json(manifest)}\n`, { mode: 0o600 }); await chmod(dir, 0o700); return { dir, manifest };
  }
  async render({ contentId, revisionNumber, manifest }) {
    if (!this.renderer) throw new Error('No approved local renderer is configured; a content candidate cannot be fabricated without narration and verified visuals');
    const output = await this.renderer(manifest); const qc = await inspectMp4(output.path); if (!qc.pass) throw new Error('Rendered MP4 failed mandatory QC'); const artifactSha256 = sha256(await (await import('node:fs/promises')).readFile(output.path)); this.store.setRevisionArtifact({ contentId, revisionNumber, artifactPath: output.path, artifactSha256, settings: output.settings || {}, qc }); return { ...output, qc, artifactSha256 };
  }
}
