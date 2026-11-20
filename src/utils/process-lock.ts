import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

const LOCK_FILE = path.join(process.cwd(), 'data', 'clipper.pid');

/**
 * Ensures only ONE instance of the clipper runs at a time.
 * If another instance is active, logs an error and exits process to avoid
 * duplicate stream buffer capture, duplicate AI inference, and duplicate video posting.
 */
export const acquireProcessLock = (): void => {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const content = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
      const existingPid = parseInt(content, 10);

      if (Number.isInteger(existingPid) && existingPid > 0 && existingPid !== process.pid) {
        // Check if process is still running
        try {
          process.kill(existingPid, 0);
          // Process is alive!
          log(
            'ERROR',
            'ProcessLock',
            `Another clipper instance is already running with PID ${existingPid}. Exiting to prevent duplicate clips and posts.`
          );
          process.exit(1);
        } catch (e: any) {
          // ESRCH means process is dead, stale lock
          if (e.code === 'ESRCH') {
            log('INFO', 'ProcessLock', `Removing stale PID lockfile from dead PID ${existingPid}`);
          }
        }
      }
    }

    // Write current PID
    fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, 'utf-8');

    // Register cleanup hooks
    const cleanup = () => {
      try {
        if (fs.existsSync(LOCK_FILE)) {
          const current = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
          if (current === `${process.pid}`) {
            fs.unlinkSync(LOCK_FILE);
          }
        }
      } catch {}
    };

    // Only on real exit: a graceful shutdown (SIGINT) can take minutes while clip jobs finish,
    // and the lock must stay until then so a second instance can't start in the meantime
    process.once('exit', cleanup);
  } catch (err) {
    log('WARN', 'ProcessLock', `Failed to manage PID lock: ${(err as Error).message}`);
  }
};

export const releaseProcessLock = (): void => {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const current = fs.readFileSync(LOCK_FILE, 'utf-8').trim();
      if (current === `${process.pid}`) {
        fs.unlinkSync(LOCK_FILE);
      }
    }
  } catch {}
};
