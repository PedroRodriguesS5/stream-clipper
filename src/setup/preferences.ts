import fs from 'fs/promises';
import path from 'path';
import { config } from '../utils/config.js';
import type { ClipSession } from './session.js';

/**
 * Self-memory (data/preferences.json): what the user chose before and how those choices did.
 * Used to rank suggestions in the wizard and to give the AI context for vague requests
 * ("o de sempre", "parecido com ontem").
 */
export interface Preferences {
  version: 1;
  /** Most recent first, at most 50 */
  history: { at: string; request: string; categories: string[]; channels: string[]; contentTypes: string[] }[];
  counts: {
    categories: Record<string, number>;
    channels: Record<string, number>;
    contentTypes: Record<string, number>;
  };
}

export const emptyPreferences = (): Preferences => ({
  version: 1,
  history: [],
  counts: { categories: {}, channels: {}, contentTypes: {} },
});

export const PREFS_PATH = () => path.join(path.dirname(config.outputDir), 'data', 'preferences.json');

export const loadPreferences = async (file = PREFS_PATH()): Promise<Preferences> => {
  try {
    const p = JSON.parse(await fs.readFile(file, 'utf-8')) as Preferences;
    return p?.version === 1 ? { ...emptyPreferences(), ...p, counts: { ...emptyPreferences().counts, ...p.counts } } : emptyPreferences();
  } catch {
    return emptyPreferences();
  }
};

export const savePreferences = async (p: Preferences, file = PREFS_PATH()) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(p, null, 2) + '\n');
};

/** Records a confirmed choice (pure: returns a new object) */
export const remember = (p: Preferences, s: ClipSession): Preferences => {
  const bump = (rec: Record<string, number>, keys: string[]) => {
    const out = { ...rec };
    for (const k of new Set(keys)) out[k] = (out[k] || 0) + 1;
    return out;
  };
  return {
    version: 1,
    history: [
      { at: s.createdAt, request: s.request, categories: s.categories, channels: s.channels, contentTypes: s.contentTypes },
      ...p.history,
    ].slice(0, 50),
    counts: {
      categories: bump(p.counts.categories, s.categories),
      channels: bump(p.counts.channels, s.channels),
      contentTypes: bump(p.counts.contentTypes, s.contentTypes),
    },
  };
};

/** Views of our posted videos per game, from data/video-metrics.json + each clip's .seo.json */
export const performanceByGame = async (): Promise<Record<string, { views: number; videos: number }>> => {
  const out: Record<string, { views: number; videos: number }> = {};
  try {
    const file = path.join(path.dirname(config.outputDir), 'data', 'video-metrics.json');
    const { videos } = JSON.parse(await fs.readFile(file, 'utf-8')) as { videos: { clip: string; views?: number }[] };
    for (const v of videos) {
      const seo = JSON.parse(
        await fs.readFile(path.join(config.outputDir, v.clip.replace(/\.mp4$/, '.seo.json')), 'utf-8').catch(() => '{}')
      ) as { game?: string };
      const game = seo.game || config.targetCategory;
      out[game] = { views: (out[game]?.views || 0) + (v.views || 0), videos: (out[game]?.videos || 0) + 1 };
    }
  } catch {
    // no metrics yet
  }
  return out;
};

export interface Suggestion {
  category: string;
  /** why it's suggested, shown in the UI */
  reasons: string[];
  score: number;
}

/**
 * Ranks categories for the wizard: past choices (frequency + recency), our own results
 * (views), and what is big in the user's language on Twitch right now.
 */
export const rankSuggestions = (
  prefs: Preferences,
  trending: { category: string; viewers: number; streams: number }[],
  performance: Record<string, { views: number; videos: number }>,
  limit = 8
): Suggestion[] => {
  const s = new Map<string, Suggestion>();
  const get = (c: string) => s.get(c) || (s.set(c, { category: c, reasons: [], score: 0 }), s.get(c)!);
  const recent = prefs.history.slice(0, 5).flatMap((h) => h.categories);
  for (const [cat, n] of Object.entries(prefs.counts.categories)) {
    const g = get(cat);
    g.score += 3 * n + (recent.includes(cat) ? 4 : 0);
    g.reasons.push(`você escolheu ${n}x`);
  }
  for (const [cat, perf] of Object.entries(performance)) {
    if (!perf.views) continue;
    const g = get(cat);
    g.score += Math.log10(1 + perf.views) * 2;
    g.reasons.push(`${perf.views.toLocaleString('pt-BR')} views nos seus vídeos`);
  }
  const maxViewers = Math.max(1, ...trending.map((t) => t.viewers));
  for (const t of trending) {
    const g = get(t.category);
    g.score += 5 * (t.viewers / maxViewers) + Math.min(2, t.streams / 20);
    g.reasons.push(`${t.viewers.toLocaleString('pt-BR')} espectadores em ${t.streams} lives agora`);
  }
  return [...s.values()].sort((a, b) => b.score - a.score).slice(0, limit);
};

/** Short memory summary for the AI interpreter */
export const memorySummary = (p: Preferences): string => {
  const top = (rec: Record<string, number>) =>
    Object.entries(rec)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([k, n]) => `${k} (${n}x)`)
      .join(', ');
  const last = p.history[0];
  return [
    p.history.length ? `Last request: "${last.request}" -> categories ${last.categories.join(', ') || '-'}, channels ${last.channels.join(', ') || '-'}` : 'No history yet.',
    top(p.counts.categories) ? `Favourite categories: ${top(p.counts.categories)}` : '',
    top(p.counts.channels) ? `Favourite channels: ${top(p.counts.channels)}` : '',
    top(p.counts.contentTypes) ? `Favourite content: ${top(p.counts.contentTypes)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
};
