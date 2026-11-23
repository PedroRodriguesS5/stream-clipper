import fs from 'fs/promises';
import path from 'path';
import type { VideoMetric } from './metrics/collect-metrics.js';

/**
 * Follow-CTA A/B test report: which variant brings more subscribers?
 *   npm run cta:report
 * Uses data/video-metrics.json (npm run metrics fills views + subscribers per video).
 */
export interface VariantStats {
  variant: string;
  videos: number;
  withSubs: number;
  views: number;
  subscribers: number;
  subsPer1k: number;
  avgViews: number;
}

export const ctaStats = (videos: VideoMetric[]): VariantStats[] => {
  const by = new Map<string, VideoMetric[]>();
  for (const v of videos) {
    if (v.platform !== 'youtube' || !v.cta) continue;
    by.set(v.cta, [...(by.get(v.cta) || []), v]);
  }
  return [...by.entries()]
    .map(([variant, vs]) => {
      const counted = vs.filter((v) => typeof v.subscribers === 'number' && typeof v.views === 'number');
      const views = counted.reduce((n, v) => n + (v.views || 0), 0);
      const subscribers = counted.reduce((n, v) => n + (v.subscribers || 0), 0);
      return {
        variant,
        videos: vs.length,
        withSubs: counted.length,
        views,
        subscribers,
        subsPer1k: views ? Math.round((subscribers / views) * 1000 * 100) / 100 : 0,
        avgViews: vs.length ? Math.round(vs.reduce((n, v) => n + (v.views || 0), 0) / vs.length) : 0,
      };
    })
    .sort((a, b) => b.subsPer1k - a.subsPer1k);
};

const isMain = process.argv[1]?.endsWith('cta-report.js');
if (isMain) {
  const { videos } = JSON.parse(await fs.readFile(path.resolve('data/video-metrics.json'), 'utf-8')) as { videos: VideoMetric[] };
  const stats = ctaStats(videos);
  if (!stats.length) {
    console.log('No clips with a follow-CTA variant measured yet (variants start with clips rendered after this update; subscribers are read once a Short is 24 h old).');
  } else {
    console.log('variant   videos  measured   views      subs  subs/1k views  avg views');
    for (const s of stats) {
      console.log(`${s.variant.padEnd(9)} ${String(s.videos).padStart(6)} ${String(s.withSubs).padStart(9)} ${String(s.views).padStart(8)} ${String(s.subscribers).padStart(8)} ${String(s.subsPer1k).padStart(14)} ${String(s.avgViews).padStart(10)}`);
    }
    const enough = stats.every((s) => s.withSubs >= 10);
    console.log(enough ? `\nLeader: ${stats[0].variant}` : '\nKeep collecting: at least 10 measured Shorts per variant before deciding.');
  }
}
