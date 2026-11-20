import { log } from '../utils/logger.js';

export interface Job {
  id: string;
  channel: string;
  run: () => Promise<void>;
}

/**
 * Runs heavy jobs (Claude calls + FFmpeg render + upload) with a concurrency limit, so several
 * channels spiking at once don't overload the machine. Jobs beyond `maxPending` are dropped
 * (the moment is already saved as a snapshot, but a backlog means we can't keep up anyway).
 */
export class JobQueue {
  private pending: Job[] = [];
  private running = new Set<string>();

  constructor(
    private readonly concurrency: number,
    private readonly maxPending = 6
  ) {}

  public get size() {
    return { running: this.running.size, pending: this.pending.length };
  }

  /** true if this channel already has a job waiting or running */
  public hasJobFor(channel: string): boolean {
    return this.pending.some((j) => j.channel === channel) || [...this.running].some((id) => id.startsWith(`${channel}:`));
  }

  public push(job: Job): boolean {
    if (this.pending.length >= this.maxPending) {
      log('WARN', 'JobQueue', `Queue full (${this.pending.length} waiting); dropping ${job.id}`);
      return false;
    }
    this.pending.push(job);
    log('INFO', 'JobQueue', `Queued ${job.id} (running ${this.running.size}/${this.concurrency}, waiting ${this.pending.length})`);
    this.drain();
    return true;
  }

  private drain(): void {
    while (this.running.size < this.concurrency && this.pending.length) {
      const job = this.pending.shift()!;
      this.running.add(job.id);
      job
        .run()
        .catch((err) => log('ERROR', 'JobQueue', `${job.id} failed`, (err as Error).message))
        .finally(() => {
          this.running.delete(job.id);
          this.drain();
        });
    }
  }

  /** Resolves when nothing is running or waiting */
  public async idle(): Promise<void> {
    while (this.running.size || this.pending.length) await new Promise((r) => setTimeout(r, 1000));
  }
}
