import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const defaultDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Useful Tech Manager');
const defaultArchiveDir = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Codex', 'Tiktok Videos');

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('='); return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
}
export function loadConfig(env = process.env) {
  const local = parseEnvFile(env.UTM_CONFIG_FILE || path.join(defaultDataDir, 'phase2.env'));
  const all = { ...local, ...env };
  const tiktokEnv = all.TIKTOK_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(tiktokEnv)) throw new Error('TIKTOK_ENV must be sandbox or production');
  const productionEnabled = all.TIKTOK_PRODUCTION_ENABLED === 'true';
  return Object.freeze({
    dataDir: all.UTM_DATA_DIR || defaultDataDir,
    archiveDir: all.UTM_ARCHIVE_DIR || defaultArchiveDir,
    dashboardHost: all.UTM_DASHBOARD_HOST || '127.0.0.1',
    dashboardPort: Number(all.UTM_DASHBOARD_PORT || 8786),
    tiktokEnv,
    productionEnabled,
    telegram: { token: all.TELEGRAM_BOT_TOKEN || '', ownerUserId: all.TELEGRAM_OWNER_USER_ID || '', ownerChatId: all.TELEGRAM_OWNER_CHAT_ID || '' },
  });
}
export function assertSandboxOnly(config) {
  if (config.tiktokEnv === 'production' || config.productionEnabled) throw new Error('Production TikTok is locked while the app is In Review');
}
