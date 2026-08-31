import { mkdir, writeFile, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const target = path.join(os.homedir(), 'Library', 'Application Support', 'Useful Tech Manager', 'phase2.env'); const rl = createInterface({ input: stdin, output: stdout });
const token = await rl.question('Telegram bot token (stored locally only): '); const userId = await rl.question('Authorized Telegram user ID: '); const chatId = await rl.question('Authorized Telegram chat ID: '); rl.close();
if (!token || !userId || !chatId) throw new Error('All three Telegram values are required'); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 }); await writeFile(target, `TIKTOK_ENV=sandbox\nTIKTOK_PRODUCTION_ENABLED=false\nTELEGRAM_BOT_TOKEN=${token}\nTELEGRAM_OWNER_USER_ID=${userId}\nTELEGRAM_OWNER_CHAT_ID=${chatId}\n`, { mode: 0o600 }); await chmod(target, 0o600); if ((await stat(target)).mode & 0o077) throw new Error('Secret config permissions are too open'); process.stdout.write(`Saved protected local configuration: ${target}\n`);
