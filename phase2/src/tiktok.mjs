import { assertSandboxOnly } from './config.mjs';
import { stat, open } from 'node:fs/promises';

export class TikTokAdapter {
  constructor({ store, config, client = null }) { this.store = store; this.config = config; this.client = client; assertSandboxOnly(config); }
  async publishApproved(contentId, revisionNumber) {
    if (!this.client) throw new Error('TikTok Sandbox credentials and authorized token are not configured');
    const claimed = this.store.claimPublishIntent(contentId, revisionNumber, 'sandbox');
    // Creator Info must be current immediately before initialization. The client owns official endpoint calls only.
    const creator = await this.client.creatorInfo(); if (!creator?.canPost) throw new Error('TikTok creator is not currently eligible to post');
    const latest = this.store.assertPublishable(contentId, revisionNumber, 'sandbox');
    const post = await this.client.directPost({ artifactPath: latest.revision.artifact_path, settings: latest.revision.settings, idempotencyKey: latest.intent.idempotency_key, privacy: 'SELF_ONLY' });
    this.store.db.prepare("UPDATE publish_intents SET status='POLLING',remote_publish_id=?,updated_at=? WHERE id=?").run(post.publishId, new Date().toISOString(), claimed.intent.id);
    return post;
  }
}

/** Sandbox-only official Content Posting API client. The token provider is local and never serialised. */
export class OfficialTikTokSandboxClient {
  constructor({ accessToken, fetcher = fetch }) { this.accessToken = accessToken; this.fetcher = fetcher; this.base = 'https://open.tiktokapis.com'; }
  async request(path, method = 'POST', body = {}) {
    const token = await this.accessToken(); if (!token) throw new Error('TikTok Sandbox authorization is required');
    const response = await this.fetcher(`${this.base}${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=UTF-8' }, body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25_000) });
    const payload = await response.json().catch(() => ({})); if (!response.ok || (payload.error && payload.error.code !== 'ok')) throw new Error(`TikTok Sandbox request failed (${payload.error?.code || response.status})`); return payload.data || {};
  }
  async creatorInfo() { const data = await this.request('/v2/post/publish/creator_info/query/'); return { canPost: Array.isArray(data.privacy_level_options) && data.privacy_level_options.includes('SELF_ONLY'), raw: data }; }
  async directPost({ artifactPath, settings, idempotencyKey, privacy }) {
    const file = await stat(artifactPath); const creator = await this.request('/v2/post/publish/creator_info/query/'); if (!Array.isArray(creator.privacy_level_options) || !creator.privacy_level_options.includes(privacy)) throw new Error('TikTok Sandbox does not currently allow SELF_ONLY for this creator');
    const duration = Number(settings.durationSeconds || 0); if (creator.max_video_post_duration_sec && duration > creator.max_video_post_duration_sec) throw new Error('Video exceeds TikTok creator duration limit');
    const chunkSize = Math.min(file.size, 10 * 1024 * 1024); const init = await this.request('/v2/post/publish/video/init/', 'POST', { post_info: { title: String(settings.title || '').slice(0, 2200), privacy_level: privacy, disable_comment: !settings.allowComment, disable_duet: !settings.allowDuet, disable_stitch: !settings.allowStitch, brand_content_toggle: Boolean(settings.brandedContent), brand_organic_toggle: Boolean(settings.yourBrand) }, source_info: { source: 'FILE_UPLOAD', video_size: file.size, chunk_size: chunkSize, total_chunk_count: Math.ceil(file.size / chunkSize) } });
    if (!init.upload_url || !init.publish_id) throw new Error('TikTok Sandbox did not initialise Direct Post'); const handle = await open(artifactPath, 'r');
    try { for (let start = 0; start < file.size; start += chunkSize) { const end = Math.min(file.size, start + chunkSize); const buffer = Buffer.alloc(end - start); await handle.read(buffer, 0, buffer.length, start); const response = await this.fetcher(init.upload_url, { method: 'PUT', headers: { 'content-type': 'video/mp4', 'content-length': String(buffer.length), 'content-range': `bytes ${start}-${end - 1}/${file.size}`, 'idempotency-key': idempotencyKey }, body: buffer, signal: AbortSignal.timeout(60_000) }); if (![201, 206].includes(response.status)) throw new Error(`TikTok Sandbox upload failed (${response.status})`); } } finally { await handle.close(); }
    return { publishId: init.publish_id };
  }
  async status(publishId) { return this.request('/v2/post/publish/status/fetch/', 'POST', { publish_id: publishId }); }
}
