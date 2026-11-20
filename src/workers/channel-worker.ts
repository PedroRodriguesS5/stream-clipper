import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs/promises';
import {
  ChatSpikeEvent,
  ChatVelocitySensor,
  DiscoveredGtaStream,
  RollingStreamBuffer,
} from '../ingestion/ingestion.js';
import { processClip } from '../pipeline.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { JobQueue } from './job-queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Watches ONE live channel: its own rolling video buffer (buffer/<login>/) and chat sensor.
 * On a validated hype spike it waits for the reaction to be recorded, snapshots the buffer,
 * and hands the heavy work to the shared JobQueue. Emits 'ended' when the stream stops.
 */
export class ChannelWorker extends EventEmitter {
  private buffer: RollingStreamBuffer;
  private chat: ChatVelocitySensor;
  private snapshotting = false;
  public readonly startedAt = Date.now();
  public clipsQueued = 0;

  constructor(
    public readonly target: DiscoveredGtaStream,
    private readonly queue: JobQueue,
    /** Higher = its clips are posted first; also never dropped to free a slot */
    public readonly priority = 0
  ) {
    super();
    this.buffer = new RollingStreamBuffer(
      target.login,
      path.join(config.bufferDir, target.login),
      config.segmentDurationSeconds,
      config.segmentWrapCount
    );
    this.chat = new ChatVelocitySensor(target.login, target.viewersCount);
  }

  public get login() {
    return this.target.login;
  }

  /** true while a spike is being recorded or this channel's clip is being processed */
  public get busy() {
    return this.snapshotting || this.queue.hasJobFor(this.login);
  }

  public async start(): Promise<void> {
    log('INFO', 'Worker', `▶ ${this.login} (${this.target.viewersCount} viewers, ${this.target.category}, ${this.chat.tier} chat${this.priority ? ', PRIORITY' : ''})`);
    this.buffer.on('ended', () => this.emit('ended', this));
    this.chat.on('spike', (e: ChatSpikeEvent) => {
      this.onSpike(e).catch((err) => log('ERROR', 'Worker', `${this.login}: ${(err as Error).message}`));
    });
    await this.buffer.start();
    await this.chat.start();
  }

  public updateViewers(viewersCount: number): void {
    this.target.viewersCount = viewersCount;
    this.chat.updateViewers(viewersCount);
  }

  private async onSpike(event: ChatSpikeEvent): Promise<void> {
    if (this.snapshotting || this.queue.hasJobFor(this.login)) {
      log('INFO', 'Worker', `${this.login}: spike ignored (a clip of this channel is already in progress)`);
      return;
    }
    this.snapshotting = true;
    try {
      // The segment holding the moment is still being written; wait for it (and the reaction) to finish
      const waitSec = config.segmentDurationSeconds + 3;
      log('INFO', 'Worker', `${this.login}: hype spike! Waiting ${waitSec}s for the moment to finish recording...`);
      await sleep(waitSec * 1000);

      const snapshotPath = path.join(config.bufferDir, this.login, `snapshot_${event.triggeredAt.getTime()}.mp4`);
      const snap = await this.buffer.snapshotBuffer(snapshotPath);
      const timedMessages = this.chat.getTimedMessages();
      const queued = this.queue.push({
        id: `${this.login}:${event.triggeredAt.getTime()}`,
        channel: this.login,
        run: async () => {
          await processClip({
            target: this.target,
            snapshotPath,
            snapshotEndMs: snap.endWallMs,
            timedMessages,
            triggeredAt: event.triggeredAt,
            publishMode: 'queue',
            priority: this.priority,
          });
        },
      });
      if (queued) this.clipsQueued++;
      else await fs.unlink(snapshotPath).catch(() => {});
    } finally {
      this.snapshotting = false;
    }
  }

  public async stop(): Promise<void> {
    this.buffer.stop();
    await this.chat.stop();
    log('INFO', 'Worker', `■ ${this.login} stopped (${this.clipsQueued} clip(s) queued)`);
  }
}
