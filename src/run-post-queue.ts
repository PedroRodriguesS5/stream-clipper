import { processPostQueue } from './publishing/post-queue.js';
import { log } from './utils/logger.js';

/** npm run post-queue  -> posts every queued clip whose delay has passed */
processPostQueue()
  .then((n) => log('SUCCESS', 'PostQueue', `${n} queued clip(s) posted`))
  .catch((err) => {
    log('ERROR', 'PostQueue', (err as Error).message);
    process.exit(1);
  });
