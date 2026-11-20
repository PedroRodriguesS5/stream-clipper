import path from 'path';

/**
 * Buffer folders currently being recorded (one per watched channel). The disk cleanup never
 * touches these, even if a stream stalls and no new segment arrives for a while.
 */
export const activeBufferDirs = new Set<string>();

export const markBufferActive = (dir: string) => activeBufferDirs.add(path.resolve(dir));
export const markBufferInactive = (dir: string) => activeBufferDirs.delete(path.resolve(dir));
export const isBufferActive = (dir: string) => activeBufferDirs.has(path.resolve(dir));
