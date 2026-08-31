import path from 'node:path';
import { Store } from '../src/store.mjs';
import { loadConfig, assertSandboxOnly } from '../src/config.mjs';
import { sandboxAccessTokenProvider } from '../src/sandbox-token.mjs';
import { OfficialTikTokSandboxClient } from '../src/tiktok.mjs';
import { addSnapshot } from '../src/analytics.mjs';
import { TelegramClient } from '../src/telegram.mjs';

const config = loadConfig(); assertSandboxOnly(config); const store = new Store(path.join(config.dataDir, 'useful-tech-manager.sqlite'));
try {
  const client = new OfficialTikTokSandboxClient({ accessToken: sandboxAccessTokenProvider(config) });
  const [profileResponse, videoResponse] = await Promise.all([
    client.request('/v2/user/info/?fields=open_id,follower_count,following_count,likes_count,video_count', 'GET'),
    client.request('/v2/video/list/?fields=id,like_count,comment_count,share_count,view_count,create_time', 'POST', { max_count: 20 }),
  ]);
  const profile = profileResponse.user || {}; const videos = Array.isArray(videoResponse.videos) ? videoResponse.videos : [];
  const total = videos.reduce((sum, video) => ({ views: sum.views + Number(video.view_count || 0), likes: sum.likes + Number(video.like_count || 0), shares: sum.shares + Number(video.share_count || 0), comments: sum.comments + Number(video.comment_count || 0) }), { views: 0, likes: 0, shares: 0, comments: 0 });
  addSnapshot(store, { views: total.views, likes: total.likes, shares: total.shares, comments: total.comments, followers: Number(profile.follower_count || 0), raw: { source: 'TikTok Sandbox official APIs', videoCount: videos.length } });
  const ready = store.listContent().filter((item) => item.state === 'READY_FOR_REVIEW').length;
  const text = `📊 Useful Tech — Daily Report\n\nFollowers: ${Number(profile.follower_count || 0)}\nRecent videos: ${videos.length}\nToday: ${total.views} views · ${total.likes} likes · ${total.shares} shares\n\nTomorrow: ${ready ? 'Video waiting for approval' : 'Research / producing'}`;
  await new TelegramClient(config.telegram.token).call('sendMessage', { chat_id: config.telegram.ownerChatId, text });
  console.log(`analytics=recorded videos=${videos.length} report=sent`);
} finally { store.close(); }
