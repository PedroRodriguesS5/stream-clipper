import assert from 'assert/strict';
import { normalizeSEO } from './ai/ai.js';
import { chunkWords, cleanSegments, fitWordsToSegment, looksEnglish } from './video/subtitles.js';
import { maskProfanity } from './compliance/profanity.js';
import { formatInstagramCaption, formatTikTokCaption, formatYouTube, LIMITS, youtubeTagsLength } from './publishing/platform-seo.js';

/**
 * Offline checks of the per-platform SEO rules (no Claude, no uploads).
 *   npm run test:seo
 */
const hashtagsIn = (s: string) => s.match(/#[\p{L}\p{N}_]+/gu) || [];
let failures = 0;
const check = (name: string, fn: () => void) => {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.log(`  FAIL ${name}: ${(e as Error).message}`);
  }
};

// A model answer with every old bad habit: GTA 6 tags on GTA RP, keyword list, too many tags
const gtaRp = normalizeSEO(
  {
    hook_caption: 'FUGIU DA POLÍCIA DE MOTO NO GTA RP 🏍️',
    title: 'PAULINHO FUGIU DA POLÍCIA DE MOTO NO GTA RP 💀',
    description:
      'No GTA RP, @paulinhooloko fugiu da polícia de moto pela avenida.\nO chat foi à loucura.\n\nTags de busca: gta 6 fuga, gta rp fuga, gta 6 moto\n#gta6 #gtarp',
    hashtags: ['#gta6', '#gtavi', '#gta6brasil', '#gtarpfuga', '#fyp', '#viral', '#jogos', '#gtarp', '#paulinhooloko', '#a', '#b', '#c', '#d'],
    search_tags: ['gta 6 fuga de moto', 'gta rp fuga da policia', 'paulinhooloko gta rp'],
  },
  'paulinhooloko',
  'Grand Theft Auto V'
);

check('GTA RP clip has no GTA 6 hashtags or search tags', () => {
  const all = [...gtaRp.hashtags, ...(gtaRp.search_tags || [])].join(' ').toLowerCase();
  assert.ok(!/gta ?6|gtavi\b/.test(all), all);
  assert.ok(gtaRp.hashtags.includes('#gtarp'));
});
check('filler tags removed', () => {
  for (const t of ['#fyp', '#viral', '#jogos']) assert.ok(!gtaRp.hashtags.includes(t), t);
});
check('description has no keyword list or hashtag line', () => {
  assert.ok(!/tags de busca/i.test(gtaRp.description), gtaRp.description);
  assert.equal(hashtagsIn(gtaRp.description).length, 0);
});
check('streamer + game carried for formatters', () => {
  assert.equal(gtaRp.channel, 'paulinhooloko');
  assert.equal(gtaRp.game, 'Grand Theft Auto V');
});

const yt = formatYouTube(gtaRp);
check('YouTube: 4 hashtags + #Shorts, under the 15 limit', () => {
  const tags = hashtagsIn(yt.description);
  assert.equal(tags.length, 5, tags.join(' '));
  assert.equal(tags.at(-1), '#Shorts');
});
check('YouTube: tags field <= 500 chars counted like YouTube', () => {
  assert.ok(youtubeTagsLength(yt.tags) <= LIMITS.youtube.tagsChars, String(youtubeTagsLength(yt.tags)));
  assert.ok(yt.tags.includes('paulinhooloko'));
});
check('YouTube: title <= 100, credit link present, no keyword list', () => {
  assert.ok(yt.title.length <= 100);
  assert.ok(/twitch\.tv\/paulinhooloko/.test(yt.description));
  assert.ok(!/tags de busca/i.test(yt.description));
});

const tt = formatTikTokCaption(gtaRp);
check('TikTok: <= 2200 chars, 3-5 hashtags at the end, title first', () => {
  assert.ok(tt.length <= LIMITS.tiktok.caption);
  const tags = hashtagsIn(tt);
  assert.ok(tags.length >= 3 && tags.length <= 5, tags.join(' '));
  assert.ok(tt.startsWith(gtaRp.title));
  assert.ok(/(#[\p{L}\p{N}_]+\s*)+$/u.test(tt));
  assert.ok(!tt.includes(' | '));
});

const ig = formatInstagramCaption(gtaRp);
check('Instagram: <= 2200 chars, <= 5 hashtags, no @mentions of strangers', () => {
  assert.ok(ig.length <= LIMITS.instagram.caption);
  assert.ok(hashtagsIn(ig).length <= 5);
  assert.ok(!/@paulinhooloko/.test(ig), ig);
  assert.ok(/twitch\.tv\/paulinhooloko/.test(ig));
});

// GTA 6 still gets its own vocabulary, micro-topic first
const gta6 = normalizeSEO(
  { title: 'ALANZOKA CAPOTOU A CAMINHONETE NO GTA 6 💀', description: 'No GTA 6, @alanzoka capotou a caminhonete na estrada.', hashtags: [] },
  'alanzoka',
  'Grand Theft Auto VI'
);
check('GTA 6: micro-topic tag first, streamer and #gta6 in the first 3', () => {
  assert.equal(gta6.hashtags[0], '#gta6carros', gta6.hashtags.join(' '));
  assert.ok(gta6.hashtags.slice(0, 3).includes('#alanzoka'));
  assert.ok(gta6.hashtags.slice(0, 4).includes('#gta6'));
});

// Easter eggs get the searched tags/phrases, only when the clip is about one
const egg = normalizeSEO({ title: 'ALANZOKA ACHOU UM EASTER EGG NO GTA 6 😱', description: 'No GTA 6, @alanzoka achou uma referência escondida ao GTA San Andreas.', hashtags: [] }, 'alanzoka', 'Grand Theft Auto VI');
check('easter egg: #gta6eastereggs first and "gta 6 easter egg" in search tags', () => {
  assert.equal(egg.hashtags[0], '#gta6eastereggs', egg.hashtags.join(' '));
  assert.ok(egg.search_tags?.includes('gta 6 easter egg'));
});
check('no easter egg tags on an ordinary clip', () => {
  assert.ok(!gta6.hashtags.some((t) => t.includes('easter')) && !gta6.search_tags?.some((t) => t.includes('easter')));
});

// Another game: nothing GTA at all
const valorant = normalizeSEO({ title: 'XAROLA DEU ACE NO VALORANT 😱', description: 'xarola deu ace.', hashtags: ['#gta6'] }, 'xarola', 'VALORANT');
check('VALORANT: no GTA tags, game tag present', () => {
  assert.ok(!valorant.hashtags.some((t) => t.includes('gta')), valorant.hashtags.join(' '));
  assert.ok(valorant.hashtags.includes('#valorant'));
});

// Very long description is cut, not overflowing
const long = normalizeSEO({ title: 'T NO GTA 6', description: 'palavra '.repeat(800), hashtags: [] }, 'x', 'Grand Theft Auto VI');
check('long description fits every platform', () => {
  assert.ok(formatTikTokCaption(long).length <= LIMITS.tiktok.caption);
  assert.ok(formatInstagramCaption(long).length <= LIMITS.instagram.caption);
  assert.ok(formatYouTube(long).description.length <= 5000);
});

// --- Whisper subtitles (pure logic, no Whisper needed) ---
const w = (text: string, start: number, end: number, p = 0.9) => ({ text, start, end, p });
check('subtitles: VAD-compressed word times are moved into the segment', () => {
  const seg = fitWordsToSegment([w('Eu', 2.06, 2.1), w('acho', 2.06, 2.2), w('mais...', 2.32, 2.48)], 'Eu acho mais...', 5.47, 7.58);
  assert.ok(Math.abs(seg.words[0].start - 5.47) < 0.01 && Math.abs(seg.words[2].end - 7.58) < 0.01, JSON.stringify(seg.words));
});
check('subtitles: words sharing one timestamp still get readable chunks', () => {
  const seg = fitWordsToSegment([w('Que', 1.4, 1.4), w('que', 1.4, 1.4), w('é', 1.4, 1.4), w('isso', 1.4, 1.4)], 'Que que é isso', 1.4, 2.4);
  const chunks = chunkWords([seg]);
  assert.equal(chunks.map((c) => c.text).join(' '), 'Que que é isso');
  for (const c of chunks) assert.ok(c.end - c.start >= 0.12, JSON.stringify(chunks));
  for (let i = 1; i < chunks.length; i++) assert.ok(chunks[i].start >= chunks[i - 1].end - 1e-9);
});
check('subtitles: English NPC dialogue and hallucinations dropped', () => {
  assert.ok(looksEnglish('You ever meet a guy named Jimmy over at the hangar?'));
  assert.ok(!looksEnglish('Que que é isso que eu peguei?'));
  const kept = cleanSegments([
    { text: 'Legendas pela comunidade Amara.org', start: 0, end: 1, words: [w('Legendas', 0, 1)] },
    { text: 'Ixi, os cara nem tá com', start: 1, end: 2, words: [w('Ixi,', 1, 1.2), w('os', 1.2, 1.4)] },
    { text: 'Ixi, os cara nem tá com', start: 2, end: 3, words: [w('Ixi,', 2, 2.2), w('os', 2.2, 2.4)] },
  ]);
  assert.equal(kept.length, 1);
});
check('subtitles: profanity masked with one asterisk', () => {
  assert.equal(maskProfanity('que porra é essa, fuck you'), 'que p*rra é essa, f*ck you');
  assert.equal(maskProfanity('é muito pica, foda demais'), 'é muito p*ca, f*da demais');
  assert.equal(maskProfanity('Caralho! krl'), 'C*ralho! k*l');
  assert.equal(maskProfanity('computador cuidado picada'), 'computador cuidado picada');
});

// --- Clip retention (disk cleanup) ---
{
  const { clipsToDelete } = await import('./utils/clip-retention.js');
  const now = Date.parse('2026-11-20T12:00:00Z');
  const f = (n: string, ageH: number) => ({ path: `/out/${n}.mp4`, mtimeMs: now - ageH * 3600_000 });
  const files = [f('a', 1), f('b', 1), f('c', 1), f('d', 30), f('e', 30), f('g', 1)];
  const queue = [
    { clipPath: '/out/a.mp4', status: 'posted' }, { clipPath: '/out/a.mp4', status: 'posted' }, // done everywhere
    { clipPath: '/out/b.mp4', status: 'posted' }, { clipPath: '/out/b.mp4', status: 'pending' }, // TikTok still waiting
    { clipPath: '/out/c.mp4', status: 'posted' }, { clipPath: '/out/c.mp4', status: 'stale' }, // posted once, other expired
    { clipPath: '/out/d.mp4', status: 'stale' }, // never posted, 30 h old
    { clipPath: '/out/g.mp4', status: 'posting' }, // uploading right now
  ];
  const del = (rules: { deleteAfterPost: boolean; unpostedMaxAgeHours: number }) =>
    clipsToDelete(files, queue, rules, now).map((x) => `${x.path.slice(5, 6)}:${x.reason}`).sort().join(' ');
  check('cleanup: default deletes only finished posted clips (a, c)', () =>
    assert.equal(del({ deleteAfterPost: true, unpostedMaxAgeHours: 0 }), 'a:posted c:posted'));
  check('cleanup: unposted option also removes old never-posted clips (d, e), never pending/posting ones', () =>
    assert.equal(del({ deleteAfterPost: true, unpostedMaxAgeHours: 24 }), 'a:posted c:posted d:unposted e:unposted'));
  check('cleanup: DELETE_CLIPS_AFTER_POST=false keeps everything', () =>
    assert.equal(del({ deleteAfterPost: false, unpostedMaxAgeHours: 0 }), ''));
}

{
  const { bufferFilesToDelete } = await import('./utils/clip-retention.js');
  const now = Date.parse('2026-11-20T12:00:00Z');
  const ago = (min: number) => now - min * 60_000;
  const entries = [
    { rel: 'live/segment_000.mp4', mtimeMs: ago(1) }, { rel: 'live/segment_001.mp4', mtimeMs: ago(6) }, { rel: 'live/concat_list.txt', mtimeMs: ago(6) },
    { rel: 'gone/segment_000.mp4', mtimeMs: ago(90) }, { rel: 'gone/concat_list.txt', mtimeMs: ago(95) },
    { rel: 'gone/snapshot_1.mp4', mtimeMs: ago(90) }, // a queued job may still need it
    { rel: 'old/snapshot_2_moment_0_5s.jpg', mtimeMs: ago(60 * 30) }, { rel: 'test_stream_buffer.mp4', mtimeMs: ago(60 * 30) },
  ];
  const del = bufferFilesToDelete(entries, now).sort().join(' ');
  check('buffer: active channel untouched, idle channel segments deleted', () =>
    assert.equal(del, 'gone/concat_list.txt gone/segment_000.mp4 old/snapshot_2_moment_0_5s.jpg test_stream_buffer.mp4'));
  check('buffer: recent snapshot of a stopped channel kept for its queued job', () => assert.ok(!del.includes('snapshot_1.mp4')));
}

{
  const { carryForward } = await import('./metrics/collect-metrics.js');
  const base = { platform: 'youtube' as const, channel: 'x', postedAt: '', ageHours: 5, title: 't', caption: 'c' };
  const prev = [{ ...base, clip: 'a.mp4', views: 900, status: 'public' }, { ...base, clip: 'b.mp4', views: 50, status: 'public' }];
  const fresh = [{ ...base, clip: 'a.mp4', views: undefined, status: 'fetch failed' }, { ...base, clip: 'b.mp4', views: 70, status: 'public' }, { ...base, clip: 'c.mp4', views: undefined }];
  const r = carryForward(fresh as any, prev as any, '2026-11-22T06:00:00Z');
  check('metrics: an unread video keeps its last known views', () => {
    assert.equal(r[0].views, 900);
    assert.equal(r[0].status, 'public');
    assert.equal(r[0].carriedFrom, '2026-11-22T06:00:00Z');
  });
  check('metrics: fresh numbers win; new videos stay unread', () => {
    assert.equal(r[1].views, 70);
    assert.equal(r[1].carriedFrom, undefined);
    assert.equal(r[2].views, undefined);
  });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall SEO checks passed');
process.exit(failures ? 1 : 0);
