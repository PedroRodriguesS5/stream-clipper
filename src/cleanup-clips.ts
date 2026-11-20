import fs from 'fs/promises';
import path from 'path';
import { sweepBuffer, sweepClips, QueueRef } from './utils/clip-retention.js';
import { log } from './utils/logger.js';

/**
 * Deletes posted clips from output/ and stale recordings from buffer/ right now
 * (the post queue also does this automatically every 10 minutes).
 *   npm run cleanup:clips              # delete
 *   npm run cleanup:clips -- --dry-run # only list what would be deleted
 */
const run = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const b = await sweepBuffer({ dryRun });
  log(
    'SUCCESS',
    'Cleanup',
    dryRun
      ? `Dry run: buffer/ would delete ${b.planned} stale file(s) (${b.plannedMb} MB)`
      : `buffer/: deleted ${b.deleted} stale file(s), freed ${b.freedMb} MB`
  );
  const queue = JSON.parse(await fs.readFile(path.resolve('data/post-queue.json'), 'utf-8').catch(() => '[]')) as QueueRef[];
  const r = await sweepClips(queue, { dryRun });
  const posted = r.planned.filter((p) => p.reason === 'posted').length;
  const unposted = r.planned.length - posted;
  log(
    'SUCCESS',
    'Cleanup',
    dryRun
      ? `Dry run: would delete ${r.planned.length} clip(s) (${posted} posted, ${unposted} never posted)`
      : `Deleted ${r.deleted} clip(s), freed ${r.freedMb} MB`
  );
};

run().catch((e) => {
  log('ERROR', 'Cleanup', (e as Error).message);
  process.exit(1);
});
