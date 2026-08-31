import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync, appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const defaultDataDir = path.join(os.homedir(), 'Library', 'Application Support', 'Useful Tech Manager');
const defaultArchiveDir = path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Codex', 'Tiktok Videos');

function parseEnvFile(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('='); return index < 0 ? [line, ''] : [line.slice(0, index), line.slice(index + 1)];
  }));
}
export function loadConfig(env = process.env) {
  const configFile = env.UTM_CONFIG_FILE || path.join(defaultDataDir, 'phase2.env'); const local = parseEnvFile(configFile);
  if (local.TELEGRAM_BOT_TOKEN && !local.TELEGRAM_SIGNING_SECRET && !env.TELEGRAM_SIGNING_SECRET) { mkdirSync(path.dirname(configFile), { recursive: true, mode: 0o700 }); appendFileSync(configFile, `TELEGRAM_SIGNING_SECRET=${randomBytes(32).toString('base64url')}\n`, { mode: 0o600 }); chmodSync(configFile, 0o600); local.TELEGRAM_SIGNING_SECRET = parseEnvFile(configFile).TELEGRAM_SIGNING_SECRET; }
  const all = { ...local, ...env };
  const tiktokEnv = all.TIKTOK_ENV || 'sandbox';
  if (!['sandbox', 'production'].includes(tiktokEnv)) throw new Error('TIKTOK_ENV must be sandbox or production');
  const productionEnabled = all.TIKTOK_PRODUCTION_ENABLED === 'true';
  return Object.freeze({
    configFile,
    dataDir: all.UTM_DATA_DIR || defaultDataDir,
    archiveDir: all.UTM_ARCHIVE_DIR || defaultArchiveDir,
    dashboardHost: all.UTM_DASHBOARD_HOST || '127.0.0.1',
    dashboardPort: Number(all.UTM_DASHBOARD_PORT || 8786),
    tiktokEnv,
    productionEnabled,
    telegram: { token: all.TELEGRAM_BOT_TOKEN || '', ownerUserId: all.TELEGRAM_OWNER_USER_ID || '', ownerChatId: all.TELEGRAM_OWNER_CHAT_ID || '', signingSecret: all.TELEGRAM_SIGNING_SECRET || '' },
  });
}
export function persistTelegramOwner(config, { userId, chatId }) {
  if (!/^-?\d+$/.test(String(userId)) || !/^-?\d+$/.test(String(chatId))) throw new Error('Invalid Telegram owner identity');
  if (config.telegram.ownerUserId || config.telegram.ownerChatId) throw new Error('Telegram owner is already configured');
  appendFileSync(config.configFile, `TELEGRAM_OWNER_USER_ID=${userId}\nTELEGRAM_OWNER_CHAT_ID=${chatId}\n`, { mode: 0o600 }); chmodSync(config.configFile, 0o600);
}
export function assertSandboxOnly(config) {
  if (config.tiktokEnv === 'production' || config.productionEnabled) throw new Error('Production TikTok is locked while the app is In Review');
}
