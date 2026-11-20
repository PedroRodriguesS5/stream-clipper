import fs from 'fs/promises';
import path from 'path';
import type { VideoMetric } from './collect-metrics.js';

/**
 * Turns data/video-metrics.json into a few lines for the moment-picking prompt:
 * our best and worst clips (views per hour on YouTube), so Claude learns what works for OUR audience.
 * Returns undefined until there is enough data (videos at least 2 h old).
 */
export const pastPerformanceSummary = async (): Promise<string | undefined> => {
  const file = path.resolve('data/video-metrics.json');
  const { videos } = JSON.parse(await fs.readFile(file, 'utf-8')) as { videos: VideoMetric[] };
  const rated = videos
    .filter((v) => v.platform === 'youtube' && v.ageHours >= 2 && typeof v.views === 'number')
    .map((v) => ({ ...v, perHour: Math.round((v.views || 0) / v.ageHours) }))
    .sort((a, b) => b.perHour - a.perHour);
  if (rated.length < 4) return undefined;

  const line = (v: (typeof rated)[number]) =>
    `- ${v.perHour} views/h | "${v.caption}" | ${(v.moment?.what_happened || '').slice(0, 160)}`;
  const top = rated.slice(0, 3);
  const bottom = rated.slice(-3).filter((v) => !top.includes(v));
  return [`Best:`, ...top.map(line), `Worst:`, ...bottom.map(line)].join('\n');
};
