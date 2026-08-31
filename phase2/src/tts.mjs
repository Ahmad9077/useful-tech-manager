import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { keychainSecret } from './secrets.mjs';

const VERSION = '2026-08-14';
const MODEL = 'sonic-3.5-2026-05-04';
export async function synthesizeWalidPcm({ config, text }) {
  if (!config.cartesiaVoiceId || !text?.trim()) throw new Error('Cartesia Walid configuration or speech text is missing');
  const apiKey = keychainSecret(config.cartesiaKeychainService, config.cartesiaKeychainAccount); const contextId = randomUUID(); const chunks = [];
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://api.cartesia.ai/tts/websocket?cartesia_version=${VERSION}`, { headers: { 'X-Api-Key': apiKey } }); const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Cartesia TTS timed out')); }, 45_000);
    const fail = (error) => { clearTimeout(timeout); try { socket.close(); } catch {} reject(error instanceof Error ? error : new Error('Cartesia TTS failed')); };
    socket.once('error', fail); socket.on('open', () => socket.send(JSON.stringify({ model_id: MODEL, transcript: text, voice: config.cartesiaVoiceId, output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 48_000 }, language: 'ar', normalization: 'auto', context_id: contextId, continue: false, max_buffer_delay_ms: 120, add_timestamps: false })));
    socket.on('message', (raw) => { try { const message = JSON.parse(raw.toString()); if (message.context_id !== contextId) return; if (message.type === 'error' || message.error) return fail(new Error('Cartesia TTS rejected the request')); if (message.data) chunks.push(Buffer.from(message.data, 'base64')); if (message.done) { clearTimeout(timeout); socket.close(); const pcm = Buffer.concat(chunks); if (pcm.length < 2 || pcm.length % 2) return fail(new Error('Cartesia returned invalid PCM')); resolve(pcm); } } catch (error) { fail(error); } });
  });
}
export async function writeTtsSample({ config, workspace, text }) { const pcm = await synthesizeWalidPcm({ config, text }); await mkdir(workspace, { recursive: true, mode: 0o700 }); const file = path.join(workspace, 'walid-sample.pcm'); await writeFile(file, pcm, { mode: 0o600 }); await chmod(file, 0o600); return { file, bytes: pcm.length }; }
