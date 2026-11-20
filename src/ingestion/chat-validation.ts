/**
 * Chat validation that adapts to the channel size.
 *
 * A fixed "20 messages / 10 s" rule fires all the time on big streamers (chat is always fast)
 * and never on small creators. Here a spike must beat the channel's OWN recent baseline,
 * come from enough different people, and actually look like hype (KKKK, CLIPA, emote spam...).
 */

export type ChatTier = 'small' | 'normal' | 'big' | 'huge';

export interface TierRules {
  windowSeconds: number;
  /** absolute minimum of valid messages in the window */
  minMessages: number;
  /** distinct chatters in the window */
  minUniqueChatters: number;
  /** window count must be >= baseline-per-window x multiplier */
  baselineMultiplier: number;
  /** share of window messages that look like hype (0-1) */
  minHypeRatio: number;
  /** seconds of chat to observe before the first spike can fire */
  warmupSeconds: number;
}

export const TIER_RULES: Record<ChatTier, TierRules> = {
  // < 100 viewers: few messages, so trust distinct people + hype words more than volume
  small: { windowSeconds: 20, minMessages: 5, minUniqueChatters: 3, baselineMultiplier: 3, minHypeRatio: 0.3, warmupSeconds: 60 },
  // 100 - 2000 viewers
  normal: { windowSeconds: 10, minMessages: 12, minUniqueChatters: 6, baselineMultiplier: 2.5, minHypeRatio: 0.35, warmupSeconds: 90 },
  // 2000 - 50000 viewers (cellbit, ricfazeres...): busy chat, but a 14k channel only does ~2 msgs/s,
  // so the floor is lower; the jump over THIS channel's baseline does the filtering
  big: { windowSeconds: 10, minMessages: 15, minUniqueChatters: 10, baselineMultiplier: 1.8, minHypeRatio: 0.35, warmupSeconds: 120 },
  // > 50000 viewers (alanzoka): chat never stops, so require a big jump over baseline and many people
  huge: { windowSeconds: 8, minMessages: 40, minUniqueChatters: 20, baselineMultiplier: 2, minHypeRatio: 0.4, warmupSeconds: 120 },
};

export const tierForViewers = (viewers: number): ChatTier =>
  viewers >= 50_000 ? 'huge' : viewers >= 2000 ? 'big' : viewers >= 100 ? 'normal' : 'small';

const BOT_NAMES = new Set([
  'nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot', 'botisimo',
  'sery_bot', 'soundalerts', 'pokemoncommunitygame', 'commanderroot', 'kofistreambot',
  'blerp', 'own3d', 'streamcaptainbot', 'creatisbot', 'frostytoolsdotcom', 'lolrankbot',
]);

/** Portuguese (BR) + Twitch-wide hype signals */
const HYPE_PATTERNS: RegExp[] = [
  /k{4,}/i, // kkkk
  /(ha|he|hu|rs){3,}/i,
  /\b(mds|meu deus|caralho|crl|pqp|porra|nossa|eita|vish|caraca|caramba|socorro|rachei|morri)\b/i,
  /\b(clipa|clip|clipe|clipou|cortem|corta isso)\b/i,
  /n(ã|a)o acredito|que isso|q isso|ele (fez|conseguiu)|absurdo|insano|monstro|lend(á|a)rio/i,
  /\b(kekw|omegalul|lul|lulw|pog|pogchamp|poggers|pogu|monkas|pepelaugh|aware|icant|xdd|catjam|ez)\b/i,
  /([a-z])\1{4,}/i, // AAAAAA, NÃÃÃÃÃO
  /[!?]{3,}/,
];

export interface ChatMessageInput {
  username: string;
  text: string;
  /** tmi.js emotes tag: { emoteId: ["start-end", ...] } */
  emotes?: Record<string, string[]> | null;
  isBroadcaster?: boolean;
}

export interface MessageVerdict {
  valid: boolean;
  hype: boolean;
  reason?: string;
}

const emoteCoverage = (text: string, emotes?: Record<string, string[]> | null): number => {
  if (!emotes || !text.length) return 0;
  let chars = 0;
  for (const ranges of Object.values(emotes)) {
    for (const r of ranges) {
      const [s, e] = r.split('-').map(Number);
      chars += e - s + 1;
    }
  }
  return chars / text.replace(/\s/g, '').length;
};

export const classifyMessage = (msg: ChatMessageInput): MessageVerdict => {
  const user = msg.username.toLowerCase();
  const text = msg.text.trim();
  if (!text) return { valid: false, hype: false, reason: 'empty' };
  if (BOT_NAMES.has(user) || /bot$/i.test(user)) return { valid: false, hype: false, reason: 'bot' };
  if (text.startsWith('!')) return { valid: false, hype: false, reason: 'command' };
  if (/https?:\/\/|www\./i.test(text)) return { valid: false, hype: false, reason: 'link' };
  // Counting games ("3138", "3139"...) and pure numbers/punctuation are not reactions
  if (/^[\d\s.,:/+-]+$/.test(text)) return { valid: false, hype: false, reason: 'number' };

  const emoteOnly = emoteCoverage(text, msg.emotes) >= 0.8;
  const capsShout = text.length >= 5 && text === text.toUpperCase() && /[A-ZÀ-Ú]{4,}/.test(text);
  const hype = emoteOnly || capsShout || HYPE_PATTERNS.some((p) => p.test(text));
  return { valid: true, hype };
};

const MAX_PER_USER = 2;

interface Entry {
  t: number;
  user: string;
  text: string;
  hype: boolean;
}

export interface SpikeCheck {
  isSpike: boolean;
  count: number;
  uniqueChatters: number;
  hypeRatio: number;
  baselinePerWindow: number;
  required: number;
  reason: string;
}

/**
 * Keeps ~5 minutes of valid messages and decides if the current window is a real hype spike.
 */
export class ChatSpikeDetector {
  private entries: Entry[] = [];
  private readonly startedAt: number;
  private readonly baselineSeconds = 300;

  constructor(public readonly rules: TierRules, now = Date.now()) {
    this.startedAt = now;
  }

  /** Returns false if the message was ignored (bot, command, duplicate...) */
  public add(msg: ChatMessageInput, now = Date.now()): MessageVerdict {
    const verdict = classifyMessage(msg);
    if (!verdict.valid) return verdict;

    const user = msg.username.toLowerCase();
    const norm = msg.text.trim().toLowerCase();
    const windowStart = now - this.rules.windowSeconds * 1000;
    // Same person repeating the same thing inside the window counts once (copy-paste spam)
    if (this.entries.some((e) => e.t >= windowStart && e.user === user && e.text === norm)) {
      return { valid: false, hype: verdict.hype, reason: 'duplicate' };
    }

    this.entries.push({ t: now, user, text: norm, hype: verdict.hype });
    const cutoff = now - this.baselineSeconds * 1000;
    while (this.entries.length && this.entries[0].t < cutoff) this.entries.shift();
    return verdict;
  }

  public check(now = Date.now()): SpikeCheck {
    const r = this.rules;
    const windowMs = r.windowSeconds * 1000;
    const windowStart = now - windowMs;
    const inWindow = this.entries.filter((e) => e.t >= windowStart);
    const before = this.entries.filter((e) => e.t < windowStart);

    const observedMs = Math.max(1, Math.min(windowStart - this.startedAt, this.baselineSeconds * 1000 - windowMs));
    const baselinePerWindow = observedMs > 0 ? (before.length / observedMs) * windowMs : 0;
    const required = Math.ceil(Math.max(r.minMessages, baselinePerWindow * r.baselineMultiplier));
    // One person can add at most MAX_PER_USER messages to the window (stops a single spammer)
    const perUser = new Map<string, number>();
    const counted = inWindow.filter((e) => {
      const n = (perUser.get(e.user) || 0) + 1;
      perUser.set(e.user, n);
      return n <= MAX_PER_USER;
    });
    const count = counted.length;
    const uniqueChatters = perUser.size;
    const hypeRatio = count ? counted.filter((e) => e.hype).length / count : 0;
    const hypeChatters = new Set(counted.filter((e) => e.hype).map((e) => e.user)).size;
    const minHypeChatters = Math.max(2, Math.ceil(r.minUniqueChatters * 0.6));

    const fail = (reason: string): SpikeCheck => ({
      isSpike: false, count, uniqueChatters, hypeRatio, baselinePerWindow, required, reason,
    });

    if (now - this.startedAt < r.warmupSeconds * 1000) return fail('warming up (learning normal chat speed)');
    if (count < required) return fail(`volume ${count} < ${required}`);
    if (uniqueChatters < r.minUniqueChatters) return fail(`only ${uniqueChatters} distinct chatters`);
    if (hypeChatters < minHypeChatters) return fail(`only ${hypeChatters} people reacting (need ${minHypeChatters})`);
    if (hypeRatio < r.minHypeRatio) return fail(`hype ratio ${(hypeRatio * 100).toFixed(0)}% too low`);

    return {
      isSpike: true, count, uniqueChatters, hypeRatio, baselinePerWindow, required,
      reason: `${count} msgs (needed ${required}, baseline ${baselinePerWindow.toFixed(1)}), ${uniqueChatters} chatters, ${(hypeRatio * 100).toFixed(0)}% hype`,
    };
  }
}
