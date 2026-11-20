import { runWizard } from './setup/wizard.js';
import { log } from './utils/logger.js';

/**
 * Choose what to clip without starting the clipper (saved to data/session.json, used by the next
 * `npm start`, including unattended runs).
 *   npm run setup
 */
runWizard()
  .then((s) => {
    if (!s) process.exitCode = 1;
  })
  .catch((e) => {
    log('ERROR', 'Setup', (e as Error).message);
    process.exit(1);
  });
