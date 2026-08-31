import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { backupDatabase, verifyDatabase } from '../src/backup.mjs';

const config = loadConfig(); const store = new Store(path.join(config.dataDir, 'useful-tech-manager.sqlite')); verifyDatabase(store); const backup = await backupDatabase(store, path.join(config.dataDir, 'backups')); store.close(); process.stdout.write(`${backup}\n`);
