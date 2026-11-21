import { execFile } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { extractTextFrom9RouterPayload, resolve9RouterApiKey, runClaudeJson } from './claude-cli.js';
import { MomentSignals, timelineForPrompt } from './moment-signals.js';
import { formatViralExamples, viralTitleExamples } from '../research/viral-titles.js';
import { cleanBody } from '../publishing/platform-seo.js';
import { gameKeyword, gameProfile, GameProfile } from './game-profile.js';

const execFileAsync = promisify(execFile);

export interface ExtractClipDecision {
  clip_start: number;
  clip_end: number;
  hook_split_point: number;
  reason: string;
  /** false = no real streamer/chat reaction -> don't clip */
  has_reaction: boolean;
  /** true = streamer is watching someone else's video (trailer, movie...) -> don't clip */
  third_party_media: boolean;
  /** Concrete description of what happened (pt-BR), used for captions/titles */
  what_happened: string;
  streamer_reaction: string;
  chat_reaction: string;
  /** What kind of moment it is (gameplay moments are what GTA viewers watch) */
  moment_type: MomentType;
  /** 1-10: how likely a stranger scrolling Shorts/TikTok watches it to the end */
  virality_score: number;
}

export const MOMENT_TYPES = [
  'gameplay_chaos', // chase, crash, explosion, shootout, escape, wanted level going crazy
  'gameplay_fail_funny', // physics bug, ragdoll, NPC doing something absurd, stupid death
  'gameplay_skill', // impressive driving/shot/escape, clutch
  'gameplay_discovery', // first time seeing a place/vehicle/feature/easter egg, with reaction
  'epic_scene', // breathtaking game visuals / cinematic moment (sunset over Vice City, storm, huge set piece)
  'surprise_reaction', // the streamer is genuinely surprised/shocked by something in the game
  'emotional_reaction', // awe, fear/jump scare, being moved, hype, anger - a strong feeling on camera
  'story_reaction', // reacting to a cutscene/story beat
  'streamer_moment', // the streamer (not the game) is the content: rant, joke, scream at chat
  'waiting_or_menu', // countdown, loading, menus, store page
  'nothing',
] as const;
export type MomentType = (typeof MOMENT_TYPES)[number];

export interface SEOMetadata {
  /** Short on-screen text burned into the video (max ~40 chars) */
  hook_caption: string;
  title: string;
  description: string;
  hashtags: string[];
  /** Long-tail search phrases: hidden YouTube tags + natural wording in captions (never a visible list) */
  search_tags?: string[];
  /** Twitch login of the streamer (credit links, per-platform formatting) */
  channel?: string;
  /** Game actually streamed (Twitch category), drives every keyword/hashtag */
  game?: string;
}

export const EXTRACT_CLIP_JSON_SCHEMA = {
  type: 'object',
  properties: {
    has_reaction: {
      type: 'boolean',
      description:
        'true ONLY if the moment has a clear reaction: the streamer audibly/visibly reacts (shouts, laughs, celebrates, rages, is surprised/shocked, scared, in awe, moved, talks to chat about it) AND/OR chat clearly reacts to that specific moment. Quiet reactions count when they are visible on the webcam (jaw drop, hands on head, staring in awe). A routine kill/play with no reaction = false.',
    },
    third_party_media: {
      type: 'boolean',
      description:
        'true if, at the chosen moment, the main content on screen is someone else\'s video: a trailer, movie, TV, sports broadcast, YouTube/TikTok video, music video (the streamer is watching/reacting instead of playing). In-game cutscenes of the game the streamer is playing right now (e.g. a GTA VI story cutscene on launch day, with the game HUD/subtitles, after they started the game) are gameplay, NOT third-party media: set false for those. Only a trailer/video played in a browser, YouTube, or a media player counts.',
    },
    what_happened: {
      type: 'string',
      description: 'In Brazilian Portuguese, concrete and factual: what happens on screen at the moment (e.g. "matou 3 com a Vandal segurando o bomb com 10 de vida"). Only what you saw in the frames/chat. Use precise verbs and say when something is unclear from still frames (e.g. "o carro rodou na pista (não dá pra ver se capotou)"); never upgrade an action (rodou -> capotou, bateu -> explodiu).',
    },
    streamer_reaction: { type: 'string', description: 'In pt-BR: how the streamer reacts (from webcam frames + loudness), or "sem reação"' },
    chat_reaction: { type: 'string', description: 'In pt-BR: how chat reacts (quote 1-2 real messages), or "sem reação"' },
    clip_start: { type: 'number', description: 'Start (s) within the buffer video' },
    clip_end: { type: 'number', description: 'End (s), must include the streamer/chat reaction' },
    hook_split_point: {
      type: 'number',
      description: 'Second where the climax begins (strictly between start and end). [split..end] is shown FIRST, then [start..split], forming a loop.',
    },
    reason: { type: 'string', description: 'Why this moment, citing the signals (loudness, chat timing, screen change, frames)' },
    moment_type: { type: 'string', enum: [...MOMENT_TYPES], description: 'The main kind of content in the chosen clip' },
    virality_score: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description:
        'How likely a stranger scrolling Shorts/TikTok (who does not know this streamer) stops and watches to the end. 9-10: absurd/chaotic gameplay or a jaw-dropping scene + big reaction, understandable in 2 s with no context. 7-8: a clear moment with a real feeling on camera - funny, chaotic, beautiful, surprising, scary or emotional. 5-6: decent but needs context or the payoff is slow. 1-4: talking, waiting, menus, scenes watched with no visible feeling, inside jokes.',
    },
  },
  required: ['moment_type', 'virality_score', 'has_reaction', 'third_party_media', 'what_happened', 'streamer_reaction', 'chat_reaction', 'clip_start', 'clip_end', 'hook_split_point', 'reason'],
  additionalProperties: false,
};

/**
 * Picks the moment using real reaction signals (not just "chat was fast"):
 * per-second loudness + chat lined up with the video + frames around the best candidates.
 * Returns has_reaction=false when nothing worth posting happened.
 */
export const extractClipWithClaudeAgent = async (context: {
  bufferDurationSeconds: number;
  chatMessages: string[];
  channel: string;
  /** Game/category actually being streamed */
  game?: string;
  signals?: MomentSignals;
  /** JPEG frames around the candidate moments (Claude reads them) */
  frames?: { second: number; path: string }[];
  /** What performed well/badly on our channels (from data/video-metrics.json) */
  pastPerformance?: string;
  /** Parts of this recording (buffer seconds) that were already posted as a clip */
  alreadyClipped?: { from: number; to: number }[];
}): Promise<ExtractClipDecision> => {
  const sig = context.signals;
  const isGame = !!context.game && !/just chatting|conversando/i.test(context.game);
  const prompt = [
    `You pick the best SHORT-FORM moment from the Brazilian ${context.game || config.targetCategory} live stream "${context.channel}" (a ${context.bufferDurationSeconds}s recording).`,
    `A good clip needs a REACTION: something happens, the streamer reacts (shouting, laughing, celebrating, raging, surprised, scared, in awe, moved, talking about it) and chat reacts. A clean kill or normal play with no reaction is NOT worth a clip (it belongs in a Twitch clip) -> has_reaction=false.`,
    isGame
      ? [
          `WHAT WORKS FOR ${context.game?.toUpperCase()} SHORTS (prefer GAMEPLAY over the streamer just talking):`,
          `- Chaos: police chase that ends in a crash, explosion, shootout, wanted stars climbing, a ridiculous escape.`,
          `- Funny fails: physics/ragdoll, car flipping, NPC doing something absurd, a stupid death ("WASTED"/"BUSTED"), a plan going wrong.`,
          `- Skill: impossible driving, a perfect shot, escaping with 1 HP.`,
          `- EASTER EGGS & HIDDEN DETAILS (TOP PRIORITY, the most searched and watched GTA 6 Shorts in Brazil: "gta 6 easter egg" Shorts get ~24k views typically and up to 400k+): the streamer finding a real secret: a hidden reference or message, a nod to older GTA games or other media, a secret place or item, a strange NPC/world behavior few people know, an absurdly detailed mechanic shown for the first time. When the frames clearly show one and the streamer reacts, give virality_score 9-10 and say "easter egg"/"detalhe escondido" in what_happened. Ordinary features (petting a dog, renting a scooter) are discoveries, not easter eggs: don't call them that.`,
          `- Discovery & World Details (HIGH PRIORITY): the streamer discovering or reacting to CAR MECHANICS (engine damage/smoke, tuning, towing, rust/paint, crash physics, turn signals, interior details), BOATS / WATERCRAFT (speedboats, boat fishing, seaplanes on water, swamp navigation), ANIMALS & WILDLIFE (alligators/jacarés, snakes, pelicans, chickens, dogs, sharks, fish, animals decomposing or attacking), or realistic NPC/world mechanics. Give clear car mechanic, boat, or animal reaction moments a virality_score of 8-9+.`,
          `- Great scenes: a breathtaking view or cinematic moment of the game (sunset/storm over Vice City, a huge set piece, an amazing detail) - especially when the streamer is in awe ("que lindo", silence, jaw drop).`,
          `- Surprise and strong feelings, not only comedy: the streamer genuinely shocked ("o quê?!"), scared by a jump scare, moved by a story beat, hyped, or angry. Any real, visible feeling about what happens on screen can be a clip.`,
          `- Feature reveal (VERY strong in a game's launch weeks): showing HOW something works for the first time - car mechanics, boats, wildlife/animals, gas/fuel, police/wanted system, phone, money, map, controls, graphics detail, weather, NPC realism. Viral examples: "O SISTEMA DE GASOLINA NO GTA 6 É O SEGUINTE" (401k views), "L3 pra correr e mapa no touchpad" (169k), "Quando o GTA 6 é MUITO detalhado..." (921k). A clear feature reveal with any reaction deserves 7+.`,
          `- TOP PRIORITY (what our audience wants most - score 8+ when the streamer visibly reacts): the streamer discovering CAR MECHANICS (opening the hood/engine, damage deforming the car, tires/fuel, tuning shop, interior details), BOATS & WATER (driving a speedboat/jet ski/seaplane, getting stuck, sinking, swimming next to a boat), and ANIMALS (alligators, snakes, flamingos, deer, tigers, dogs - seeing one for the first time, being attacked, zooming in on one). The animal/boat/car detail must be clearly visible on screen.`,
          `- The payoff must be visible on screen and understandable in 2 seconds by someone who does not know the streamer. The hook (hook_split_point) should be the most visual instant: the crash/explosion/fail itself.`,
          `AVOID (low virality_score): countdowns, loading screens, menus, store pages, the streamer only talking with nothing happening in game, scenes they watch with NO visible feeling, inside jokes with chat. A story scene WITH a strong reaction (surprise, awe, emotion) is fine.`,
          `NEVER pick a moment whose main content is a real licensed song (in-game radio, Spotify, music playing loudly): YouTube Content ID claims it and TikTok mutes it. If music is the point of the moment, set third_party_media=true.`,
          `screen_change in the timeline is high when the picture changes a lot (crash, explosion, fast camera, death screen). An audio peak + screen change + chat burst together is the strongest gameplay moment. A single isolated screen_change spike can just be a menu or scene cut: check the frames.`,
        ].join('\n')
      : '',
    context.alreadyClipped?.length
      ? `ALREADY CLIPPED - do NOT pick these parts again (they were posted already): ${context.alreadyClipped.map((r) => `seconds ${r.from}-${r.to}`).join(', ')}. Choose a DIFFERENT moment; if nothing else is good, set has_reaction=false.`
      : '',
    config.contentFocus
      ? `WHAT THE USER ASKED FOR: "${config.contentFocus.request}".${config.contentFocus.types.length ? ` Preferred moment types: ${config.contentFocus.types.join(', ')}. Moments of these types that meet the quality bar get +1 virality_score; other types need to be clearly exceptional to score 8+.` : ''} Never invent a moment to satisfy the request: if nothing matching happened, judge the recording normally.`
      : '',
    context.pastPerformance ? `RESULTS OF OUR PREVIOUS CLIPS (learn from them; views per hour after posting):\n${context.pastPerformance}` : '',
    sig
      ? [
          `Signals aligned to the video timeline (second 0 = start of the recording):`,
          `- loudness_vs_usual: stream audio loudness compared with this stream's normal level. Big positive jumps often mean the streamer shouting/laughing (but game sounds also count, so confirm with frames).`,
          `- chat: viewers type ~3-15 s AFTER they see the moment, so a chat burst at second X points to a moment around X-5..X-12.`,
          timelineForPrompt(sig),
          `Top candidate moments (score = audio jump + chat burst after it + on-screen action):`,
          ...sig.candidates.map(
            (c) => `- second ${c.second}: audio ${c.audioZ >= 0 ? '+' : ''}${c.audioZ}σ, chat ${c.chatZ >= 0 ? '+' : ''}${c.chatZ}σ, screen action ${c.visualZ >= 0 ? '+' : ''}${c.visualZ}σ | chat: ${c.sampleChat.join(' / ') || '(none)'}`
          ),
        ].join('\n')
      : `Recent chat (no timing available):\n${context.chatMessages.slice(-25).join('\n')}`,
    context.frames?.length
      ? `Use the Read tool to look at these frames (webcam = streamer's face, game = what happened):\n${context.frames.map((f) => `- second ${f.second}: ${f.path}`).join('\n')}`
      : '',
    `Chat is Brazilian Portuguese: KKKK, MDS, CARALHO, NÃO ACREDITO, CLIPA, PQP, emote spam = hype.`,
    `TIMING & 3-SECOND RETENTION (CRITICAL for TikTok/Shorts algorithm):`,
    `- High retention in the first 2-3 seconds is REQUIRED so viewers do not swipe away: the video MUST catch user attention in the first 3 seconds with immediate visual motion, streamer reaction buildup, audio spike, or dramatic situation.`,
    `- Set clip_start tightly: 1.5 to 3 seconds BEFORE the action/reaction begins. NEVER start with 6-8s of slow walking, silent driving, or dead air.`,
    `- Climax / payoff (hook_split_point) must happen within seconds 3-8 of the clip so viewers get hooked immediately.`,
    `- Clip length (clip_end - clip_start) must be ${config.clipMinSeconds}-${config.clipMaxSeconds}s (ideal: 18-32s).`,
    `- Set clip_end 2-5 seconds AFTER the streamer's main reaction finishes. NEVER include dead tail after the moment (do not include the streamer walking away to do something else, opening pause menus, or watching TV).`,
    `- If the frames only show routine driving/walking, menus, loading screens, or conversation with no clear visual payoff on screen, set has_reaction=false, moment_type="nothing", virality_score=2.`,
    `Describe only what you can actually see/read in the attached frames. Never invent facts.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    log('INFO', 'ClaudeAgent', `Choosing the moment with vision (${sig?.candidates.length ?? 0} candidates, ${context.frames?.length ?? 0} frames)...`);
    const raw = await runClaudeJson<Partial<ExtractClipDecision>>(prompt, EXTRACT_CLIP_JSON_SCHEMA, {
      tools: context.frames?.length ? ['Read'] : [],
      timeoutMs: 180_000,
    });
    const decision = validateClipDecision(raw, context.bufferDurationSeconds);
    log('SUCCESS', 'ClaudeAgent', 'Moment chosen', decision);
    return decision;
  } catch (cliError) {
    log(
      'WARN',
      'ClaudeAgent',
      `Vision moment picker failed (${(cliError as Error).message}). Refusing to make a blind unvalidated cut.`
    );
    return {
      clip_start: 0,
      clip_end: Math.min(config.clipMinSeconds, context.bufferDurationSeconds),
      hook_split_point: Math.min(10, context.bufferDurationSeconds / 2),
      reason: `Skipped: vision validation unavailable (${(cliError as Error).message})`,
      has_reaction: false,
      third_party_media: false,
      what_happened: '',
      streamer_reaction: 'sem reação',
      chat_reaction: 'sem reação',
      moment_type: 'nothing',
      virality_score: 1,
    };
  }
};

const validateClipDecision = (
  raw: Partial<ExtractClipDecision>,
  maxDuration: number
): ExtractClipDecision => {
  const minLen = Math.min(config.clipMinSeconds, maxDuration);
  const maxLen = Math.max(minLen, Math.min(config.clipMaxSeconds, maxDuration));

  let start = Number(raw.clip_start ?? 0);
  let end = Number(raw.clip_end ?? maxDuration);
  if (isNaN(end) || end > maxDuration || end <= 0) end = maxDuration;
  if (isNaN(start) || start < 0 || start >= end) start = Math.max(0, end - minLen);

  // Enforce length: grow backwards first (the moment is usually at the end), then forwards
  if (end - start < minLen) {
    start = Math.max(0, end - minLen);
    if (end - start < minLen) end = Math.min(maxDuration, start + minLen);
  }
  if (end - start > maxLen) start = end - maxLen;

  let split = Number(raw.hook_split_point ?? (start + end) / 2);
  if (isNaN(split) || split <= start + 0.5 || split >= end - 0.5) {
    split = Number(((start + end) / 2).toFixed(2));
  }

  return {
    clip_start: Number(start.toFixed(2)),
    clip_end: Number(end.toFixed(2)),
    hook_split_point: Number(split.toFixed(2)),
    reason: raw.reason || 'High chat velocity highlight detected',
    has_reaction: raw.has_reaction === true,
    third_party_media: raw.third_party_media === true,
    what_happened: String(raw.what_happened || ''),
    streamer_reaction: String(raw.streamer_reaction || 'sem reação'),
    chat_reaction: String(raw.chat_reaction || 'sem reação'),
    moment_type: (MOMENT_TYPES as readonly string[]).includes(String(raw.moment_type)) ? (raw.moment_type as MomentType) : 'nothing',
    virality_score: Math.max(1, Math.min(10, Math.round(Number(raw.virality_score) || 5))),
  };
};

export const SEO_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hook_caption: {
      type: 'string',
      description: 'Very short on-screen hook text in the target language, max 40 characters, no hashtags (e.g. "ELE NÃO ESPERAVA ISSO 😱")',
    },
    title_options: {
      type: 'array',
      items: { type: 'string' },
      description: '5 different title candidates following the TITLE rules (different angles: claim, question, "primeiro", feature, reaction)',
    },
    title: {
      type: 'string',
      description: 'The single best of title_options: the one a stranger would most likely click (max 70 characters)',
    },
    description: {
      type: 'string',
      description: 'Engaging video description in the target language for YouTube Shorts, TikTok and Reels',
    },
    hashtags: {
      type: 'array',
      items: { type: 'string' },
      description: '3-6 hashtags starting with #, MOST SPECIFIC FIRST: the clip\'s micro-topic (e.g. #<game>carros, #<game>policia), then the streamer, then the game\'s Brazilian niche tag. Only tags about the game actually being played. Platforms show only the first 3-5.',
    },
    search_tags: {
      type: 'array',
      items: { type: 'string' },
      description: '8-12 lowercase pt-BR long-tail search phrases viewers type into YouTube/TikTok search for this exact clip ("<game> <specific thing>", "<streamer> <game>"), only about the game actually being played. They go into hidden YouTube tags; never paste them as a list into the description.',
    },
  },
  required: ['title_options', 'title', 'hook_caption', 'description', 'hashtags', 'search_tags'],
  additionalProperties: false,
};

/**
 * Generates viral SEO metadata (Title, Description, Hashtags) via local 9Router endpoint
 * or seamlessly via the local Claude Code CLI Agent (`claude -p`) if no API key is set.
 */
export const generateSEO = async (context: {
  channel: string;
  chatMessages: string[];
  clipReason: string;
  /** Game actually being streamed (Twitch category); defaults to TARGET_CATEGORY */
  game?: string;
  /** What the moment picker actually saw (the facts captions must be based on) */
  moment?: Pick<ExtractClipDecision, 'what_happened' | 'streamer_reaction' | 'chat_reaction'>;
}): Promise<SEOMetadata> => {
  const game = context.game || config.targetCategory;
  const facts = context.moment
    ? `FACTS (the only things you may state):\n- O que aconteceu: ${context.moment.what_happened}\n- Reação do streamer: ${context.moment.streamer_reaction}\n- Reação do chat: ${context.moment.chat_reaction}`
    : `Highlight context: ${context.clipReason}`;
  const userPrompt = `Game actually being played: ${game}\nStreamer: @${context.channel}\n${facts}\nSome chat messages (Portuguese):\n${context.chatMessages.slice(-12).join('\n')}`;
  const viral = await viralTitleExamples(context.channel, gameKeyword(game)).catch(() => []);
  const seoRules =
    buildSeoRules(game) +
    (viral.length
      ? `\n\nREAL VIRAL SHORTS IN THIS NICHE RIGHT NOW (copy their STYLE - structure, caps, length, angle - never their facts):\n${formatViralExamples(viral)}`
      : '');

  log('INFO', 'ClaudeAgentSEO', 'Writing caption/title/description via 9Router...');
  const basePrompt = [seoRules, userPrompt, 'Return JSON matching the schema.'].join('\n\n');

  try {
    let seo = normalizeSEO(await runClaudeJson<Partial<SEOMetadata>>(basePrompt, SEO_JSON_SCHEMA, { timeoutMs: 90_000 }), context.channel, game);
    const banned = `${seo.hook_caption} ${seo.title}`.match(BANNED_CAPTION_PHRASES);
    if (banned) {
      log('INFO', 'ClaudeAgentSEO', `Caption used a generic phrase ("${banned[0]}"); rewriting once...`);
      seo = normalizeSEO(
        await runClaudeJson<Partial<SEOMetadata>>(
          `${basePrompt}\n\nYour previous answer used the forbidden generic phrase "${banned[0]}" (caption: "${seo.hook_caption}", title: "${seo.title}"). Rewrite them describing the SPECIFIC situation from the FACTS.`,
          SEO_JSON_SCHEMA,
          { timeoutMs: 90_000 }
        ),
        context.channel,
        game
      );
    }
    log('SUCCESS', 'ClaudeAgentSEO', 'Generated SEO metadata', seo);
    return seo;
  } catch (err) {
    log('WARN', 'ClaudeAgentSEO', `SEO generation failed (${(err as Error).message}); using deterministic fallback SEO`);
    const kw = gameKeyword(game);
    const what = context.moment?.what_happened || `descobriu um detalhe absurdo no ${kw}`;
    return normalizeSEO(
      {
        hook_caption: `${context.channel.toUpperCase()} NO ${kw} 😱`,
        title: `${context.channel.toUpperCase()} REAGIU A ESSE DETALHE DO ${kw} 😱`,
        description: `${context.channel} jogando ${kw} ao vivo: ${what}. Live na Twitch: @${context.channel}. Segue pra mais cortes!`,
        hashtags: [],
      },
      context.channel,
      game
    );
  }
};

/**
 * Language + SEO rules injected into every SEO prompt.
 * pt-BR (default) targets Brazilian viewers; pt-PT targets Portugal.
 */
/** Generic/meta phrases real "cortes" channels don't use (they say WHAT happened) */
export const BANNED_CAPTION_PHRASES =
  /\b(o chat|chat pediu|clipa|clipar|clip(e)? isso|momento insano|ningu[eé]m esperava|voc[eê] n[aã]o vai acreditar|olha (s[oó] )?isso|olha o que aconteceu|at[eé] o final|que momento|surreal)\b/i;

const buildSeoRules = (game: string): string => {
  const profile = gameProfile(game);
  const { keyword, lore } = profile;
  const isPortugal = config.contentLocale.toLowerCase() === 'pt-pt';
  const language = isPortugal ? 'European Portuguese (Portugal, pt-PT)' : 'Brazilian Portuguese (pt-BR)';
  return [
    `You write like a successful Brazilian "cortes" channel: short, spoken, specific. Everything ENTIRELY in ${language}.`,
    `Base every word on the FACTS. Never invent kills, scores, names or results that are not in the facts.`,
    `TITLE - how viral Brazilian Shorts titles are written (and ours were NOT):`,
    `  * Start with the STREAMER'S NAME in CAPS as the subject (ALANZOKA, CELLBIT, PAULINHO O LOKO...), never "ele" and never a "${keyword}:" label prefix.`,
    `  * Spell the streamer's name EXACTLY as the Twitch login given (only uppercased): @bisteconee -> BISTECONEE, never shortened or "corrected".`,
    `  * One bold, complete claim in mostly UPPERCASE, 35-60 characters, that creates curiosity: a surprising fact, a "primeiro", a question, or "deu ruim".`,
    `  * Mention "${keyword}" naturally inside the sentence (it is the search keyword), NEVER a different game.`,
    `  * End with at most 1 emoji (😂 😱 💀 🤯) or KKKKK when it is funny.`,
    `  * Proven structures: "ALANZOKA ACHOU QUE ${keyword} ERA VIDA REAL!", "CELLBIT ROUBOU UM AVIÃO NO ${keyword} E DEU RUIM 💀", "É FILME OU JOGO? CELLBIT NÃO ACREDITOU NO ${keyword}", "O SISTEMA DE POLÍCIA DO ${keyword} É ASSIM 😱", "PAULINHO FOI O PRIMEIRO A FAZER ISSO NO ${keyword}".`,
    `  * Bad (ours before): "${keyword}: alanzoka fugiu de hidroavião com motor danificado 😳" - label prefix, flat description, no curiosity.`,
    `  * Only claims supported by the FACTS (no fake "cancelado", "banido", "treta" unless it really happened).`,
    `  * ACCURACY OVER HYPE: use the EXACT action from the FACTS, never a stronger one. "rodou/derrapou" is NOT "capotou"; "bateu" is NOT "explodiu"; "levou um tiro" is NOT "morreu"; "fugiu" is NOT "escapou de 5 estrelas". Curiosity comes from the angle and wording, never from exaggerating what happened. A viewer who watches must see exactly what the title and caption promise.`,
    `  * EASTER EGGS: when the FACTS say the streamer found an easter egg, secret or hidden detail, put "EASTER EGG" (or "SEGREDO" / "DETALHE ESCONDIDO") in the title next to "${keyword}": it is what people search ("ALANZOKA ACHOU UM EASTER EGG SINISTRO NO ${keyword} 😱" had 293k views). Never use these words when the FACTS don't show a real secret.`,
    `  * The structures above are patterns, not text to copy: never reuse an example's wording (e.g. "É FILME OU JOGO") unless the FACTS say exactly that.`,
    `HOOK CAPTION (on-screen text, max 45 chars, UPPERCASE): stays on screen in the first seconds. TikTok and Instagram read on-screen text (OCR) for search, so include "${keyword}" or the concrete thing on screen (CARRO, BARCO, POLÍCIA, the weapon/agent/map). Good: "A FÍSICA DESSE CARRO NO ${keyword} 💀", "FUGIU DA POLÍCIA DE LANCHA NO ${keyword} 🚤". Bad: generic phrases with no keyword ("OLHA ISSO", "VOCÊ NÃO VAI ACREDITAR", "NINGUÉM ESPERAVA").`,
    `DESCRIPTION (used as YouTube description, TikTok caption and Instagram caption; search engines read it as text):`,
    `  * First sentence (the first ~120 characters show in search results): the phrase people would search, written naturally: streamer name + "${keyword}" + the specific thing${lore.length ? ` (places/characters you may name if the FACTS show them: ${lore.join(', ')})` : ''}. E.g. "No ${keyword}, @<streamer> testou a física dos carros e a caminhonete capotou na estrada."`,
    `  * Second sentence: the exact payoff and the streamer/chat reaction, using 1-2 other search phrases from SEARCH_TAGS as normal words.`,
    `  * Last line: a specific question that invites comments (e.g. "Você teria fugido pelo rio? Comenta aí!") plus "Live na Twitch: @<streamer>. ${isPortugal ? 'Segue para mais clips!' : 'Segue pra mais cortes!'}".`,
    `  * NEVER write a list of keywords, "Tags de busca:", or hashtags in the description: YouTube treats keyword lists as spam ("tag stuffing"), and each platform adds its own hashtags.`,
    `HASHTAGS (3-6, most specific first, only for ${keyword}): 1-2 micro-topic tags about this exact scene (#${profile.slug}carros, #${profile.slug}policia...), then #<streamer>, then ${profile.nicheTags[0]}. Broad tags (${profile.broadTags.join(', ')}) and #cortesdelive are added automatically. No filler tags (#jogos, #gameplay, #fyp, #viral).`,
    `SEARCH_TAGS (8-12 lowercase pt-BR long-tail phrases): what real users type to find this exact scene ("${keyword.toLowerCase()} <specific thing>", "<streamer> ${keyword.toLowerCase()}", "${keyword.toLowerCase()} <mechanic> realista"). Only about ${keyword}; never another game.`,
    `Advertiser-friendly: no swear words, slurs or sexual words anywhere, even if the chat or in-game subtitles use them (never quote "se fodeu", "porra", "caralho" in title/description/tags).`,
  ].join('\n');
};

export interface ClipQualityCheckResult {
  seo: SEOMetadata;
  problems: string[];
  approved: boolean;
  verifiedViralityScore: number;
  rejectionReason?: string;
  trimmedStart?: number;
  trimmedEnd?: number;
}

const FACT_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    approved: {
      type: 'boolean',
      description:
        'true ONLY if the frames show a clear, engaging gameplay event (car mechanics/tuning/damage/crash, boat/fishing/watercraft, animal/alligator/wildlife, police chase/shootout/explosion, funny fail/ragdoll, or dramatic visual discovery) with a real reaction. false if the clip is a random cut of nothing, normal driving/walking with no event, pause/menu/loading screens, or mostly dead air.',
    },
    verified_virality_score: {
      type: 'integer',
      minimum: 1,
      maximum: 10,
      description:
        'Strict 1-10 virality score after inspecting all frames of the clip. 8-10: clear car mechanic, boat, animal encounter, crazy crash/fail, or jaw-dropping feature reveal + strong reaction. 7: solid visual moment + clear reaction. 1-6: weak, generic, slow, or random cut -> will be rejected.',
    },
    rejection_reason: {
      type: 'string',
      description: 'If approved=false or verified_virality_score < 7, explain in 1 sentence why this clip is not good enough to post. Empty string if approved.',
    },
    trimmed_clip_start: {
      type: 'number',
      description:
        'Optimal start second within the clip window to cut dead air at the beginning (2-4s before the visual action starts). Set equal to the original clip_start if there is no dead air at the start.',
    },
    trimmed_clip_end: {
      type: 'number',
      description:
        'Optimal end second within the clip window to cut dead tail at the end (right after the reaction finishes, removing any unrelated walking/menus/TV watching after the moment). Set equal to the original clip_end if there is no dead tail.',
    },
    problems: {
      type: 'array',
      items: { type: 'string' },
      description: 'Each claim in the title/caption/description that the frames do NOT show (exaggerated or invented), in pt-BR. Empty if everything is supported.',
    },
    accurate: { type: 'boolean', description: 'true only if every claim is clearly supported by the frames/facts' },
    hook_caption: { type: 'string', description: 'Corrected on-screen caption (same style, max 40 chars), or the original if accurate' },
    title: { type: 'string', description: 'Corrected title (same viral style: name first, caps, max 70 chars), or the original if accurate' },
    description: { type: 'string', description: 'Corrected description, or the original if accurate' },
  },
  required: [
    'approved',
    'verified_virality_score',
    'rejection_reason',
    'trimmed_clip_start',
    'trimmed_clip_end',
    'problems',
    'accurate',
    'hook_caption',
    'title',
    'description',
  ],
  additionalProperties: false,
};

/**
 * Independent 2nd-stage Vision Gate + Fact-Checker:
 * Inspects 8-12 frames spread across the chosen clip `[clip_start..clip_end]`:
 *  1. Rejects random cuts, normal walking/driving with no payoff, or clips padded with dead air.
 *  2. Auto-trims dead lead-in / dead tail (`trimmed_clip_start`, `trimmed_clip_end`).
 *  3. Fact-checks and corrects the title, burned-in hook caption, and description against the actual frames.
 */
export const factCheckSEO = async (
  seo: SEOMetadata,
  context: {
    channel: string;
    frames: { second: number; path: string }[];
    moment?: Pick<ExtractClipDecision, 'what_happened'> &
      Partial<Pick<ExtractClipDecision, 'streamer_reaction' | 'chat_reaction' | 'clip_start' | 'clip_end'>>;
  }
): Promise<ClipQualityCheckResult> => {
  if (!context.frames.length) {
    return {
      seo,
      problems: [],
      approved: false,
      verifiedViralityScore: 1,
      rejectionReason: 'No frames available for vision verification',
    };
  }
  const origStart = context.moment?.clip_start ?? context.frames[0].second;
  const origEnd = context.moment?.clip_end ?? context.frames[context.frames.length - 1].second;
  const prompt = [
    `You are a strict Quality Control & Fact-Checking Director for a Brazilian GTA 6 "cortes" channel.`,
    `Your job is to inspect EVERY attached frame of the proposed clip [${origStart}s..${origEnd}s] in chronological order and decide:`,
    `1) QUALITY GATE (approved & verified_virality_score):`,
    `   - Does this clip show a CLEAR, UNMISTAKABLE visual event that a stranger scrolling TikTok/Shorts will immediately understand and watch?`,
    `   - BEST CLIPS (score 8-10): streamer seeing/testing CAR MECHANICS (damage, towing, tuning, rust/paint, crash physics, interior), BOATS/WATERCRAFT (speedboats, boat fishing, swamp navigation), ANIMALS/WILDLIFE (alligators/jacarés, snakes, pelicans, marine life, animal attacks), crazy police chases/explosions/fails, or jaw-dropping GTA 6 world details + a clear reaction.`,
    `   - REJECT (approved=false, verified_virality_score <= 6): random cuts where nothing clear happens, normal walking/driving/flying with no payoff, just talking to an NPC with no funny/dramatic visual payoff, sitting in menus/map/pause screen, or clips where the streamer is barely reacting.`,
    `2) FIRST 3-SECONDS HOOK & DEAD AIR TRIMMING (trimmed_clip_start & trimmed_clip_end):`,
    `   - RETENTION CRITICAL: Inspect the first 2-3 seconds of the clip. If the opening frames show passive wandering, idle driving, or silence before the action, MOVE trimmed_clip_start forward so the final clip opens directly into the action, tension, or streamer vocal buildup!`,
    `   - Pull trimmed_clip_end back so the clip finishes right as the streamer reaction ends (no dead tail walking/menus). Keep total duration 18-38s.`,
    `3) FACT-CHECK METADATA (accurate, problems, hook_caption, title, description):`,
    `   - Compare every claim in the caption/title/description against the attached frames.`,
    `   - If any claim is exaggerated or not visible in the frames, rewrite it accurately in pt-BR keeping the viral style (STREAMER NAME IN CAPS first, "GTA 6", max 1 emoji, no swear words).`,
    `Frames of the proposed clip [${origStart}s..${origEnd}s]:`,
    context.frames.map((f) => `- second ${f.second}: ${f.path}`).join('\n'),
    context.moment?.what_happened ? `Initial picker notes: ${context.moment.what_happened}` : '',
    context.moment?.chat_reaction || context.moment?.streamer_reaction
      ? `Audio/chat evidence: chat="${context.moment.chat_reaction || '-'}" | streamer="${context.moment.streamer_reaction || '-'}"`
      : '',
    `PROPOSED METADATA TO VERIFY (pt-BR):\n- caption (burned on video): ${seo.hook_caption}\n- title: ${seo.title}\n- description: ${seo.description}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const r = await runClaudeJson<{
      approved: boolean;
      verified_virality_score: number;
      rejection_reason: string;
      trimmed_clip_start: number;
      trimmed_clip_end: number;
      problems: string[];
      accurate: boolean;
      hook_caption: string;
      title: string;
      description: string;
    }>(prompt, FACT_CHECK_SCHEMA, {
      tools: ['Read'],
      timeoutMs: 120_000,
    });

    const verifiedScore = Math.max(1, Math.min(10, Math.round(Number(r.verified_virality_score) || 5)));
    const approved = r.approved === true && verifiedScore >= config.minViralityScore;

    let fixedSeo = seo;
    if (!r.accurate || (r.problems && r.problems.length > 0)) {
      fixedSeo = normalizeSEO(
        {
          ...seo,
          hook_caption: String(r.hook_caption || seo.hook_caption).slice(0, 45),
          title: String(r.title || seo.title).slice(0, 95),
          description: String(r.description || seo.description),
        },
        context.channel,
        seo.game
      );
      log('WARN', 'FactCheck', `Corrected inaccurate text: ${(r.problems || []).join(' | ')}`, {
        before: seo.title,
        after: fixedSeo.title,
        caption: fixedSeo.hook_caption,
      });
    }

    return {
      seo: fixedSeo,
      problems: r.problems || [],
      approved,
      verifiedViralityScore: verifiedScore,
      rejectionReason: approved ? undefined : r.rejection_reason || `Failed vision quality gate (score ${verifiedScore}/10)`,
      trimmedStart: Number.isFinite(r.trimmed_clip_start) ? Number(r.trimmed_clip_start) : undefined,
      trimmedEnd: Number.isFinite(r.trimmed_clip_end) ? Number(r.trimmed_clip_end) : undefined,
    };
  } catch (err) {
    log('WARN', 'FactCheck', `Vision quality gate failed (${(err as Error).message}); rejecting unverified clip.`);
    return {
      seo,
      problems: [],
      approved: false,
      verifiedViralityScore: 1,
      rejectionReason: `Vision quality verification error: ${(err as Error).message}`,
    };
  }
};

/** Micro-topics: regex over the clip text -> tag suffix + search phrase (prefixed with the game) */
const MICRO_TOPICS: { re: RegExp; tags: string[]; searches: string[] }[] = [
  {
    re: /\b(carro|picape|caminhonete|motor|oficina|tunag|tunar|pintura|reboque|guincho|capô|porta-malas|dirig|volante|capot|batida)\w*/i,
    tags: ['carros', 'fisica'],
    searches: ['fisica dos carros', 'mecanica de carros', 'detalhes dos veiculos'],
  },
  {
    re: /\b(barco|lancha|jetski|jet ski|hidroavião|pesca|pescar|píer|cais|nadando|mangue|pântano|afund)\w*/i,
    tags: ['barcos', 'agua'],
    searches: ['barcos e lanchas', 'fisica da agua'],
  },
  {
    re: /\b(jacaré|crocodilo|cobra|pelicano|galinha|peixe|animal|animais|bicho|tubarão|cachorro|cavalo|iguana|pássaro)\w*/i,
    tags: ['animais'],
    searches: ['animais realistas', 'vida selvagem'],
  },
  {
    re: /\b(polícia|policia|estrelas|procurado|viatura|delegacia|fuga|perseguição|tiroteio)\w*/i,
    tags: ['policia', 'fuga'],
    searches: ['sistema de policia', 'perseguicao policial'],
  },
  {
    // Easter eggs: the most searched GTA 6 Shorts topic in Brazil (Nov 2026 research)
    re: /(easter ?egg|segredo|secreto|escondid|refer[êe]ncia)/i,
    tags: ['eastereggs', 'segredos'],
    searches: ['easter egg', 'segredos', 'detalhes escondidos'],
  },
  {
    re: /\b(npc|realismo|realista|detalhe|interação)\w*/i,
    tags: ['detalhes', 'npcs'],
    searches: ['detalhes realistas', 'interacoes com npcs'],
  },
];

/**
 * Derives micro-topic hashtags and long-tail search tags from the clip text, for the game
 * actually being played (GTA RP clips get #gtarp..., never #gta6...).
 */
export const buildSpecificSeoTags = (
  textBlob: string,
  channel: string,
  profile: GameProfile = gameProfile(config.targetCategory)
): { specificHashtags: string[]; searchTags: string[] } => {
  const kw = profile.keyword.toLowerCase();
  const ch = channel.toLowerCase();
  const specificHashtags: string[] = [];
  const searchTags: string[] = [`${ch} ${kw}`, `cortes ${ch}`, `${kw} gameplay pt br`];
  for (const topic of MICRO_TOPICS) {
    if (!topic.re.test(textBlob)) continue;
    specificHashtags.push(...topic.tags.map((t) => `#${profile.slug}${t}`));
    searchTags.push(...topic.searches.map((s) => `${kw} ${s}`));
  }
  if (profile.keyword === 'GTA 6' && /\b(jason|lucia)\b/i.test(textBlob)) {
    specificHashtags.push('#jasonelucia');
    searchTags.push('gta 6 jason e lucia');
  }
  return { specificHashtags: [...new Set(specificHashtags)], searchTags: [...new Set(searchTags)] };
};

/** Same tag no matter how it was written (#GTA6, gta6, # gta 6) */
const toHashtag = (h: string) => `#${String(h).replace(/^#+/, '').replace(/\s+/g, '').toLowerCase()}`;

/** Does a tag/phrase belong to another game than the one streamed? (e.g. #gta6 on a GTA RP clip) */
const isOtherGame = (text: string, profile: GameProfile): boolean => {
  const t = text.toLowerCase().replace(/[#\s]/g, '');
  const gta6 = /gta6|gtavi(?!i)/.test(t);
  if (profile.keyword === 'GTA 6') return false;
  return gta6 || (profile.keyword !== 'GTA RP' && /gtarp|gta5|gtav(?!i)/.test(t));
};

export const normalizeSEO = (parsed: Partial<SEOMetadata>, channel: string, game?: string): SEOMetadata => {
  const gameName = game || parsed.game || config.targetCategory;
  const profile = gameProfile(gameName);
  const kwUpper = profile.keyword.toUpperCase();
  const ch = channel.toLowerCase();

  const hook_caption = String(parsed.hook_caption || `${channel.toUpperCase()} NO ${kwUpper}`).slice(0, 45);
  const title = String(parsed.title || `${channel.toUpperCase()} NO ${kwUpper} 😱`).slice(0, 95);
  // Keyword lists / hashtag lines are removed: each platform formatter adds its own (platform-seo.ts)
  const description =
    cleanBody(String(parsed.description || '')) ||
    `@${channel} jogando ${profile.keyword} ao vivo na Twitch. Live na Twitch: @${channel}. Segue pra mais cortes!`;

  const rawSearchTags = Array.isArray(parsed.search_tags)
    ? parsed.search_tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean)
    : [];
  const { specificHashtags, searchTags: derived } = buildSpecificSeoTags(
    `${title} ${hook_caption} ${description} ${rawSearchTags.join(' ')}`,
    channel,
    profile
  );
  const search_tags = [...new Set([...rawSearchTags, ...derived])].filter((t) => !isOtherGame(t, profile)).slice(0, 15);

  // Priority order, because platforms keep only the first 3-5:
  // micro-topic -> streamer -> broad game tag -> BR niche -> model's other tags -> rest
  const modelTags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : []).map(toHashtag);
  const broad = profile.broadTags.map(toHashtag);
  const niche = profile.nicheTags.map(toHashtag);
  const micro = [...modelTags.filter((t) => t.startsWith(`#${profile.slug}`) && !broad.includes(t) && !niche.includes(t)), ...specificHashtags];
  const hashtags = [
    ...new Set([
      ...micro.slice(0, 1),
      `#${ch}`,
      broad[0],
      niche[0],
      ...micro.slice(1, 2),
      ...modelTags,
      ...broad.slice(1),
      ...niche.slice(1),
      '#cortesdelive',
    ]),
  ]
    .filter((t) => t.length > 1 && !FILLER_TAGS.has(t) && !isOtherGame(t, profile))
    .slice(0, 10);

  return { hook_caption, title, description, hashtags, search_tags, channel: ch, game: gameName };
};

/** Tags that only add noise (too broad to rank, and they use up the 3-5 visible slots) */
const FILLER_TAGS = new Set(['#fyp', '#foryou', '#foryoupage', '#viral', '#jogos', '#gameplay', '#gamesnotiktok', '#shorts', '#reels']);

