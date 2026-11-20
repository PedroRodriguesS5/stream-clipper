import fs from 'fs/promises';
import path from 'path';
import { MOMENT_TYPES, MomentType } from '../ai/ai.js';
import { config } from '../utils/config.js';

/**
 * What the user asked to clip in this run (chosen in the startup wizard, saved so unattended
 * restarts keep the same choice). Applied on top of .env.
 */
export interface ClipSession {
  /** The user's own words, e.g. "fails engraçados de minecraft" */
  request: string;
  /** Exact Twitch category names (validated) */
  categories: string[];
  /** Twitch logins to follow (watched whenever live, any category) */
  channels: string[];
  /** true = only these channels, no category discovery */
  onlyChannels: boolean;
  /** Twitch broadcaster language code, e.g. PT */
  language: string;
  /** Moment types the user prefers (empty = any good moment) */
  contentTypes: MomentType[];
  minViewers?: number;
  /** One-line plan shown to the user, in Portuguese */
  summary: string;
  createdAt: string;
}

export const SESSION_PATH = () => path.join(path.dirname(config.outputDir), 'data', 'session.json');

export const saveSession = async (s: ClipSession, file = SESSION_PATH()) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(s, null, 2) + '\n');
};

export const loadSession = async (file = SESSION_PATH()): Promise<ClipSession | null> => {
  try {
    const s = JSON.parse(await fs.readFile(file, 'utf-8')) as ClipSession;
    return s && Array.isArray(s.categories) && Array.isArray(s.channels) ? s : null;
  } catch {
    return null;
  }
};

/** Human description of the content types, for the moment-picker prompt and the UI */
export const MOMENT_LABELS: Record<MomentType, string> = {
  gameplay_chaos: 'caos (perseguição, batida, explosão, tiroteio)',
  gameplay_fail_funny: 'fails engraçados (física, bugs, mortes ridículas)',
  gameplay_skill: 'jogadas de habilidade (clutch, manobra impossível)',
  gameplay_discovery: 'descobertas (mecânicas, lugares, easter eggs)',
  epic_scene: 'cenas épicas / visuais bonitos',
  surprise_reaction: 'reações de surpresa',
  emotional_reaction: 'reações fortes (susto, emoção, raiva, hype)',
  story_reaction: 'reações à história / cutscenes',
  streamer_moment: 'o streamer como conteúdo (piada, desabafo, conversa)',
  waiting_or_menu: 'espera / menus',
  nothing: 'nada',
};

/** Writes the session into the running config (categories, language, channels, focus) */
export const applySession = (s: ClipSession) => {
  if (s.onlyChannels && s.channels.length) {
    config.targetCategories = ['any'];
  } else if (s.categories.length) {
    config.targetCategories = s.categories;
  }
  config.targetCategory = s.categories[0] || config.targetCategories[0];
  if (s.language) config.streamLanguage = s.language.toUpperCase();
  if (typeof s.minViewers === 'number' && s.minViewers >= 0) config.minViewers = s.minViewers;
  config.focusChannels = s.channels.map((c) => c.toLowerCase());
  config.onlyFocusChannels = s.onlyChannels && s.channels.length > 0;
  const types = s.contentTypes.filter((t) => (MOMENT_TYPES as readonly string[]).includes(t) && t !== 'nothing' && t !== 'waiting_or_menu');
  config.contentFocus = types.length || s.request ? { request: s.request, types } : null;
};
