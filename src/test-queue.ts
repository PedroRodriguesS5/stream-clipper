import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { log } from './utils/logger.js';

/**
 * Offline check of the post-queue ordering/spacing logic with fake uploads.
 * Uses a temporary folder (POST_QUEUE_DIR), never the live data/post-queue.json,
 * so it is safe to run while the clipper is running.
 *   npm run test:queue
 */
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'clipper-queue-test-'));
process.env.POST_QUEUE_DIR = DIR;
// Never touch real accounts: point every uploader at empty paths inside the temp dir
process.env.YOUTUBE_COOKIES_PATH = path.join(DIR, 'no-youtube-cookies.json');
process.env.YOUTUBE_PROFILE_DIR = path.join(DIR, 'no-youtube-profile');
process.env.TIKTOK_COOKIES_PATH = path.join(DIR, 'no-tiktok-cookies.json');
process.env.TIKTOK_SESSION_COOKIE = '';
process.env.INSTAGRAM_ENABLED = 'false';
process.env.YOUTUBE_UPLOAD_METHOD = 'browser';
// The queue also runs the disk cleanup: keep it away from the real buffer/ and output/
process.env.BUFFER_DIR = path.join(DIR, 'buffer');
process.env.OUTPUT_DIR = path.join(DIR, 'output');
const QUEUE = path.join(DIR, 'post-queue.json');
const STATE = path.join(DIR, 'post-state.json');

const run = async () => {
  process.env.MIN_MINUTES_BETWEEN_POSTS = '10';
  process.env.MAX_QUEUE_AGE_HOURS = '3';
  // Ordering/spacing checks below: open all day, 10-min slots (1440 min / 144), no viral bar
  process.env.POST_HOURS = '0-24';
  process.env.POSTS_PER_DAY_MAX = '144';
  process.env.POSTS_PER_DAY_MIN = '0';
  process.env.MIN_POST_SCORE = '1';
  // Per-platform values from a local .env would override the generic ones above
  for (const P of ['YOUTUBE', 'TIKTOK', 'INSTAGRAM']) {
    process.env[`POSTS_PER_DAY_MAX_${P}`] = '144';
    process.env[`POSTS_PER_DAY_MIN_${P}`] = '0';
  }
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const seo = { hook_caption: 'X', title: 'T', description: 'D', hashtags: [] };
  const item = (id: string, channel: string, priority: number, createdAgoMin: number, notBeforeInMin = 0) => ({
    id, channel, platform: 'youtube', clipPath: '/nonexistent.mp4', seo, priority,
    createdAt: iso(now - createdAgoMin * 60_000),
    notBefore: iso(notBeforeInMin ? now + notBeforeInMin * 60_000 : now - createdAgoMin * 60_000),
    status: 'pending', updatedAt: iso(now),
  });
  await fs.writeFile(QUEUE, JSON.stringify([
    item('old_small', 'smallguy', 0, 30),
    item('fresh_small', 'otherguy', 0, 2),
    item('alanzoka_clip', 'alanzoka', 10, 20),
    item('stale', 'someone', 0, 300),
    item('gaules_delayed', 'gaules', 10, 1, 24 * 60),
  ]));
  await fs.writeFile(STATE, JSON.stringify({ lastPostAt: {} }));

  const { processPostQueue } = await import('./publishing/post-queue.js');
  await processPostQueue(); // upload of /nonexistent.mp4 fails -> still consumes the slot
  let q = JSON.parse(await fs.readFile(QUEUE, 'utf-8'));
  const by = (id: string) => q.find((i: any) => i.id === id).status;
  const checks: [string, boolean][] = [
    ['priority channel picked first (alanzoka)', by('alanzoka_clip') === 'failed'],
    ['stale clip dropped', by('stale') === 'stale'],
    ['delayed gaules clip still waiting', by('gaules_delayed') === 'pending'],
    ['other clips wait their turn', by('fresh_small') === 'pending' && by('old_small') === 'pending'],
  ];
  await processPostQueue(); // within 10 min of the last attempt -> nothing
  q = JSON.parse(await fs.readFile(QUEUE, 'utf-8'));
  checks.push(['spacing: no second post within 10 min', by('fresh_small') === 'pending']);
  const st = JSON.parse(await fs.readFile(STATE, 'utf-8'));
  st.lastPostAt.youtube = iso(now - 11 * 60_000);
  await fs.writeFile(STATE, JSON.stringify(st));
  await processPostQueue();
  q = JSON.parse(await fs.readFile(QUEUE, 'utf-8'));
  checks.push(['after 10 min: freshest normal clip next', by('fresh_small') === 'failed' && by('old_small') === 'pending']);

  // Variety: after an otherguy post, another otherguy clip waits behind a different channel
  await fs.writeFile(QUEUE, JSON.stringify([
    { ...item('posted_other', 'otherguy', 0, 5), status: 'posted' },
    { ...item('other_again', 'otherguy', 0, 1), score: 7 },
    { ...item('different', 'smallguy', 0, 3), score: 6 },
  ]));
  await fs.writeFile(STATE, JSON.stringify({ lastPostAt: { youtube: iso(now - 11 * 60_000) } }));
  await processPostQueue();
  q = JSON.parse(await fs.readFile(QUEUE, 'utf-8'));
  checks.push(['variety: same channel as last post waits its turn', by('different') === 'failed' && by('other_again') === 'pending']);

  // Daily plan (5-10/day, 10-23h, viral bar 8 -> 7 when behind pace)
  const { postingPlan } = await import('./publishing/post-queue.js');
  const { config } = await import('./utils/config.js');
  Object.assign(config, {
    postHours: { start: 10, end: 23 },
    minPostScore: 8,
    minViralityScore: 7,
    minMinutesBetweenPosts: 10,
  });
  config.postsPerDay.youtube = { min: 5, max: 10 };
  const at = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
  const postedAt = (ms: number, n: number) =>
    Array.from({ length: n }, (_, k) => ({ ...item(`p${k}`, 'x', 0, 0), status: 'posted', updatedAt: iso(ms - k * 60_000) }));
  checks.push(['plan: closed before 10h', !postingPlan('youtube', [], 0, at(8)).open]);
  checks.push(['plan: open at 10:30 with viral bar 8', (() => { const p = postingPlan('youtube', [], 0, at(10, 30)); return p.open && p.minScore === 8; })()]);
  checks.push(['plan: slots ~78 min apart (13 h / 10)', !postingPlan('youtube', [], at(12) - 60 * 60_000, at(12)).open && postingPlan('youtube', [], at(12) - 80 * 60_000, at(12)).open]);
  checks.push(['plan: closed after 10 posts today', !postingPlan('youtube', postedAt(at(20), 10) as any, 0, at(20)).open]);
  checks.push(['plan: behind pace at 20h with 1 post -> bar drops to 7', postingPlan('youtube', postedAt(at(19), 1) as any, 0, at(20)).minScore === 7]);
  checks.push(['plan: on pace at 20h with 4 posts -> bar stays 8', postingPlan('youtube', postedAt(at(19), 4) as any, 0, at(20)).minScore === 8]);

  // Expiry clock only runs while the platform can post
  const { isStale } = await import('./publishing/post-queue.js');
  Object.assign(config, { maxQueueAgeHours: 3 });
  const madeAt = (h: number) => ({ createdAt: iso(at(h)), notBefore: iso(at(h)) });
  checks.push(['expiry: clip made at 02h is not stale at 08h (posting closed)', !isStale(madeAt(2), at(8))]);
  checks.push(['expiry: overnight clip still fresh at 12h (clock starts at 10h)', !isStale(madeAt(2), at(12))]);
  checks.push(['expiry: overnight clip stale at 13h30 (3 h after window opened)', isStale(madeAt(2), at(13, 30))]);
  checks.push(['expiry: never stale while the platform is paused', !isStale(madeAt(10), at(20), at(21))]);
  checks.push(['expiry: daytime clip stale 3 h after it was made', isStale(madeAt(14), at(17, 30)) && !isStale(madeAt(14), at(16))]);

  // Disk cleanup never touches a buffer folder that is being recorded
  const { sweepBuffer } = await import('./utils/clip-retention.js');
  const { markBufferActive, markBufferInactive } = await import('./utils/active-buffers.js');
  const buf = path.join(DIR, 'buf');
  for (const ch of ['watched', 'gone']) {
    await fs.mkdir(path.join(buf, ch), { recursive: true });
    const seg = path.join(buf, ch, 'segment_000.mp4');
    await fs.writeFile(seg, 'x');
    const old = new Date(now - 2 * 3600_000);
    await fs.utimes(seg, old, old); // 2 h without new segments (stalled / ended)
  }
  markBufferActive(path.join(buf, 'watched'));
  await sweepBuffer({ dir: buf });
  const exists = async (p: string) => fs.access(p).then(() => true, () => false);
  checks.push(['buffer: stalled but watched channel is kept', await exists(path.join(buf, 'watched', 'segment_000.mp4'))]);
  checks.push(['buffer: channel no longer watched is removed', !(await exists(path.join(buf, 'gone')))]);
  markBufferInactive(path.join(buf, 'watched'));

  // A removed channel must stop quickly even if Twitch chat never disconnects (offline)
  const { ChannelWorker } = await import('./workers/channel-worker.js');
  const { JobQueue } = await import('./workers/job-queue.js');
  const w = new ChannelWorker({ login: 'offlineguy', viewersCount: 100, title: 't', category: 'c' }, new JobQueue(1), 0) as any;
  w.buffer = { stop: () => {} };
  let spikeHandled = false;
  w.chat.stop = () => new Promise(() => {}); // hangs forever, like tmi.js without internet
  const t0 = Date.now();
  await w.stop(300);
  checks.push(['worker: stop returns despite a hung chat disconnect', Date.now() - t0 < 2000]);
  w.buffer.snapshotBuffer = async () => { spikeHandled = true; throw new Error('should not snapshot'); };
  await w.onSpike({ triggeredAt: new Date() });
  checks.push(['worker: spikes after stop are ignored', !spikeHandled]);

  await fs.rm(DIR, { recursive: true, force: true });
  let failed = 0;
  for (const [name, ok] of checks) {
    if (!ok) failed++;
    log(ok ? 'SUCCESS' : 'ERROR', 'QueueTest', `${ok ? 'PASS' : 'FAIL'} ${name}`);
  }
  if (failed) process.exit(1);
};
run().catch((e) => { log('ERROR', 'QueueTest', (e as Error).message); process.exit(1); });
