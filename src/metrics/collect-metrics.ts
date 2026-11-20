import fs from 'fs/promises';
import path from 'path';
import { chromium, Page } from 'playwright';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { loadTikTokCookies, normalizePlaywrightCookies, RawBrowserCookie } from '../publishing/publishing.js';

/**
 * Collects performance of what we posted, so we learn which moments work:
 *  - YouTube: public watch page (views, likes) + Studio list (visibility / restrictions like copyright)
 *  - TikTok: TikTok Studio content list (views, likes, comments, privacy)
 * Joins each video with its clip's .seo.json (moment, caption, channel) -> data/video-metrics.json
 *
 *   npm run metrics
 */

interface QueueItem {
  id: string;
  channel: string;
  platform: 'youtube' | 'tiktok';
  clipPath: string;
  seo: { title: string; hook_caption: string };
  status: string;
  result?: string;
  updatedAt: string;
}

export interface VideoMetric {
  platform: 'youtube' | 'tiktok';
  channel: string;
  clip: string;
  postedAt: string;
  ageHours: number;
  url?: string;
  title: string;
  caption: string;
  moment?: { what_happened?: string; streamer_reaction?: string; chat_reaction?: string };
  views?: number;
  likes?: number;
  comments?: number;
  status?: string; // public / unavailable / restricted / under review...
  studioNote?: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const num = (s?: string) => {
  if (!s) return undefined;
  const t = s.trim().replace(',', '.');
  const m = t.match(/^([\d.]+)\s*([KkMm]|mil)?$/);
  if (!m) return Number(t.replace(/\D/g, '')) || 0;
  const mult = /k|mil/i.test(m[2] || '') ? 1e3 : /m/i.test(m[2] || '') ? 1e6 : 1;
  return Math.round(parseFloat(m[1]) * mult);
};

const youtubePublic = async (id: string) => {
  const html = await (await fetch(`https://www.youtube.com/watch?v=${id}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US' } })).text();
  const views = html.match(/"viewCount":"(\d+)"/)?.[1];
  const likes = html.match(/"likeCount":"?(\d+)/)?.[1];
  const unavailable = /"status":"(ERROR|UNPLAYABLE|LOGIN_REQUIRED)"/.exec(html)?.[1];
  const reason = html.match(/"reason":"([^"]{0,200})/)?.[1];
  return {
    views: views ? Number(views) : undefined,
    likes: likes ? Number(likes) : undefined,
    status: unavailable ? `unavailable (${reason || unavailable})` : views ? 'public' : 'unknown',
  };
};

/** Studio Shorts list: text of each row (title + visibility + restrictions) */
const youtubeStudioRows = async (page: Page): Promise<string[]> => {
  await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(6000);
  if (/accounts\.google\.com|ServiceLogin/i.test(page.url())) throw new Error('YouTube cookies expired');
  const channelUrl = page.url().match(/studio\.youtube\.com\/channel\/[\w-]+/)?.[0];
  await page.goto(`https://${channelUrl}/videos/short`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(9000);
  return page.locator('ytcp-video-row').allInnerTexts();
};

/** TikTok Studio content list: text blocks per post */
const tiktokStudioText = async (page: Page): Promise<string> => {
  await page.goto('https://www.tiktok.com/tiktokstudio/content', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(10000);
  // The list is virtualized (only rows on screen exist) and loads more as you scroll:
  // scroll step by step and keep the text of every step; parseTikTokRows de-duplicates
  const snapshots: string[] = [];
  let stale = 0;
  let lastText = '';
  for (let i = 0; i < 120 && stale < 4; i++) {
    const text = await page.evaluate(() => document.body.innerText);
    snapshots.push(text);
    stale = text === lastText ? stale + 1 : 0;
    lastText = text;
    await page.evaluate(() => {
      for (const el of [document.scrollingElement, ...document.querySelectorAll('*')]) {
        if (el && el.scrollHeight > el.clientHeight + 50) el.scrollTop += Math.max(300, el.clientHeight * 0.8);
      }
    });
    await page.waitForTimeout(1200);
  }
  return snapshots.join('\n');
};

export interface TikTokRow {
  caption: string;
  privacy?: string;
  underReview: boolean;
  views?: number;
  likes?: number;
  comments?: number;
}

/** Splits the Studio list text into posts: each starts with its duration line ("00:19") */
export const parseTikTokRows = (text: string): TikTokRow[] => {
  const lines = text.split('\n').map((l) => l.trim());
  const rows: TikTokRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\d{1,2}:\d{2}$/.test(lines[i])) continue;
    const caption = lines[i + 1] || '';
    let j = i + 2;
    let underReview = false;
    let privacy: string | undefined;
    for (; j < Math.min(lines.length, i + 8); j++) {
      if (/under review|em análise/i.test(lines[j])) underReview = true;
      const m = lines[j].match(/^(Everyone|Todos|Only me|Somente você|Apenas eu|Friends|Amigos)$/i);
      if (m) {
        privacy = m[1];
        break;
      }
    }
    const nums = lines.slice(j + 1, j + 4).map((l) => (/^[\d.,]+\s*(?:[KkMm]|mil)?$/.test(l) ? num(l) : undefined));
    if (rows.some((r) => r.caption === caption)) continue; // same row seen in several scroll snapshots
    rows.push({ caption, privacy, underReview, views: nums[0], likes: nums[1], comments: nums[2] });
  }
  return rows;
};

export const collectMetrics = async (): Promise<VideoMetric[]> => {
  const queue = JSON.parse(await fs.readFile(path.resolve('data/post-queue.json'), 'utf-8')) as QueueItem[];
  const posted = queue.filter((i) => i.status === 'posted');
  const extra = JSON.parse(await fs.readFile(path.resolve('data/manual-posts.json'), 'utf-8').catch(() => '[]')) as QueueItem[];

  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  let ytRows: string[] = [];
  let ttText = '';
  try {
    const yt = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 950 } });
    const raw = JSON.parse(await fs.readFile(config.youtubeCookiesPath, 'utf-8')) as RawBrowserCookie[];
    await yt.addCookies(normalizePlaywrightCookies(raw));
    ytRows = await youtubeStudioRows(await yt.newPage()).catch((e) => (log('WARN', 'Metrics', `YouTube Studio: ${e.message}`), []));

    const tt = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 950 } });
    await tt.addCookies(await loadTikTokCookies());
    ttText = await tiktokStudioText(await tt.newPage()).catch((e) => (log('WARN', 'Metrics', `TikTok Studio: ${e.message}`), ''));
  } finally {
    await browser.close();
  }
  await fs.writeFile(path.join(config.outputDir, 'metrics_raw.txt'), `=== YOUTUBE STUDIO ROWS ===\n${ytRows.join('\n---\n')}\n\n=== TIKTOK STUDIO ===\n${ttText}`);

  const ttRows = parseTikTokRows(ttText);
  const out: VideoMetric[] = [];
  for (const item of [...posted, ...extra].filter((i) => i.platform !== ('instagram' as string))) {
    const seoFile = item.clipPath.replace(/\.mp4$/, '.seo.json');
    const seo = JSON.parse(await fs.readFile(seoFile, 'utf-8').catch(() => '{}'));
    const m: VideoMetric = {
      platform: item.platform,
      channel: item.channel,
      clip: path.basename(item.clipPath),
      postedAt: item.updatedAt,
      ageHours: +((Date.now() - new Date(item.updatedAt).getTime()) / 3600_000).toFixed(1),
      title: item.seo.title,
      caption: item.seo.hook_caption,
      moment: seo.moment && {
        what_happened: seo.moment.what_happened,
        streamer_reaction: seo.moment.streamer_reaction,
        chat_reaction: seo.moment.chat_reaction,
      },
    };
    const titleKey = item.seo.title.slice(0, 30);
    if (item.platform === 'youtube') {
      const id = item.result?.match(/shorts\/([\w-]{11})/)?.[1];
      if (id) {
        m.url = `https://youtube.com/shorts/${id}`;
        Object.assign(m, await youtubePublic(id).catch(() => ({ status: 'fetch failed' })));
      }
      const row = ytRows.find((r) => r.includes(titleKey));
      if (row) m.studioNote = row.replace(/\s+/g, ' ').slice(0, 300);
    } else {
      // TikTok Studio row: duration, caption, [date | under review], privacy, views, likes, comments
      const row = ttRows.find((r) => r.caption.startsWith(item.seo.title.slice(0, 25)));
      if (row) {
        m.status = `${row.privacy ?? '?'}${row.underReview ? ' (under review)' : ''}`;
        [m.views, m.likes, m.comments] = [row.views, row.likes, row.comments];
      } else m.status = ttText ? 'not found in Studio (older than the loaded list?)' : 'Studio not read';
    }
    out.push(m);
  }

  await fs.writeFile(path.resolve('data/video-metrics.json'), JSON.stringify({ collectedAt: new Date().toISOString(), videos: out }, null, 2) + '\n');
  return out;
};

const isMain = process.argv[1]?.endsWith('collect-metrics.js');
if (isMain) {
  collectMetrics()
    .then((v) => {
      for (const m of v) {
        log('INFO', 'Metrics', `${m.platform.padEnd(7)} ${m.channel.padEnd(12)} ${String(m.views ?? '-').padStart(6)} views ${String(m.likes ?? '-').padStart(4)} likes  ${m.ageHours}h  ${m.status ?? ''}  "${m.caption}"`);
      }
      log('SUCCESS', 'Metrics', 'Saved data/video-metrics.json (raw Studio text in output/metrics_raw.txt)');
    })
    .catch((e) => {
      log('ERROR', 'Metrics', (e as Error).message);
      process.exit(1);
    });
}
