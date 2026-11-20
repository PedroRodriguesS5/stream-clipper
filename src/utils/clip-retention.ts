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

/**
 * buffer/ cleanup. Each watched channel keeps a rolling set of ~10 segments (~25 MB each) in
 * buffer/<login>/; when the clipper stops watching a channel those segments used to stay forever
 * (52 folders, 4 GB). The snapshot used for a clip is already deleted after rendering.
 *  - segment_*.mp4 + concat_list.txt: deleted once the channel's newest segment is older than
 *    `idleMinutes` (an active channel rewrites a segment every ~30 s, so it's never touched).
 *  - snapshot_* videos/frames and loose files (crashes, tests): deleted after `leftoverHours`
 *    (a queued clip job uses its snapshot within minutes).
 */
export interface BufferEntry {
  /** path relative to buffer/, e.g. "alanzoka/segment_003.mp4" or "test.mp4" */
  rel: string;
  mtimeMs: number;
}

export const bufferFilesToDelete = (
  entries: BufferEntry[],
  nowMs = Date.now(),
  idleMinutes = 30,
  leftoverHours = 3
): string[] => {
  const newestSegment = new Map<string, number>();
  for (const e of entries) {
    const [dir, file] = e.rel.split('/');
    if (file && /^segment_\d+\.mp4$/.test(file)) newestSegment.set(dir, Math.max(newestSegment.get(dir) || 0, e.mtimeMs));
  }
  const out: string[] = [];
  for (const e of entries) {
    const [dir, file] = e.rel.split('/');
    const ageMs = nowMs - e.mtimeMs;
    const isRolling = file && (/^segment_\d+\.mp4$/.test(file) || file === 'concat_list.txt');
    if (isRolling) {
      if (nowMs - (newestSegment.get(dir) || 0) > idleMinutes * 60_000) out.push(e.rel);
    } else if (ageMs > leftoverHours * 3600_000) {
      out.push(e.rel);
    }
  }
  return out;
};

export const sweepBuffer = async (
  options: { dryRun?: boolean; dir?: string } = {}
): Promise<{ deleted: number; freedMb: number; planned: number; plannedMb: number }> => {
  const dir = options.dir || config.bufferDir;
  const entries: (BufferEntry & { size: number })[] = [];
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const full = path.join(dir, name);
    const st = await fs.stat(full).catch(() => null);
    if (!st) continue;
    if (st.isFile()) entries.push({ rel: name, mtimeMs: st.mtimeMs, size: st.size });
    else if (st.isDirectory()) {
      for (const f of await fs.readdir(full).catch(() => [] as string[])) {
        const s = await fs.stat(path.join(full, f)).catch(() => null);
        if (s?.isFile()) entries.push({ rel: `${name}/${f}`, mtimeMs: s.mtimeMs, size: s.size });
      }
    }
  }
  const planned = bufferFilesToDelete(entries);
  const plannedMb = Math.round(planned.reduce((n, rel) => n + (entries.find((e) => e.rel === rel)?.size || 0), 0) / 1048576);
  if (options.dryRun) return { deleted: 0, freedMb: 0, planned: planned.length, plannedMb };
  let deleted = 0;
  let freed = 0;
  for (const rel of planned) {
    try {
      await fs.unlink(path.join(dir, rel));
      deleted++;
      freed += entries.find((e) => e.rel === rel)?.size || 0;
    } catch {
      // file vanished meanwhile (e.g. ring buffer rotated it): fine
    }
  }
  // Remove channel folders left empty
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    await fs.rmdir(path.join(dir, name)).catch(() => {}); // only succeeds when empty
  }
  if (deleted) log('INFO', 'Cleanup', `Buffer: deleted ${deleted} stale file(s), freed ${(freed / 1048576).toFixed(0)} MB`);
  return { deleted, freedMb: Math.round(freed / 1048576), planned: planned.length, plannedMb };
};
