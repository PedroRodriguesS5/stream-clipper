import { execFile } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import type { SEOMetadata } from '../ai/ai.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { formatTikTokCaption } from './platform-seo.js';

/**
 * Semi-manual TikTok (TIKTOK_MODE=manual): instead of uploading with a headless browser (which
 * TikTok seems to penalize: 106 automated posts, 2 views), each TikTok slot copies the clip and
 * its ready-made caption into a folder that syncs to the phone (iCloud Drive by default). You
 * post it from the TikTok app: open the video from the Files app, share to TikTok, paste the
 * caption. The queue still picks the best clip for each slot (3 a day by default).
 */

const ICLOUD = path.join(process.env.HOME || '', 'Library', 'Mobile Documents', 'com~apple~CloudDocs');

export const manualDir = () =>
  config.tiktokManualDir || path.join(ICLOUD, 'Stream Clipper', 'TikTok');

/** "2026-11-22_1430_alanzoka" */
export const exportName = (channel: string, at: Date) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}_${p(at.getHours())}${p(at.getMinutes())}_${channel.toLowerCase().replace(/[^a-z0-9_]/g, '')}`;
};

/** Text file next to the video: the caption to paste, plus a reminder of the steps */
export const captionFile = (seo: SEOMetadata) =>
  `${formatTikTokCaption(seo)}\n\n---\nPost from the TikTok app: open the .mp4 in Files → Share → TikTok → paste the caption above.\n`;

export const exportForManualPost = async (
  clipPath: string,
  seo: SEOMetadata,
  opts: { dir?: string; now?: Date; notify?: boolean } = {}
): Promise<string> => {
  const dir = opts.dir ?? manualDir();
  await fs.mkdir(dir, { recursive: true });
  const base = path.join(dir, exportName(seo.channel || 'clip', opts.now ?? new Date()));
  await fs.copyFile(clipPath, `${base}.mp4`);
  await fs.writeFile(`${base}.txt`, captionFile(seo));
  log('SUCCESS', 'TikTokManual', `Ready to post from your phone: ${path.basename(base)}.mp4 (${dir})`);
  if (opts.notify !== false) notifyReady(path.basename(base), seo.title);
  return `${base}.mp4`;
};

const notifyReady = (name: string, title: string) => {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile(
    'osascript',
    ['-e', `display notification "${esc(title)}" with title "TikTok clip ready to post" subtitle "${esc(name)}" sound name "Glass"`],
    () => {}
  );
};

/** Exports older than `days` are removed so the synced folder doesn't fill iCloud */
export const cleanupManualExports = async (dir = manualDir(), days = config.tiktokManualKeepDays, now = Date.now()) => {
  let removed = 0;
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    if (!/\.(mp4|txt)$/.test(name)) continue;
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st && now - st.mtimeMs > days * 86_400_000) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
      removed++;
    }
  }
  return removed;
};
