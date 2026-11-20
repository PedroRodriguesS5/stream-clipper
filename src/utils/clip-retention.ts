import fs from 'fs/promises';
import path from 'path';
import { config } from './config.js';
import { log } from './logger.js';

/**
 * Deletes rendered clips (output/clip_*_9x16.mp4) once they are no longer needed, so the disk
 * doesn't fill up (~10-15 MB per clip, hundreds per day).
 *
 *  - Posted clips: deleted when every platform the clip was queued for is finished
 *    (posted / failed / stale / cancelled) and at least one platform posted it.
 *  - Never-posted clips (expired in the queue, blocked by the gate, never queued): only deleted
 *    when DELETE_UNPOSTED_CLIPS_AFTER_HOURS > 0 and the file is older than that.
 *  - A clip still pending or being posted on any platform is never touched.
 * The small .seo.json / .monetization.json / .srt files are kept (metrics and history use them).
 */

export interface QueueRef {
  clipPath: string;
  status: string;
}

export interface ClipFile {
  path: string;
  mtimeMs: number;
}

export interface RetentionRules {
  deleteAfterPost: boolean;
  /** 0 = keep never-posted clips forever */
  unpostedMaxAgeHours: number;
}

const ACTIVE = new Set(['pending', 'posting']);

export const clipsToDelete = (
  files: ClipFile[],
  queue: QueueRef[],
  rules: RetentionRules,
  nowMs = Date.now()
): { path: string; reason: 'posted' | 'unposted' }[] => {
  const byClip = new Map<string, QueueRef[]>();
  for (const item of queue) {
    const key = path.resolve(item.clipPath);
    byClip.set(key, [...(byClip.get(key) || []), item]);
  }
  const out: { path: string; reason: 'posted' | 'unposted' }[] = [];
  for (const file of files) {
    const items = byClip.get(path.resolve(file.path)) || [];
    if (items.some((i) => ACTIVE.has(i.status))) continue; // still needed somewhere
    if (items.some((i) => i.status === 'posted')) {
      if (rules.deleteAfterPost) out.push({ path: file.path, reason: 'posted' });
      continue;
    }
    const ageH = (nowMs - file.mtimeMs) / 3600_000;
    if (rules.unpostedMaxAgeHours > 0 && ageH > rules.unpostedMaxAgeHours) out.push({ path: file.path, reason: 'unposted' });
  }
  return out;
};

const CLIP_FILE = /^clip_.+_9x16\.mp4$/;

/** Applies the rules to output/. Returns how many clips were deleted and the MB freed. */
export const sweepClips = async (
  queue: QueueRef[],
  options: { dryRun?: boolean; dir?: string } = {}
): Promise<{ deleted: number; freedMb: number; planned: { path: string; reason: string }[] }> => {
  const dir = options.dir || config.outputDir;
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => CLIP_FILE.test(n));
  const files: (ClipFile & { size: number })[] = [];
  for (const name of names) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null);
    if (st?.isFile()) files.push({ path: path.join(dir, name), mtimeMs: st.mtimeMs, size: st.size });
  }
  const planned = clipsToDelete(files, queue, {
    deleteAfterPost: config.deleteClipsAfterPost,
    unpostedMaxAgeHours: config.deleteUnpostedClipsAfterHours,
  });
  let deleted = 0;
  let freed = 0;
  if (!options.dryRun) {
    for (const p of planned) {
      const size = files.find((f) => f.path === p.path)?.size || 0;
      try {
        await fs.unlink(p.path);
        deleted++;
        freed += size;
      } catch (err) {
        log('WARN', 'Cleanup', `Could not delete ${path.basename(p.path)}: ${(err as Error).message}`);
      }
    }
    if (deleted) log('INFO', 'Cleanup', `Deleted ${deleted} finished clip(s), freed ${(freed / 1048576).toFixed(0)} MB`);
  }
  return { deleted, freedMb: Math.round(freed / 1048576), planned };
};
