import fs from 'fs/promises';
import path from 'path';
import { publishOrQueue } from './publishing/post-queue.js';
import { SEOMetadata } from './ai/ai.js';
import { MonetizationReport } from './compliance/monetization.js';
import { log } from './utils/logger.js';

/**
 * Publishes an already-rendered clip, but ONLY to platforms its monetization report approved.
 *   npm run test:publish -- output/clip_x.mp4 [--youtube-only|--tiktok-only|--instagram-only]
 * Needs output/clip_x.monetization.json and output/clip_x.seo.json (written by test:live / npm start).
 */
const run = async () => {
  const args = process.argv.slice(2);
  const clip = args.find((a) => a.endsWith('.mp4'));
  if (!clip) throw new Error('Usage: npm run test:publish -- output/<clip>.mp4');
  const videoPath = path.resolve(clip);

  const report = JSON.parse(
    await fs.readFile(videoPath.replace(/\.mp4$/, '.monetization.json'), 'utf-8').catch(() => {
      throw new Error('No monetization report next to the clip. Clips without a passed report are never posted.');
    })
  ) as MonetizationReport;
  const seo = JSON.parse(await fs.readFile(videoPath.replace(/\.mp4$/, '.seo.json'), 'utf-8')) as SEOMetadata;

  // Respects the gate (BLOCKED platforms are skipped) and the channel's posting delay
  const only = args.includes('--youtube-only') ? 'youtube' : args.includes('--tiktok-only') ? 'tiktok' : args.includes('--instagram-only') ? 'instagram' : null;
  if (only) for (const v of [report.youtube, report.tiktok, report.instagram]) if (v && v.platform !== only) v.canPost = false;
  log('SUCCESS', 'Publish-Test', 'Result', await publishOrQueue(report, seo));
};

run().catch((err) => {
  log('ERROR', 'Publish-Test', (err as Error).message);
  process.exit(1);
});
