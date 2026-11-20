import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { log } from './logger.js';

export interface ClippedRange {
  startMs: number;
  endMs: number;
  climaxMs?: number;
  channel: string;
  clipPath?: string;
  title?: string;
  createdAt: string;
}

const RANGES_PATH = path.join(process.cwd(), 'data', 'clipped-ranges.json');
const PRUNE_AGE_MS = 24 * 3600_000; // 24 hours

let writeLock = Promise.resolve();

export const overlapSeconds = (
  a: { startMs: number; endMs: number },
  b: { startMs: number; endMs: number }
): number => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs)) / 1000;

export const loadClippedRanges = async (): Promise<Record<string, ClippedRange[]>> => {
  try {
    if (!fsSync.existsSync(RANGES_PATH)) return {};
    const raw = await fs.readFile(RANGES_PATH, 'utf-8');
    const data = JSON.parse(raw) as Record<string, ClippedRange[]>;
    const now = Date.now();
    const cleaned: Record<string, ClippedRange[]> = {};
    for (const [ch, list] of Object.entries(data)) {
      if (Array.isArray(list)) {
        cleaned[ch] = list.filter((r) => now - r.endMs < PRUNE_AGE_MS);
      }
    }
    return cleaned;
  } catch (err) {
    log('WARN', 'ClippedRanges', `Failed to load clipped ranges: ${(err as Error).message}`);
    return {};
  }
};

export const saveClippedRanges = async (data: Record<string, ClippedRange[]>): Promise<void> => {
  writeLock = writeLock.then(async () => {
    try {
      const dir = path.dirname(RANGES_PATH);
      if (!fsSync.existsSync(dir)) await fs.mkdir(dir, { recursive: true });
      const tmpPath = `${RANGES_PATH}.tmp.${Date.now()}`;
      await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      await fs.rename(tmpPath, RANGES_PATH);
    } catch (err) {
      log('ERROR', 'ClippedRanges', `Failed to save clipped ranges: ${(err as Error).message}`);
    }
  });
  await writeLock;
};

/**
 * Checks if a candidate moment overlaps with any previously clipped range for this channel.
 * An overlap of >= 5 seconds or having the climax/hook point fall within a previously clipped range
 * marks it as a duplicate.
 */
export const checkMomentDuplicate = async (
  channel: string,
  chosen: { startMs: number; endMs: number; climaxMs?: number }
): Promise<{ isDuplicate: boolean; overlapSeconds: number; conflictTitle?: string }> => {
  const all = await loadClippedRanges();
  const ranges = all[channel] || [];

  for (const r of ranges) {
    const ov = overlapSeconds(r, chosen);
    const climaxInside =
      chosen.climaxMs !== undefined && chosen.climaxMs >= r.startMs - 2000 && chosen.climaxMs <= r.endMs + 2000;

    if (ov >= 5 || climaxInside) {
      return {
        isDuplicate: true,
        overlapSeconds: Math.round(ov),
        conflictTitle: r.title,
      };
    }
  }

  return { isDuplicate: false, overlapSeconds: 0 };
};

/**
 * Records an approved and rendered clip range to persistent storage.
 */
export const recordClippedRange = async (range: ClippedRange): Promise<void> => {
  const all = await loadClippedRanges();
  const list = all[range.channel] || [];
  list.push(range);
  all[range.channel] = list;
  await saveClippedRanges(all);
};

/**
 * Returns previously clipped intervals in relative buffer seconds [0..duration]
 * so Claude/Gemini knows which parts of the recording were already clipped.
 */
export const getAlreadyClippedSeconds = async (
  channel: string,
  bufferEndMs: number,
  durationSec: number
): Promise<{ from: number; to: number }[]> => {
  const all = await loadClippedRanges();
  const ranges = all[channel] || [];

  const toBufferSec = (ms: number) => Math.round(durationSec - (bufferEndMs - ms) / 1000);

  return ranges
    .map((r) => ({
      from: Math.max(0, toBufferSec(r.startMs)),
      to: Math.min(durationSec, toBufferSec(r.endMs)),
    }))
    .filter((r) => r.to > 0 && r.from < durationSec && r.to > r.from);
};
