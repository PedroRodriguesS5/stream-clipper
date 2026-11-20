import { MOMENT_TYPES, MomentType } from '../ai/ai.js';
import { runClaudeJson } from '../ai/claude-cli.js';
import { MOMENT_LABELS } from './session.js';

/**
 * Turns what the user typed ("fails engraçados de minecraft", "lives do cellbit no GTA",
 * "o de sempre") into a clipping plan the program can run: Twitch categories, channels,
 * language, content types and minimum viewers. The AI proposes; every name is then checked
 * against Twitch by the caller (resolveCategory / resolveChannel).
 */
export interface DraftPlan {
  categories: string[];
  channels: string[];
  onlyChannels: boolean;
  language: string;
  contentTypes: MomentType[];
  minViewers: number | null;
  summary: string;
  /** Set when the request is about something the program can't do (e.g. a recorded video link) */
  notSupported: string;
}

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    categories: { type: 'array', items: { type: 'string' }, description: 'Twitch category names (official spelling) the user wants. Empty if they only named channels.' },
    channels: { type: 'array', items: { type: 'string' }, description: 'Twitch channel logins the user named (from names, @handles or twitch.tv links)' },
    only_channels: { type: 'boolean', description: 'true if the user wants ONLY those channels (e.g. "só as lives do cellbit")' },
    language: { type: 'string', description: 'Twitch broadcaster language code: PT, EN, ES... (default the current one)' },
    content_types: { type: 'array', items: { type: 'string', enum: MOMENT_TYPES.filter((t) => t !== 'nothing' && t !== 'waiting_or_menu') }, description: 'Kinds of moments the user wants; empty = any good moment' },
    min_viewers: { type: ['integer', 'null'], description: 'Minimum viewers if the user implied it ("canais pequenos" ~ 50, "grandes" ~ 5000), else null' },
    summary_pt: { type: 'string', description: 'One short sentence in Brazilian Portuguese describing the plan to the user' },
    not_supported: { type: 'string', description: 'Empty, or a short pt-BR explanation if the user asked for something impossible (e.g. clipping an old recorded VOD or a YouTube video: only LIVE Twitch streams are supported)' },
  },
  required: ['categories', 'channels', 'only_channels', 'language', 'content_types', 'min_viewers', 'summary_pt', 'not_supported'],
  additionalProperties: false,
};

export const buildInterpretPrompt = (request: string, ctx: { language: string; trending: string[]; memory: string; previous?: DraftPlan }) =>
  [
    `You configure a program that watches LIVE Twitch streams and cuts short vertical clips of the best moments.`,
    `Turn the user's request into a plan. The user writes in Portuguese (or English).`,
    `Current language: ${ctx.language}. Big categories right now: ${ctx.trending.join(', ') || 'unknown'}.`,
    `What we know about this user (memory):\n${ctx.memory}`,
    `If the request is vague ("o de sempre", "igual ontem", "surpreenda-me"), use the memory, or the biggest category right now.`,
    `Content types you can choose:\n${MOMENT_TYPES.filter((t) => t !== 'nothing' && t !== 'waiting_or_menu').map((t) => `- ${t}: ${MOMENT_LABELS[t]}`).join('\n')}`,
    `Use official Twitch category names ("Grand Theft Auto VI", "Minecraft", "VALORANT", "Just Chatting", "League of Legends", "Counter-Strike").`,
    `"Conversa", "bate-papo", "react" without a game = Just Chatting. A twitch.tv/<name> link is a channel. A twitch.tv/videos/... or YouTube link is a recorded video: not supported, explain in not_supported and, if possible, use its channel instead.`,
    ctx.previous ? `The user is ADJUSTING this previous plan (keep what they don't change): ${JSON.stringify(ctx.previous)}` : '',
    `User request: """${request.slice(0, 500)}"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

const CONTENT_WORDS: [RegExp, MomentType[]][] = [
  [/engra[çc]ad|kkk|rir|com[ée]dia|zoeira|fail|bug|funny/i, ['gameplay_fail_funny']],
  [/caos|persegui|batida|explos|tiro|chase|crash/i, ['gameplay_chaos']],
  [/jogada|clutch|habilidade|skill|ace|play/i, ['gameplay_skill']],
  [/descobert|mec[âa]nica|detalhe|easter|segredo|discover/i, ['gameplay_discovery']],
  [/susto|medo|terror|scare|emo[çc]/i, ['emotional_reaction']],
  [/rea[çc][ãa]o|reage|surpres/i, ['surprise_reaction']],
  [/hist[óo]ria|cutscene|story|lore/i, ['story_reaction']],
  [/bonit|paisag|[ée]pic|visual|gr[áa]fico/i, ['epic_scene']],
  [/conversa|papo|desabafo|piada/i, ['streamer_moment']],
];

/** Offline fallback when no AI is available: links/@handles, known category names, content keywords */
export const heuristicPlan = (request: string, known: string[], language: string): DraftPlan => {
  const text = request.toLowerCase();
  const channels = [
    ...request.matchAll(/(?:twitch\.tv\/|@)([A-Za-z0-9_]{3,25})/g),
  ].map((m) => m[1].toLowerCase()).filter((c) => c !== 'videos');
  const categories = known.filter((k) => {
    const short = k.toLowerCase().replace(/grand theft auto vi/, 'gta 6').replace(/grand theft auto v\b/, 'gta 5');
    return text.includes(k.toLowerCase()) || text.includes(short) || (short === 'gta 6' && /gta ?(6|vi)\b/.test(text));
  });
  const contentTypes = [...new Set(CONTENT_WORDS.filter(([re]) => re.test(text)).flatMap(([, t]) => t))];
  const onlyChannels = channels.length > 0 && !categories.length && /(?<!\p{L})(s[óo]|apenas|somente|only)(?!\p{L})/u.test(text);
  return {
    categories,
    channels,
    onlyChannels,
    language,
    contentTypes,
    minViewers: /pequen/.test(text) ? 50 : /grande/.test(text) ? 5000 : null,
    summary: '',
    notSupported: /twitch\.tv\/videos\/|youtu\.?be/.test(text) ? 'Vídeos gravados ainda não são suportados: só lives da Twitch.' : '',
  };
};

export const interpretRequest = async (
  request: string,
  ctx: { language: string; trending: string[]; memory: string; previous?: DraftPlan }
): Promise<{ plan: DraftPlan; via: 'ai' | 'heuristic' }> => {
  try {
    const r = await runClaudeJson<{
      categories: string[]; channels: string[]; only_channels: boolean; language: string;
      content_types: string[]; min_viewers: number | null; summary_pt: string; not_supported: string;
    }>(buildInterpretPrompt(request, ctx), PLAN_SCHEMA, { timeoutMs: 60_000 });
    return {
      via: 'ai',
      plan: {
        categories: (r.categories || []).map(String).filter(Boolean).slice(0, 5),
        channels: (r.channels || []).map((c) => String(c).replace(/^@/, '').toLowerCase()).filter(Boolean).slice(0, 10),
        onlyChannels: !!r.only_channels,
        language: /^[A-Za-z]{2}$/.test(r.language || '') ? r.language.toUpperCase() : ctx.language,
        contentTypes: (r.content_types || []).filter((t): t is MomentType => (MOMENT_TYPES as readonly string[]).includes(t)),
        minViewers: Number.isInteger(r.min_viewers) && (r.min_viewers as number) >= 0 ? (r.min_viewers as number) : null,
        summary: String(r.summary_pt || ''),
        notSupported: String(r.not_supported || ''),
      },
    };
  } catch {
    const base = heuristicPlan(request, ctx.trending, ctx.language);
    if (ctx.previous) {
      // Adjusting without AI: keep the previous plan and add what we recognized
      return {
        via: 'heuristic',
        plan: {
          ...ctx.previous,
          categories: base.categories.length ? base.categories : ctx.previous.categories,
          channels: [...new Set([...ctx.previous.channels, ...base.channels])],
          contentTypes: base.contentTypes.length ? base.contentTypes : ctx.previous.contentTypes,
          minViewers: base.minViewers ?? ctx.previous.minViewers,
          notSupported: base.notSupported,
        },
      };
    }
    return { via: 'heuristic', plan: base };
  }
};
