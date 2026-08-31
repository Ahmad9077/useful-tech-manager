import { isoNow } from './util.mjs';

export const DEFAULT_SOURCES = Object.freeze([
  { name: 'GitHub Trending', url: 'https://github.com/trending', type: 'trend-signal' },
  { name: 'Apple Support', url: 'https://support.apple.com/', type: 'official' },
  { name: 'Google Chrome Releases', url: 'https://chromereleases.googleblog.com/', type: 'official' },
]);
export function scoreIdea(candidate, history = []) {
  const novelty = history.some((item) => String(item.topic).toLowerCase() === String(candidate.topic).toLowerCase()) ? 0 : Number(candidate.novelty ?? 8);
  const weights = { usefulness: 0.24, freshness: 0.13, demonstrability: 0.17, gulfRelevance: 0.14, saveShare: 0.12, reliability: 0.12, feasibility: 0.08 };
  return Object.entries(weights).reduce((total, [key, weight]) => total + Math.max(0, Math.min(10, Number(candidate[key] ?? 0))) * weight, 0) * (novelty / 10);
}
export function chooseIdea(candidates, history = []) { return [...candidates].map((item) => ({ ...item, score: scoreIdea(item, history) })).sort((a, b) => b.score - a.score)[0] || null; }
export class DiscoveryEngine {
  constructor({ store, sources = DEFAULT_SOURCES, fetcher = fetch }) { this.store = store; this.sources = sources; this.fetcher = fetcher; }
  async discover() {
    const signals = [];
    for (const source of this.sources) {
      try { const response = await this.fetcher(source.url, { headers: { 'user-agent': 'UsefulTechManager/0.1 research' }, signal: AbortSignal.timeout(12_000) }); if (!response.ok) continue; const text = (await response.text()).slice(0, 250_000); signals.push({ source, text, retrievedAt: isoNow() }); } catch { /* Alternate sources remain available on next run. */ }
    }
    return signals;
  }
  recordResearch(contentId, sources) { for (const source of sources) this.store.addSource(contentId, { url: source.source.url, title: source.source.name, retrievedAt: source.retrievedAt, claims: [] }); }
}
