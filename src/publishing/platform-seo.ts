import type { SEOMetadata } from '../ai/ai.js';
import { gameProfile } from '../ai/game-profile.js';

/**
 * One SEOMetadata in, one ready-to-send package per platform out.
 * Limits checked in Nov 2026 (see docs/task-seo-tiktok-youtube.md for sources):
 *
 *  YouTube  - title 100 chars; description 5000; `snippet.tags` 500 chars for the whole list
 *             (official API docs); more than 15 hashtags => YouTube ignores all of them, the first
 *             3 show above the title. Keyword lists in the description count as "tag stuffing"
 *             under the spam policy, so search phrases only go in the hidden tags field.
 *  TikTok   - 2200 UTF-16 units via TikTok's API (the app allows 4000; we stay at the safe
 *             value). Search reads the caption text, on-screen text and speech; hashtags are a
 *             weak signal, so 3-5 focused ones.
 *  Instagram- Graph API caption: 2200 chars, 30 hashtags, 20 @mentions. Since Dec 2025 Instagram
 *             caps posts/Reels at 5 hashtags, so we send at most 5.
 */
export const LIMITS = {
  youtube: { title: 100, description: 4900, tagsChars: 500, hashtags: 4 /* + #Shorts = 5 */ },
  tiktok: { caption: 2200, hashtags: 5 },
  instagram: { caption: 2200, hashtags: 5, mentions: 20 },
} as const;

/** Lines like "Tags de busca: a, b, c" (old format, and models sometimes write them) */
const TAG_LIST_LINE = /^\s*(tags(\s+de\s+busca)?|palavras[- ]chave|keywords)\s*:.*$/gim;
const HASHTAG_ONLY_LINE = /^\s*(#[\p{L}\p{N}_]+\s*)+$/gmu;

/** Description text without keyword lists or hashtag lines (each platform adds its own) */
export const cleanBody = (description: string): string =>
  description
    .replace(TAG_LIST_LINE, '')
    .replace(HASHTAG_ONLY_LINE, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const hashtagsFor = (seo: SEOMetadata, max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of seo.hashtags || []) {
    const tag = `#${raw.replace(/^#/, '').replace(/\s+/g, '')}`;
    const key = tag.toLowerCase();
    if (tag.length < 2 || key === '#shorts' || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
};

/** Already credits the stream? ("Live na Twitch: @x", "twitch.tv/x") */
const hasTwitchCredit = (body: string) => /twitch\.tv\/|live na twitch/i.test(body);

const fitText = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return `${cut.slice(0, lastBreak > max * 0.6 ? lastBreak : cut.length).trimEnd()}…`;
};

/** Length YouTube counts for the tags list: commas between tags, quotes around tags with spaces */
export const youtubeTagsLength = (tags: string[]): number =>
  tags.reduce((n, t, i) => n + t.length + (t.includes(' ') ? 2 : 0) + (i > 0 ? 1 : 0), 0);

export interface YouTubePackage {
  title: string;
  description: string;
  tags: string[];
}

export const formatYouTube = (seo: SEOMetadata): YouTubePackage => {
  const profile = gameProfile(seo.game || '');
  const channel = seo.channel?.toLowerCase();
  const title = seo.title.replace(/[<>]/g, '').replace(/\s*#shorts\b/i, '').trim().slice(0, LIMITS.youtube.title);

  let body = cleanBody(seo.description);
  if (channel && !hasTwitchCredit(body)) body += `\n\nLive: twitch.tv/${channel}`;
  const hashtags = [...hashtagsFor(seo, LIMITS.youtube.hashtags), '#Shorts'].join(' ');
  const description = `${fitText(body, LIMITS.youtube.description - hashtags.length - 2)}\n\n${hashtags}`.replace(/[<>]/g, '');

  // Hidden tags: streamer + spellings first (cheap, high value), then long-tail phrases, then hashtag words
  const candidates = [
    ...(channel ? [channel, `${channel} ${profile.keyword.toLowerCase()}`] : []),
    ...profile.searchAliases,
    ...(seo.search_tags || []),
    ...(seo.hashtags || []).map((h) => h.replace(/^#/, '')),
  ];
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const tag = raw.replace(/[<>,"]/g, '').trim();
    const key = tag.toLowerCase();
    if (!tag || tag.length > 100 || seen.has(key)) continue;
    if (youtubeTagsLength([...tags, tag]) > LIMITS.youtube.tagsChars - 10) continue; // small safety margin
    seen.add(key);
    tags.push(tag);
  }
  return { title, description, tags };
};

export const formatTikTokCaption = (seo: SEOMetadata): string => {
  const hashtags = hashtagsFor(seo, LIMITS.tiktok.hashtags).join(' ');
  // Title first: the post-queue verifies the upload by finding the caption's first characters
  const head = seo.title.trim();
  const room = LIMITS.tiktok.caption - head.length - hashtags.length - 4;
  const body = fitText(cleanBody(seo.description), Math.max(0, room));
  // Hashtags last: TikTok opens a suggestion list after "#", and Enter there would pick one
  return [head, body, hashtags].filter(Boolean).join('\n\n');
};

export const formatInstagramCaption = (seo: SEOMetadata): string => {
  const hashtags = hashtagsFor(seo, LIMITS.instagram.hashtags).join(' ');
  // "@streamer" would tag (and notify) whoever owns that name on Instagram, often not the streamer
  // so "Live na Twitch: @x" becomes a twitch.tv link and other @x become plain names
  const deMention = (s: string) =>
    s
      .replace(/(twitch:?\s*)@([A-Za-z0-9_]{3,25})\b/gi, (_m, pre, u) => `${pre}twitch.tv/${u.toLowerCase()}`)
      .replace(/@([A-Za-z0-9_]{3,25})\b/g, '$1');
  const head = deMention(seo.title.trim());
  let body = deMention(cleanBody(seo.description));
  const channel = seo.channel?.toLowerCase();
  if (channel && !/twitch\.tv\//i.test(body)) body += `\n\nLive: twitch.tv/${channel}`;
  const room = LIMITS.instagram.caption - head.length - hashtags.length - 4;
  return [head, fitText(body, Math.max(0, room)), hashtags].filter(Boolean).join('\n\n');
};
