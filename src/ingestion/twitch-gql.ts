import axios from 'axios';

const TWITCH_GQL = 'https://gql.twitch.tv/gql';
// Public web client id used by twitch.tv itself (no login needed for public data)
const PUBLIC_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

export const twitchGql = async <T = any>(query: string): Promise<T> => {
  const res = await axios.post(
    TWITCH_GQL,
    { query },
    { headers: { 'Client-ID': PUBLIC_CLIENT_ID, 'Content-Type': 'application/json' }, timeout: 20_000 }
  );
  if (res.data?.errors?.length) {
    throw new Error(`Twitch GQL error: ${JSON.stringify(res.data.errors).slice(0, 300)}`);
  }
  return res.data.data as T;
};

export interface LiveStreamInfo {
  login: string;
  viewersCount: number;
  title: string;
  category: string;
}

/**
 * Live streams in a language across several categories, both the biggest
 * (VIEWER_COUNT) and the smallest (VIEWER_COUNT_ASC) so small creators are included.
 */
export const discoverLiveStreams = async (
  language: string,
  categories: string[],
  opts: { includeSmall?: boolean; perCategory?: number } = {}
): Promise<LiveStreamInfo[]> => {
  const lang = language.toUpperCase().replace(/[^A-Z]/g, '');
  const first = Math.min(opts.perCategory ?? 30, 30);
  const sorts = opts.includeSmall ? ['VIEWER_COUNT', 'VIEWER_COUNT_ASC'] : ['VIEWER_COUNT'];
  const found = new Map<string, LiveStreamInfo>();

  for (const sort of sorts) {
    const query =
      '{' +
      categories
        .map(
          (c, i) =>
            `g${i}: game(name: ${JSON.stringify(c)}) { streams(first: ${first}, options: { sort: ${sort}, broadcasterLanguages: [${lang}] }) { edges { node { title viewersCount broadcaster { login broadcastSettings { language } } } } } }`
        )
        .join(' ') +
      '}';
    const data = await twitchGql<Record<string, any>>(query);
    categories.forEach((category, i) => {
      for (const edge of data?.[`g${i}`]?.streams?.edges || []) {
        const node = edge?.node;
        const login = node?.broadcaster?.login;
        const streamLang = String(node?.broadcaster?.broadcastSettings?.language || '').toUpperCase();
        if (login && streamLang === lang && !found.has(login)) {
          found.set(login, { login, viewersCount: node.viewersCount || 0, title: node.title || '', category });
        }
      }
    });
  }
  return [...found.values()];
};

export interface ChannelProfile {
  login: string;
  displayName: string;
  followers: number;
  description: string;
  panels: { title: string; description: string; linkURL: string }[];
  isLive: boolean;
  viewersCount: number;
  streamTitle: string;
  category: string;
}

/** Bio + text panels + live status for up to ~15 channels per request */
export const fetchChannelProfiles = async (logins: string[]): Promise<ChannelProfile[]> => {
  const out: ChannelProfile[] = [];
  for (let i = 0; i < logins.length; i += 15) {
    const batch = logins.slice(i, i + 15);
    const query =
      '{' +
      batch
        .map(
          (l, j) =>
            `u${j}: user(login: ${JSON.stringify(l)}) { login displayName description followers { totalCount } stream { viewersCount title game { name } } panels { ... on DefaultPanel { title description linkURL } } }`
        )
        .join(' ') +
      '}';
    const data = await twitchGql<Record<string, any>>(query);
    batch.forEach((_, j) => {
      const u = data?.[`u${j}`];
      if (!u) return;
      out.push({
        login: u.login,
        displayName: u.displayName || u.login,
        followers: u.followers?.totalCount || 0,
        description: u.description || '',
        panels: (u.panels || [])
          .filter(Boolean)
          .map((p: any) => ({ title: p.title || '', description: p.description || '', linkURL: p.linkURL || '' })),
        isLive: !!u.stream,
        viewersCount: u.stream?.viewersCount || 0,
        streamTitle: u.stream?.title || '',
        category: u.stream?.game?.name || '',
      });
    });
  }
  return out;
};
