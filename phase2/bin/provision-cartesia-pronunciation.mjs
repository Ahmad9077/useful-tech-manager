#!/usr/bin/env node
import { appendFileSync, chmodSync } from 'node:fs';
import { loadConfig } from '../src/config.mjs';
import { keychainSecret } from '../src/secrets.mjs';

// Creates exactly one private Cartesia dictionary for the fixed Useful Tech
// pronunciation of Wi-Fi. The key and returned private dictionary id are never
// written to stdout or source control.
const config = loadConfig();
if (config.cartesiaPronunciationDictId) {
  process.stdout.write('Cartesia pronunciation dictionary already configured.\n');
  process.exit(0);
}
const apiKey = keychainSecret(config.cartesiaKeychainService, config.cartesiaKeychainAccount);
const response = await fetch('https://api.cartesia.ai/pronunciation-dicts/', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${apiKey}`,
    'Cartesia-Version': '2026-08-14',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    name: 'useful-tech-arabic-pronunciation',
    description: 'Private Useful Tech Arabic pronunciation controls.',
    access: 'private',
    items: [{ text: 'Wi-Fi', pronunciation: 'وَايْ فَايْ' }],
  }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`Cartesia pronunciation dictionary setup failed (${response.status})`);
const data = await response.json();
if (!data?.id || typeof data.id !== 'string') throw new Error('Cartesia did not return a pronunciation dictionary id');
appendFileSync(config.configFile, `CARTESIA_PRONUNCIATION_DICT_ID=${data.id}\n`, { mode: 0o600 });
chmodSync(config.configFile, 0o600);
process.stdout.write('Cartesia Wi-Fi pronunciation dictionary configured.\n');
