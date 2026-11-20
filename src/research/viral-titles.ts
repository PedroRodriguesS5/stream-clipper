import fs from 'fs/promises';
import path from 'path';
import { log } from '../utils/logger.js';

/**
 * Real viral examples for the title prompt: top Brazilian YouTube Shorts for
 * "<streamer> <game>" and "<game> cortes", with their view counts.
 * Public search page only (no login). Cached 6 h per query in data/viral-titles-cache.json.
 *
 *   npm run research:titles -- alanzoka "GTA 6"
 */

export interface ViralTitle {
  title: string;
  views: number;
}

const CACHE = path.resolve('data/viral-titles-cache.json');
const TTL_MS = 6 * 3600_000;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const parseViews = (s: string): number => {
  const m = s.replace(/ /g, ' ').match(/([\d.,]+)\s*(mil|mi|bi)?\s*visualiza/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
  return Math.round(n * ({ mil: 1e3, mi: 1e6, bi: 1e9 } as Record<string, number>)[(m[2] || '').toLowerCase()] || n);
};

const collect = (node: unknown, out: ViralTitle[]) => {
  if (Array.isArray(node)) return node.forEach((x) => collect(x, out));
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, any>;
  if (o.shortsLockupViewModel?.accessibilityText) {
    // "TITLE, 703 mil visualizações - ver o Shorts"
    const text: string = o.shortsLockupViewModel.accessibilityText;
    const title = text.replace(/,\s*[\d.,]+\s*(mil|mi|bi)?\s*visualiza.*$/i, '').trim();
    out.push({ title, views: parseViews(text) });
  } else if (o.videoRenderer) {
    const v = o.videoRenderer;
    const title = (v.title?.runs || []).map((r: any) => r.text).join('');
    const vc = v.viewCountText?.simpleText || (v.viewCountText?.runs || []).map((r: any) => r.text).join('');
    out.push({ title, views: parseViews(`${vc} visualizações`.replace(/visualizações visualizações/, 'visualizações')) });
  }
  Object.values(o).forEach((x) => collect(x, out));
};

const searchShorts = async (query: string): Promise<ViralTitle[]> => {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIYAQ%253D%253D&hl=pt-BR&gl=BR`;
  const html = await (await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' } })).text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return [];
  const out: ViralTitle[] = [];
  collect(JSON.parse(m[1]), out);
  return out.filter((t) => t.title && t.views > 0);
};

type Cache = Record<string, { at: number; items: ViralTitle[] }>;

const cachedSearch = async (query: string): Promise<ViralTitle[]> => {
  const cache = JSON.parse(await fs.readFile(CACHE, 'utf-8').catch(() => '{}')) as Cache;
  const hit = cache[query];
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
  const items = await searchShorts(query);
  cache[query] = { at: Date.now(), items };
  await fs.writeFile(CACHE, JSON.stringify(cache, null, 2) + '\n');
  return items;
};

/** Top viral titles (>= 10k views) for this streamer + game and the game's "cortes" niche */
export const viralTitleExamples = async (streamer: string, gameKeyword: string, limit = 12): Promise<ViralTitle[]> => {
  const queries = [`${streamer} ${gameKeyword}`, `${gameKeyword} cortes`, `${gameKeyword} engraçado`];
  const all = (await Promise.all(queries.map((q) => cachedSearch(q).catch(() => [] as ViralTitle[])))).flat();
  const seen = new Set<string>();
  return all
    .filter((t) => t.views >= 10_000 && !seen.has(t.title) && !!seen.add(t.title))
    .sort((a, b) => b.views - a.views)
    .slice(0, limit);
};

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
export const formatViralExamples = (items: ViralTitle[]) => items.map((t) => `- ${fmt(t.views)} views: ${t.title}`).join('\n');

if (process.argv[1]?.endsWith('viral-titles.js')) {
  const [streamer = 'alanzoka', game = 'GTA 6'] = process.argv.slice(2);
  viralTitleExamples(streamer, game, 25)
    .then((items) => {
      console.log(formatViralExamples(items));
      log('SUCCESS', 'ViralTitles', `${items.length} examples for "${streamer} ${game}"`);
    })
    .catch((e) => log('ERROR', 'ViralTitles', (e as Error).message));
}
