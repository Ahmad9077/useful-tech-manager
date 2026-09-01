import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { keychainSecret } from './secrets.mjs';

// This is the approved Useful Tech voice profile. Do not silently downgrade it.
export const WALID_PRODUCTION_PROFILE = Object.freeze({
  provider: 'Cartesia', voice: 'Walid', model: 'sonic-3.6', apiVersion: '2026-08-14',
  language: 'ar', accent: 'khaleeji', speed: 0.98, sampleRate: 44_100,
});

function parseSseResult(body) {
  const decoder = new TextDecoder();
  const chunks = []; const timestamps = [];
  let pending = '';
  return (async () => {
    for await (const fragment of body) {
      pending += decoder.decode(fragment, { stream: true });
      const events = pending.split(/\r?\n\r?\n/); pending = events.pop() || '';
      for (const event of events) {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
        if (!data || data === '[DONE]') continue;
        let message;
        try { message = JSON.parse(data); } catch { continue; }
        if (message.error || message.type === 'error') throw new Error('Cartesia TTS rejected the production request');
        const encoded = message.data || message.audio || message.chunk;
        if (typeof encoded === 'string') chunks.push(Buffer.from(encoded, 'base64'));
        const wordTimestamps = message.word_timestamps || message.timestamps?.word_timestamps || [];
        // Cartesia SSE returns parallel arrays: { words: [], start: [], end: [] }.
        // Keep object-array support as a compatibility guard for older responses.
        if (wordTimestamps && Array.isArray(wordTimestamps.words) && Array.isArray(wordTimestamps.start) && Array.isArray(wordTimestamps.end)) {
          for (let index = 0; index < wordTimestamps.words.length; index += 1) {
            const text = String(wordTimestamps.words[index] ?? '').trim(); const start = Number(wordTimestamps.start[index]); const end = Number(wordTimestamps.end[index]);
            if (text && Number.isFinite(start) && Number.isFinite(end) && end >= start) timestamps.push({ text, start, end });
          }
        } else if (Array.isArray(wordTimestamps)) {
          for (const word of wordTimestamps) {
            const start = Number(word.start ?? word.start_time ?? word.offset);
            const end = Number(word.end ?? word.end_time ?? word.offset_end);
            const text = String(word.word ?? word.text ?? '').trim();
            if (text && Number.isFinite(start) && Number.isFinite(end) && end >= start) timestamps.push({ text, start, end });
          }
        }
      }
    }
    const pcm = Buffer.concat(chunks);
    if (pcm.length < 2 || pcm.length % 2) throw new Error('Cartesia returned invalid production PCM');
    return { pcm, timestamps: timestamps.sort((a, b) => a.start - b.start || a.end - b.end) };
  })();
}

export async function synthesizeWalidWithTimestamps({ config, text }) {
  if (!config.cartesiaVoiceId || !text?.trim()) throw new Error('Cartesia Walid configuration or speech text is missing');
  // Wi-Fi is a fixed Useful Tech pronunciation requirement. Do not allow the
  // renderer to silently fall back to a letter-by-letter or Arabic-normalized
  // reading when this term is present in a production narration.
  if (/\bWi-Fi\b/.test(text) && !config.cartesiaPronunciationDictId) {
    throw new Error('CARTESIA_WIFI_PRONUNCIATION_DICTIONARY_REQUIRED');
  }
  const apiKey = keychainSecret(config.cartesiaKeychainService, config.cartesiaKeychainAccount);
  const response = await fetch('https://api.cartesia.ai/tts/sse', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Cartesia-Version': WALID_PRODUCTION_PROFILE.apiVersion, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model_id: WALID_PRODUCTION_PROFILE.model,
      transcript: text,
      voice: config.cartesiaVoiceId,
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: WALID_PRODUCTION_PROFILE.sampleRate },
      language: WALID_PRODUCTION_PROFILE.language,
      accent: WALID_PRODUCTION_PROFILE.accent,
      ...(config.cartesiaPronunciationDictId ? { pronunciation_dict_id: config.cartesiaPronunciationDictId } : {}),
      normalization: 'auto', add_timestamps: true, use_normalized_timestamps: true, context_id: randomUUID(),
      generation_config: { volume: 1, speed: WALID_PRODUCTION_PROFILE.speed },
    }),
  });
  if (!response.ok || !response.body) throw new Error(`Cartesia production TTS unavailable (${response.status})`);
  return parseSseResult(response.body);
}
export async function synthesizeWalidPcm({ config, text }) { return (await synthesizeWalidWithTimestamps({ config, text })).pcm; }
export async function writeTtsSample({ config, workspace, text }) { const pcm = await synthesizeWalidPcm({ config, text }); await mkdir(workspace, { recursive: true, mode: 0o700 }); const file = path.join(workspace, 'walid-sample.pcm'); await writeFile(file, pcm, { mode: 0o600 }); await chmod(file, 0o600); return { file, bytes: pcm.length }; }
