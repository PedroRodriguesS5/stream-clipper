import { discoverLiveStreams, fetchChannelProfiles, twitchGql } from '../ingestion/twitch-gql.js';

/** Categories that are big right now, measured in the user's language (viewers of live streams in it) */
export const trendingCategories = async (
  language: string,
  limit = 8
): Promise<{ category: string; viewers: number; streams: number }[]> => {
  const top = await twitchGql<{ games: { edges: { node: { name: string } }[] } }>('{ games(first: 20) { edges { node { name } } } }');
  const names = top.games.edges.map((e) => e.node.name).filter((n) => !/^(Sports|Music|Movies|Watch Party|Talk Shows & Podcasts)$/i.test(n));
  // Twitch rejects one huge aliased query (HTTP 400): ask 5 categories at a time
  const streams = [];
  for (let i = 0; i < names.length; i += 5) {
    streams.push(...(await discoverLiveStreams(language, names.slice(i, i + 5), { perCategory: 30 }).catch(() => [])));
  }
  const agg = new Map<string, { viewers: number; streams: number }>();
  for (const s of streams) {
    const a = agg.get(s.category) || { viewers: 0, streams: 0 };
    agg.set(s.category, { viewers: a.viewers + s.viewersCount, streams: a.streams + 1 });
  }
  return [...agg.entries()]
    .map(([category, a]) => ({ category, ...a }))
    .filter((t) => t.streams > 0)
    .sort((a, b) => b.viewers - a.viewers)
    .slice(0, limit);
};

/** Exact Twitch category name for a free-text name ("minecraft" -> "Minecraft"), or null */
export const resolveCategory = async (name: string): Promise<string | null> => {
  const exact = await twitchGql<{ game: { name: string } | null }>(`{ game(name: ${JSON.stringify(name)}) { name } }`).catch(() => null);
  if (exact?.game?.name) return exact.game.name;
  const found = await twitchGql<{ searchCategories: { edges: { node: { name: string } }[] } }>(
    `{ searchCategories(query: ${JSON.stringify(name)}, first: 1) { edges { node { name } } } }`
  ).catch(() => null);
  return found?.searchCategories.edges[0]?.node.name ?? null;
};

/** Twitch login from "@cellbit", "twitch.tv/cellbit", "Cellbit"; null if the channel doesn't exist */
export const resolveChannel = async (text: string): Promise<{ login: string; isLive: boolean; category: string } | null> => {
  const login = text.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').split(/[/?#\s]/)[0].toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(login)) return null;
  const [p] = await fetchChannelProfiles([login]).catch(() => []);
  return p ? { login: p.login, isLive: p.isLive, category: p.category } : null;
};

/** How many live streams match a plan right now (for the confirmation screen) */
export const liveCount = async (language: string, categories: string[], minViewers: number): Promise<number> => {
  if (!categories.length) return 0;
  const streams = await discoverLiveStreams(language, categories, { perCategory: 30 }).catch(() => []);
  return streams.filter((s) => s.viewersCount >= minViewers).length;
};
