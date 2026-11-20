import fs from 'fs/promises';
import path from 'path';
import { log } from './logger.js';

export const ensureDirectories = async (dirs: string[]): Promise<void> => {
  for (const dir of dirs) {
    await fs.mkdir(dir, { recursive: true });
  }
};

export const cleanupOldFiles = async (dir: string, maxAgeMs: number): Promise<void> => {
  try {
    const entries = await fs.readdir(dir);
    const now = Date.now();

    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const stat = await fs.stat(fullPath);
      if (stat.isFile() && now - stat.mtimeMs > maxAgeMs) {
        await fs.unlink(fullPath);
        log('INFO', 'Cleanup', `Removed expired file: ${entry}`);
      }
    }
  } catch (err) {
    log('WARN', 'Cleanup', `Failed cleanup in ${dir}`, (err as Error).message);
  }
};
