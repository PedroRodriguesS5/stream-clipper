import assert from 'assert/strict';
import { buildInterpretPrompt, heuristicPlan } from './setup/interpret.js';
import { emptyPreferences, memorySummary, rankSuggestions, remember } from './setup/preferences.js';
import { applySession, ClipSession } from './setup/session.js';
import { isRunnable, validatePlan } from './setup/validate.js';
import { config } from './utils/config.js';

/**
 * Offline checks of the startup wizard logic (no Twitch, no AI).
 *   npm run test:setup
 */
let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
};
const known = ['Grand Theft Auto VI', 'Minecraft', 'VALORANT', 'Just Chatting'];

await check('heuristic: game names, GTA 6 alias and content words', () => {
  const p = heuristicPlan('quero fails engraçados de minecraft e gta 6', known, 'PT');
  assert.deepEqual(p.categories.sort(), ['Grand Theft Auto VI', 'Minecraft']);
  assert.deepEqual(p.contentTypes, ['gameplay_fail_funny']);
});
await check('heuristic: links and @handles become channels; "só" = only those', () => {
  const p = heuristicPlan('só as lives do twitch.tv/Cellbit e @alanzoka', known, 'PT');
  assert.deepEqual(p.channels, ['cellbit', 'alanzoka']);
  assert.equal(p.onlyChannels, true);
});
await check('heuristic: recorded videos are flagged as not supported', () => {
  assert.ok(heuristicPlan('https://www.twitch.tv/videos/123456', known, 'PT').notSupported);
  assert.ok(heuristicPlan('https://youtu.be/abc', known, 'PT').notSupported);
});

const resolvers = {
  category: async (n: string) => ({ minecraft: 'Minecraft', 'gta 6': 'Grand Theft Auto VI', valorant: 'VALORANT' } as Record<string, string>)[n.toLowerCase()] ?? null,
  channel: async (t: string) => (t === 'cellbit' ? { login: 'cellbit', isLive: true, category: 'Grand Theft Auto VI' } : null),
};
const draft = (o: Partial<Parameters<typeof validatePlan>[0]> = {}) => ({
  categories: [], channels: [], onlyChannels: false, language: 'PT', contentTypes: [], minViewers: null, summary: '', notSupported: '', ...o,
});

await check('validate: names fixed to official spelling, unknown dropped with a note', async () => {
  const { session, notes } = await validatePlan(draft({ categories: ['minecraft', 'Jogo Inventado'], channels: ['cellbit', 'naoexiste'] }), 'x', resolvers);
  assert.deepEqual(session.categories, ['Minecraft']);
  assert.deepEqual(session.channels, ['cellbit']);
  assert.ok(notes.some((n) => n.includes('Jogo Inventado')));
  assert.ok(notes.some((n) => n.includes('naoexiste')));
  assert.equal(session.onlyChannels, false);
});
await check('validate: channels without categories = only those channels', async () => {
  const { session } = await validatePlan(draft({ channels: ['cellbit'] }), 'x', resolvers);
  assert.equal(session.onlyChannels, true);
  assert.ok(isRunnable(session));
});
await check('validate: nothing recognized is not runnable', async () => {
  const { session } = await validatePlan(draft({ categories: ['Jogo Inventado'] }), 'x', resolvers);
  assert.ok(!isRunnable(session));
});

const session = (o: Partial<ClipSession> = {}): ClipSession => ({
  request: 'fails de minecraft', categories: ['Minecraft'], channels: [], onlyChannels: false, language: 'PT',
  contentTypes: ['gameplay_fail_funny'], summary: '', createdAt: '2026-11-20T00:00:00Z', ...o,
});

await check('memory: choices counted, history newest first, capped at 50', () => {
  let p = emptyPreferences();
  for (let i = 0; i < 55; i++) p = remember(p, session({ request: `r${i}` }));
  p = remember(p, session({ categories: ['VALORANT'], channels: ['cellbit'], request: 'last' }));
  assert.equal(p.history.length, 50);
  assert.equal(p.history[0].request, 'last');
  assert.equal(p.counts.categories.Minecraft, 55);
  assert.equal(p.counts.channels.cellbit, 1);
  assert.ok(memorySummary(p).includes('Minecraft (55x)'));
});
await check('suggestions: favourites + results + trending, favourites first', () => {
  const p = remember(remember(emptyPreferences(), session()), session());
  const s = rankSuggestions(p, [{ category: 'Grand Theft Auto VI', viewers: 100000, streams: 40 }, { category: 'Minecraft', viewers: 5000, streams: 10 }], { Minecraft: { views: 6000, videos: 10 } });
  assert.equal(s[0].category, 'Minecraft');
  assert.ok(s[0].reasons.some((r) => r.includes('2x')));
  assert.ok(s.some((x) => x.category === 'Grand Theft Auto VI'));
});
await check('prompt: includes memory, trending and the previous plan when adjusting', () => {
  const prompt = buildInterpretPrompt('inclua valorant', { language: 'PT', trending: ['Minecraft'], memory: 'Favourite categories: Minecraft (3x)', previous: draft({ categories: ['Minecraft'] }) });
  assert.ok(prompt.includes('Minecraft (3x)') && prompt.includes('ADJUSTING') && prompt.includes('inclua valorant'));
});

await check('apply: session drives categories, channels, language and content focus', () => {
  applySession(session({ categories: ['Minecraft', 'VALORANT'], channels: ['Cellbit'], minViewers: 50, language: 'en' }));
  assert.deepEqual(config.targetCategories, ['Minecraft', 'VALORANT']);
  assert.equal(config.targetCategory, 'Minecraft');
  assert.equal(config.streamLanguage, 'EN');
  assert.equal(config.minViewers, 50);
  assert.deepEqual(config.focusChannels, ['cellbit']);
  assert.equal(config.onlyFocusChannels, false);
  assert.deepEqual(config.contentFocus?.types, ['gameplay_fail_funny']);
  applySession(session({ categories: [], channels: ['cellbit'], onlyChannels: true, contentTypes: [] }));
  assert.deepEqual(config.targetCategories, ['any']);
  assert.equal(config.onlyFocusChannels, true);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall setup checks passed');
process.exit(failures ? 1 : 0);
