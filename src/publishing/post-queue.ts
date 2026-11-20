import fs from 'fs/promises';
import path from 'path';
import { SEOMetadata } from '../ai/ai.js';
import { MonetizationReport, reportVerdicts } from '../compliance/monetization.js';
import { loadPermissions, checkClipPermission, Platform, PLATFORMS } from '../compliance/permissions.js';
import { InstagramDailyLimitError, uploadToInstagram, uploadToTikTok, uploadToYouTube } from './publishing.js';
import { uploadToYouTubeStudio, youtubeCookiesAvailable, YouTubeDailyLimitError } from './youtube-studio.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';

/**
 * Post queue (data/post-queue.json).
 *
 * `npm start` never uploads directly: every approved clip is queued, and the queue posts
 *  - at most ONE upload at a time,
 *  - at least MIN_MINUTES_BETWEEN_POSTS apart per platform (a new account posting 30 clips/hour
 *    looks like spam to YouTube/TikTok),
 *  - highest priority first (allowed channels like alanzoka), then the freshest clip,
 *  - dropping clips that waited longer than MAX_QUEUE_AGE_HOURS (stale),
 *  - respecting per-channel delays (gaules: 24 h after the moment).
 * Tests (`test:live`, `test:publish`) use publishOrQueue() which posts right away.
 */

export interface QueueItem {
  id: string;
  channel: string;
  platform: Platform;
  clipPath: string;
  seo: SEOMetadata;
  notBefore: string;
  priority: number;
  /** 1-10 from the moment picker; better clips are posted first */
  score?: number;
  createdAt: string;
  status: 'pending' | 'posting' | 'posted' | 'failed' | 'cancelled' | 'stale';
  result?: string;
  updatedAt: string;
}

interface PostState {
  lastPostAt: Partial<Record<Platform, string>>;
  /** Platform paused until this time (e.g. YouTube daily upload limit) */
  pausedUntil?: Partial<Record<Platform, string>>;
}

/** YouTube's limit resets ~24 h after the first uploads; retry a bit sooner, the check is cheap */
const DAILY_LIMIT_PAUSE_MS = 6 * 3600_000;

// POST_QUEUE_DIR lets tests use their own files instead of the live queue
const DATA_DIR = process.env.POST_QUEUE_DIR || path.resolve(process.cwd(), 'data');
const QUEUE_PATH = path.join(DATA_DIR, 'post-queue.json');
const STATE_PATH = path.join(DATA_DIR, 'post-state.json');

const readJson = async <T>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
};
const writeJson = async (file: string, data: unknown) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');
};

// In-process lock so concurrent clip jobs and the queue worker don't overwrite each other
let lock: Promise<unknown> = Promise.resolve();
const withQueue = <T>(fn: (q: QueueItem[]) => Promise<T> | T): Promise<T> => {
  const run = lock.then(async () => {
    const q = await readJson<QueueItem[]>(QUEUE_PATH, []);
    const result = await fn(q);
    await writeJson(QUEUE_PATH, q);
    return result;
  });
  lock = run.catch(() => {});
  return run;
};

const upload = async (platform: Platform, clipPath: string, seo: SEOMetadata): Promise<string> => {
  if (platform === 'youtube') {
    if (config.youtubeUploadMethod === 'browser') {
      if (!youtubeCookiesAvailable()) {
        throw new Error(`YouTube browser upload needs ${config.youtubeCookiesPath} (export youtube.com cookies with Cookie-Editor)`);
      }
      return uploadToYouTubeStudio(clipPath, seo);
    }
    log('WARN', 'YouTubePublisher', 'API uploads from an unverified Google project are locked to PRIVATE by YouTube.');
    return uploadToYouTube(clipPath, seo, config.youtubePrivacy);
  }
  if (platform === 'instagram') return uploadToInstagram(clipPath, seo);
  const r = await uploadToTikTok(clipPath, seo);
  if (!r.posted) throw new Error('TikTok post not found in Studio after posting');
  return `posted (privacy: ${r.privacy ?? '?'}${r.underReview ? ', under review' : ''})`;
};

/** Queues an approved clip for every platform the gate allowed. Used by `npm start`. */
export const enqueueClip = async (
  report: MonetizationReport,
  seo: SEOMetadata,
  priority = 0,
  score?: number
): Promise<Record<Platform, string>> => {
  const out = {} as Record<Platform, string>;
  await withQueue((q) => {
    const now = new Date().toISOString();
    const normalizeTitle = (t: string) => (t || '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '');
    const newNormTitle = normalizeTitle(seo.title);
    const tsMatch = report.clipPath.match(/_(\d{13})_/);
    const currentTs = tsMatch ? parseInt(tsMatch[1], 10) : 0;

    for (const v of reportVerdicts(report)) {
      if (!v.canPost) {
        out[v.platform] = 'BLOCKED';
        continue;
      }

      const itemId = `${path.basename(report.clipPath, '.mp4')}_${v.platform}`;

      // 1. Exact ID check
      if (q.some((i) => i.id === itemId)) {
        out[v.platform] = 'ALREADY_QUEUED (id exists)';
        continue;
      }

      // 2. Exact clipPath check on this platform
      if (
        q.some(
          (i) =>
            i.platform === v.platform &&
            i.clipPath === report.clipPath &&
            i.status !== 'failed' &&
            i.status !== 'cancelled'
        )
      ) {
        out[v.platform] = 'ALREADY_QUEUED (clipPath exists)';
        continue;
      }

      // 3. Duplicate title check on this platform
      if (
        newNormTitle &&
        q.some(
          (i) =>
            i.platform === v.platform &&
            i.status !== 'failed' &&
            i.status !== 'cancelled' &&
            normalizeTitle(i.seo?.title || '') === newNormTitle
        )
      ) {
        out[v.platform] = 'DUPLICATE_TITLE (title already queued or posted)';
        continue;
      }

      // 4. Same channel near-timestamp check (< 45s difference)
      if (currentTs > 0) {
        const nearDup = q.some((i) => {
          if (i.platform !== v.platform || i.channel !== report.channel) return false;
          if (i.status === 'failed' || i.status === 'cancelled') return false;
          const otherTsMatch = i.clipPath.match(/_(\d{13})_/);
          const otherTs = otherTsMatch ? parseInt(otherTsMatch[1], 10) : 0;
          return otherTs > 0 && Math.abs(currentTs - otherTs) < 45_000;
        });
        if (nearDup) {
          out[v.platform] = 'DUPLICATE_MOMENT (near timestamp clip already exists)';
          continue;
        }
      }

      q.push({
        id: itemId,
        channel: report.channel,
        platform: v.platform,
        clipPath: report.clipPath,
        seo,
        notBefore: v.postAfter || now,
        priority,
        score,
        createdAt: now,
        status: 'pending',
        updatedAt: now,
      });
      const pending = q.filter((i) => i.platform === v.platform && i.status === 'pending').length;
      out[v.platform] = `QUEUED (${pending} waiting${v.postAfter ? `, not before ${v.postAfter}` : ''})`;
    }
  });
  const anyQueued = Object.values(out).some((v) => v.startsWith('QUEUED'));
  log('INFO', 'PostQueue', anyQueued ? `${report.channel} clip queued` : `${report.channel} clip NOT queued (blocked on every platform)`, out);
  return out;
};

/** Posts right away (tests / manual publishing), still respecting per-channel delays. */
export const publishOrQueue = async (
  report: MonetizationReport,
  seo: SEOMetadata
): Promise<Record<Platform, string>> => {
  const out = {} as Record<Platform, string>;
  for (const v of reportVerdicts(report)) {
    if (!v.canPost) {
      out[v.platform] = 'BLOCKED';
    } else if (v.postAfter && new Date(v.postAfter).getTime() > Date.now()) {
      // Queue only this platform: mark every other verdict as not postable
      const onlyThis = { ...report } as MonetizationReport;
      for (const other of reportVerdicts(report)) {
        if (other.platform !== v.platform) (onlyThis as unknown as Record<Platform, unknown>)[other.platform] = { ...other, canPost: false };
      }
      out[v.platform] = (await enqueueClip(onlyThis, seo))[v.platform];
    } else {
      out[v.platform] = await upload(v.platform, report.clipPath, seo).catch((e) => `FAILED: ${(e as Error).message}`);
      if (!out[v.platform].startsWith('FAILED')) await markPosted(v.platform);
    }
  }
  return out;
};

const markPosted = async (platform: Platform) => {
  const state = await readJson<PostState>(STATE_PATH, { lastPostAt: {} });
  state.lastPostAt[platform] = new Date().toISOString();
  await writeJson(STATE_PATH, state);
};

const baseRank = (i: QueueItem) => (i.score ?? 6) + (i.priority > 0 ? 2 : 0);

export interface PostingPlan {
  /** May a clip be posted on this platform right now? */
  open: boolean;
  why: string;
  /** Lowest score allowed now (viral bar, relaxed when behind the daily minimum) */
  minScore: number;
  postedToday: number;
}

/**
 * Daily plan per platform (5-10 posts/day by default): only inside POST_HOURS, at most `max` per local
 * day, slots spread evenly over the window (window / max), and only clips at or above the viral bar
 * (MIN_POST_SCORE, 8). If the day is behind the `min` pace, the bar drops to MIN_VIRALITY_SCORE (7)
 * so the day still reaches the minimum. Between slots clips pile up and the most viral one wins.
 */
export const postingPlan = (platform: Platform, q: QueueItem[], lastPostAt: number, nowMs = Date.now()): PostingPlan => {
  const { start, end } = config.postHours;
  const { min, max } = config.postsPerDay[platform];
  const now = new Date(nowMs);
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const postedToday = q.filter(
    (i) => i.platform === platform && i.status === 'posted' && new Date(i.updatedAt).getTime() >= dayStart
  ).length;
  const hour = now.getHours() + now.getMinutes() / 60;
  const windowMin = (end - start) * 60;
  const gapMs = Math.max(config.minMinutesBetweenPosts, windowMin / max) * 60_000;
  // Pace: by this point of the window we should have posted min * elapsed fraction
  const elapsed = Math.min(1, Math.max(0, (hour - start) / (end - start)));
  const behind = postedToday < Math.floor(min * elapsed + 1e-9) || (elapsed > 0.85 && postedToday < min);
  const minScore = behind ? Math.min(config.minPostScore, config.minViralityScore) : config.minPostScore;
  const base = { minScore, postedToday };
  if (hour < start || hour >= end) return { ...base, open: false, why: `outside posting hours ${start}-${end}h` };
  if (postedToday >= max) return { ...base, open: false, why: `daily max reached (${postedToday}/${max})` };
  const waitMs = lastPostAt + gapMs - nowMs;
  if (waitMs > 0) return { ...base, open: false, why: `next slot in ${Math.ceil(waitMs / 60_000)} min` };
  return { ...base, open: true, why: `slot open (${postedToday}/${max} today, bar ${minScore}${behind ? ', behind pace' : ''})` };
};

/** Last plan message per platform, so the once-a-minute queue loop doesn't spam the log */
const lastPlanNote: Partial<Record<Platform, string>> = {};

let processing = false;

/**
 * Posts at most one due clip per platform, if that platform's spacing allows it.
 * Safe to call often (every minute); overlapping calls are ignored.
 */
export const processPostQueue = async (): Promise<number> => {
  if (processing) return 0;
  processing = true;
  let posted = 0;
  try {
    const registry = await loadPermissions();
    const state = await readJson<PostState>(STATE_PATH, { lastPostAt: {} });
    const maxAgeMs = config.maxQueueAgeHours * 3600_000;

    for (const platform of PLATFORMS) {
      if (platform === 'instagram' && !config.instagramEnabled) continue;
      const last = state.lastPostAt[platform] ? new Date(state.lastPostAt[platform]!).getTime() : 0;
      const pausedUntil = state.pausedUntil?.[platform] ? new Date(state.pausedUntil[platform]!).getTime() : 0;
      const waitMs = pausedUntil - Date.now();

      // Pick (and reserve) the next item under the lock
      const item = await withQueue((q) => {
        const now = Date.now();
        for (const i of q) {
          if (i.status !== 'pending' || i.platform !== platform) continue;
          // Stale: waited too long after it became postable (not while the platform is paused,
          // e.g. YouTube's daily limit: those clips post, best first, when it comes back)
          if (pausedUntil <= now && now - Math.max(new Date(i.createdAt).getTime(), new Date(i.notBefore).getTime()) > maxAgeMs) {
            i.status = 'stale';
            i.result = `not posted within ${config.maxQueueAgeHours} h`;
            i.updatedAt = new Date().toISOString();
          } else if (!checkClipPermission(registry, i.channel, i.platform).allowed) {
            i.status = 'cancelled';
            i.result = 'channel was blocked after the clip was queued';
            i.updatedAt = new Date().toISOString();
          }
        }
        if (waitMs > 0) return null;
        const plan = postingPlan(platform, q, last, now);
        if (!plan.open) {
          if (lastPlanNote[platform] !== plan.why.replace(/\d+ min/, '')) {
            lastPlanNote[platform] = plan.why.replace(/\d+ min/, '');
            log('INFO', 'PostQueue', `${platform}: ${plan.why}`);
          }
          return null;
        }
        // Variety: the channel that had the last post on this platform waits its turn (-3)
        const lastChannel = q
          .filter((i) => i.platform === platform && i.status === 'posted')
          .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]?.channel;
        // Fresher is better (GTA 6 moments go stale fast): -0.5 per hour waiting
        const ageH = (i: QueueItem) => (now - new Date(i.createdAt).getTime()) / 3600_000;
        const rank = (i: QueueItem) => baseRank(i) - (i.channel === lastChannel ? 3 : 0) - 0.5 * ageH(i);
        const due = q
          .filter((i) => i.status === 'pending' && i.platform === platform && new Date(i.notBefore).getTime() <= now)
          // Viral bar: clips below it are never posted (they go stale); priority channels count +2
          .filter((i) => baseRank(i) >= plan.minScore)
          // Best clip first: virality score, +2 for priority channels (alanzoka...), -3 if same channel as last post, then the freshest
          .sort((a, b) => rank(b) - rank(a) || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        const next = due[0];
        if (!next && lastPlanNote[platform] !== 'no clip') {
          lastPlanNote[platform] = 'no clip';
          log('INFO', 'PostQueue', `${platform}: slot open but no queued clip scores >= ${plan.minScore} yet`);
        }
        if (next) {
          lastPlanNote[platform] = undefined;
          next.status = 'posting';
          next.updatedAt = new Date().toISOString();
        }
        return next ? { ...next } : null;
      });
      if (!item) continue;

      log('INFO', 'PostQueue', `Posting ${item.id} (${item.channel}, priority ${item.priority}, score ${item.score ?? '-'})...`);
      let status: QueueItem['status'] = 'posted';
      let result: string;
      try {
        result = await upload(platform, item.clipPath, item.seo);
        posted++;
        await markPosted(platform);
        log('SUCCESS', 'PostQueue', `Posted ${item.id}: ${result}`);
      } catch (err) {
        if (err instanceof YouTubeDailyLimitError || err instanceof InstagramDailyLimitError) {
          // Not the clip's fault: keep it waiting and pause this platform
          status = 'pending';
          result = err.message;
          const s = await readJson<PostState>(STATE_PATH, { lastPostAt: {} });
          s.pausedUntil = { ...(s.pausedUntil || {}), [platform]: new Date(Date.now() + DAILY_LIMIT_PAUSE_MS).toISOString() };
          await writeJson(STATE_PATH, s);
          log('WARN', 'PostQueue', `${platform} paused for ${DAILY_LIMIT_PAUSE_MS / 3600_000} h: ${err.message}`);
          await withQueue((q) => {
            const i = q.find((x) => x.id === item.id && x.status === 'posting');
            if (i) Object.assign(i, { status, result, updatedAt: new Date().toISOString() });
          });
          continue;
        }
        status = 'failed';
        result = (err as Error).message;
        // Count failures toward spacing too, so a broken upload doesn't retry in a tight loop
        await markPosted(platform);
        log('ERROR', 'PostQueue', `Failed ${item.id}: ${result}`);
      }
      await withQueue((q) => {
        const i = q.find((x) => x.id === item.id && x.status === 'posting');
        if (i) Object.assign(i, { status, result, updatedAt: new Date().toISOString() });
      });
    }
  } finally {
    processing = false;
  }
  return posted;
};

/** Items left in "posting" by a crash go back to pending on startup */
export const recoverPostQueue = () =>
  withQueue((q) => {
    for (const i of q) if (i.status === 'posting') i.status = 'pending';
  });
