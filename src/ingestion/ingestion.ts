import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs/promises';
import path from 'path';
import tmi, { Client, ChatUserstate } from 'tmi.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { discoverLiveStreams, twitchGql } from './twitch-gql.js';
import { ChatSpikeDetector, ChatTier, TIER_RULES, tierForViewers } from './chat-validation.js';

export interface ChatSpikeEvent {
  channel: string;
  messageCount: number;
  windowSeconds: number;
  recentMessages: string[];
  triggeredAt: Date;
  tier: ChatTier;
  uniqueChatters: number;
  hypeRatio: number;
}

export interface TimedChatMessage {
  /** wall-clock ms when the message arrived */
  t: number;
  line: string;
  hype: boolean;
}

export interface DiscoveredGtaStream {
  login: string;
  viewersCount: number;
  title: string;
  category: string;
}

export const isAnyCategory = () => config.targetCategories.some((c) => c.toLowerCase() === 'any');

/** Does a stream's category match TARGET_CATEGORIES? ("any" matches everything) */
export const matchesTargetCategory = (category: string, title = ''): boolean =>
  isAnyCategory() ||
  config.targetCategories.some((c) => c.toLowerCase() === category.toLowerCase()) ||
  // Same rule as discovery: GTA V streams that are about GTA 6 count as GTA VI
  (config.targetCategories.includes('Grand Theft Auto VI') &&
    category === 'Grand Theft Auto V' &&
    /gta\s*(6|vi)\b/i.test(title));

/**
 * Live streams in `config.streamLanguage` (default PT) for every category in TARGET_CATEGORIES,
 * biggest first. With TARGET_CATEGORIES=any it returns the top live streams of ALL categories.
 * When GTA VI is a target, GTA V streams whose title mentions GTA 6 are included too.
 */
export const discoverLiveGtaVIStreams = async (): Promise<DiscoveredGtaStream[]> => {
  const lang = config.streamLanguage.replace(/[^A-Z]/g, '');
  const toStream = (node: any, category: string): DiscoveredGtaStream => ({
    login: node.broadcaster.login,
    viewersCount: node.viewersCount || 0,
    title: node.title || '',
    category,
  });
  const isLang = (node: any) =>
    String(node?.broadcaster?.broadcastSettings?.language || '').toUpperCase() === lang;

  const found = new Map<string, DiscoveredGtaStream>();

  if (isAnyCategory()) {
    const data = await twitchGql<any>(`{
      streams(first: 30, options: { sort: VIEWER_COUNT, broadcasterLanguages: [${lang}] }) {
        edges { node { title viewersCount game { name } broadcaster { login broadcastSettings { language } } } }
      }
    }`);
    for (const edge of data?.streams?.edges || []) {
      const node = edge?.node;
      if (node?.broadcaster?.login && isLang(node)) found.set(node.broadcaster.login, toStream(node, node.game?.name || ''));
    }
  } else {
    for (const s of await discoverLiveStreams(lang, config.targetCategories)) found.set(s.login, s);

    if (config.targetCategories.includes('Grand Theft Auto VI') && !config.targetCategories.includes('Grand Theft Auto V')) {
      const extra = await discoverLiveStreams(lang, ['Grand Theft Auto V']);
      for (const s of extra) if (/gta\s*(6|vi)\b/i.test(s.title) && !found.has(s.login)) found.set(s.login, s);
    }
  }

  return [...found.values()].sort((x, y) => y.viewersCount - x.viewersCount);
};

export const resolveTargetChannel = async (preferredChannel: string): Promise<DiscoveredGtaStream> => {
  const streams = await discoverLiveGtaVIStreams();
  if (preferredChannel && preferredChannel !== 'auto') {
    const match = streams.find((s) => s.login.toLowerCase() === preferredChannel.toLowerCase());
    if (match) return match;
    log(
      'WARN',
      'Discovery',
      `TWITCH_CHANNEL=${preferredChannel} is not a live ${config.streamLanguage} ${config.targetCategory} stream right now; using it anyway.`
    );
    return {
      login: preferredChannel,
      viewersCount: 0,
      title: `Live stream on ${preferredChannel}`,
      category: config.targetCategory,
    };
  }

  // Prefer creator streams over the generic 'twitch' countdown channel so chat is active
  const creatorStream = streams.find((s) => s.login !== 'twitch') || streams[0];
  if (!creatorStream) {
    throw new Error(
      `No live ${config.targetCategory} streams in language ${config.streamLanguage} found on Twitch right now.`
    );
  }

  log('SUCCESS', 'GTA6-Discovery', `Selected live GTA VI stream: ${creatorStream.login}`, creatorStream);
  return creatorStream;
};

/** Emits 'ended' when streamlink exits (stream went offline, network error...) */
export class RollingStreamBuffer extends EventEmitter {
  private streamlinkProc: ChildProcess | null = null;
  private ffmpegProc: ChildProcess | null = null;
  private stopping = false;
  private restarting = false;
  private watchdog: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private quality = '720p60,720p,best';

  constructor(
    private readonly channel: string = config.twitchChannel,
    private readonly bufferDir: string = config.bufferDir,
    private readonly segmentSeconds: number = config.segmentDurationSeconds,
    private readonly segmentWrap: number = config.segmentWrapCount
  ) {
    super();
  }

  public async start(quality = this.quality): Promise<void> {
    this.quality = quality;
    this.startedAt = Date.now();
    await fs.mkdir(this.bufferDir, { recursive: true });

    // Clean old segments before starting fresh buffer
    const existing = await fs.readdir(this.bufferDir);
    for (const file of existing) {
      if (file.startsWith('segment_') && file.endsWith('.mp4')) {
        await fs.unlink(path.join(this.bufferDir, file)).catch(() => {});
      }
    }

    const streamUrl = `https://twitch.tv/${this.channel}`;
    const segmentPattern = path.join(this.bufferDir, 'segment_%03d.mp4');
    const totalBufferSecs = this.segmentSeconds * this.segmentWrap;

    log(
      'INFO',
      'Ingestion',
      `Starting ${totalBufferSecs}s rolling stream buffer (${this.segmentWrap}x${this.segmentSeconds}s) for ${streamUrl}`
    );

    this.streamlinkProc = spawn('streamlink', ['--stdout', streamUrl, quality], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.ffmpegProc = spawn(
      'ffmpeg',
      [
        // Quiet: nobody reads ffmpeg's stderr, and a full pipe (~64 KB of progress lines,
        // about 11 minutes) blocks ffmpeg and freezes the buffer
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'error',
        '-y',
        '-i',
        'pipe:0',
        '-c',
        'copy',
        '-f',
        'segment',
        '-segment_time',
        String(this.segmentSeconds),
        '-segment_wrap',
        String(this.segmentWrap),
        '-reset_timestamps',
        '1',
        segmentPattern,
      ],
      {
        stdio: ['pipe', 'ignore', 'ignore'],
      }
    );

    if (this.streamlinkProc.stdout && this.ffmpegProc.stdin) {
      this.streamlinkProc.stdout.on('error', () => {});
      this.ffmpegProc.stdin.on('error', () => {});
      this.streamlinkProc.stdout.pipe(this.ffmpegProc.stdin);
    }

    this.streamlinkProc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) log('INFO', 'Streamlink', msg);
    });

    this.streamlinkProc.on('error', (err) => {
      log('ERROR', 'Streamlink', 'Process error', err.message);
    });

    this.streamlinkProc.on('exit', (code) => {
      if (this.stopping || this.restarting) return;
      this.clearWatchdog();
      log('WARN', 'Ingestion', `Stream ${this.channel} ended (streamlink exit ${code})`);
      this.ffmpegProc?.kill('SIGTERM');
      this.emit('ended', code);
    });

    this.ffmpegProc.on('error', (err) => {
      log('ERROR', 'FFmpegBuffer', 'Process error', err.message);
    });

    // Watchdog: streamlink can hang without exiting (segments stop updating). Restart it in place.
    this.clearWatchdog();
    this.watchdog = setInterval(() => this.checkStall().catch(() => {}), 30_000);
  }

  private clearWatchdog() {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** ms since the newest segment was written (Infinity if none) */
  private async newestSegmentAgeMs(): Promise<number> {
    const files = (await fs.readdir(this.bufferDir)).filter((f) => f.startsWith('segment_') && f.endsWith('.mp4'));
    let newest = 0;
    for (const f of files) newest = Math.max(newest, (await fs.stat(path.join(this.bufferDir, f))).mtimeMs);
    return newest ? Date.now() - newest : Infinity;
  }

  private async checkStall() {
    if (this.stopping || this.restarting) return;
    const limitMs = this.segmentSeconds * 3 * 1000;
    if (Date.now() - this.startedAt < limitMs + 30_000) return; // still starting up
    const age = await this.newestSegmentAgeMs();
    if (age < limitMs) return;
    log('WARN', 'Ingestion', `Buffer for ${this.channel} stalled (no new video for ${Math.round(age / 1000)}s); restarting streamlink...`);
    this.restarting = true;
    this.clearWatchdog();
    this.streamlinkProc?.kill('SIGKILL');
    this.ffmpegProc?.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 2000));
    this.restarting = false;
    if (this.stopping) return;
    await this.start().catch((err) => {
      log('ERROR', 'Ingestion', `Restart of ${this.channel} failed: ${(err as Error).message}`);
      this.emit('ended', -1);
    });
  }

  /**
   * Concatenates the completed rolling segments sorted by modification time into a contiguous buffer MP4
   */
  /**
   * `endWallMs` = wall-clock time when the last included segment finished recording,
   * used to line chat messages up with the video timeline.
   */
  public async snapshotBuffer(
    outputFilePath: string
  ): Promise<{ path: string; segmentCount: number; endWallMs: number }> {
    const files = await fs.readdir(this.bufferDir);
    const segmentFiles = files.filter((f) => f.startsWith('segment_') && f.endsWith('.mp4'));

    if (segmentFiles.length === 0) {
      throw new Error(`No buffer segments found in ${this.bufferDir}`);
    }

    const stats = await Promise.all(
      segmentFiles.map(async (file) => {
        const fullPath = path.join(this.bufferDir, file);
        const stat = await fs.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs, size: stat.size };
      })
    );

    const validSegments = stats.filter((s) => s.size > 10_000).sort((a, b) => a.mtimeMs - b.mtimeMs);
    // If more than 1 segment exists, exclude the very last segment if it is currently still being written to by FFmpeg
    const readySegments =
      validSegments.length > 1 ? validSegments.slice(0, validSegments.length - 1) : validSegments;

    const concatListPath = path.join(this.bufferDir, 'concat_list.txt');
    const concatContent = readySegments.map((s) => `file '${s.fullPath}'`).join('\n');
    await fs.writeFile(concatListPath, concatContent, 'utf-8');

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatListPath,
        '-c',
        'copy',
        outputFilePath,
      ]);

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`FFmpeg snapshot concat exited with code ${code}`));
      });
      proc.on('error', reject);
    });

    const endWallMs = readySegments.length ? readySegments[readySegments.length - 1].mtimeMs : Date.now();
    // A frozen buffer would give old video that doesn't match the chat spike
    const staleSec = (Date.now() - endWallMs) / 1000;
    if (staleSec > this.segmentSeconds * 3) {
      await fs.unlink(outputFilePath).catch(() => {});
      throw new Error(`buffer for ${this.channel} is stale (newest ready segment is ${Math.round(staleSec)}s old)`);
    }
    return { path: outputFilePath, segmentCount: readySegments.length, endWallMs };
  }

  public stop(): void {
    this.stopping = true;
    this.clearWatchdog();
    this.streamlinkProc?.kill('SIGTERM');
    this.ffmpegProc?.kill('SIGTERM');
    log('INFO', 'Ingestion', 'Stopped rolling stream buffer.');
  }
}

export class ChatVelocitySensor extends EventEmitter {
  private client: Client;
  private detector: ChatSpikeDetector;
  private allCollectedMessages: string[] = [];
  /** ~6 minutes of valid messages with their arrival time (to line chat up with the video) */
  private timedMessages: TimedChatMessage[] = [];
  private windowMessages: { t: number; line: string }[] = [];
  private lastSpikeTime = 0;
  private lastStatusLog = 0;
  private readonly cooldownMs = 45_000;
  public tier: ChatTier;

  /**
   * @param viewersCount current viewers, used to pick small / normal / big rules
   *        (override with CHAT_TIER=small|normal|big)
   */
  constructor(
    private readonly channel: string = config.twitchChannel,
    viewersCount = 0
  ) {
    super();
    this.tier = config.chatTier === 'auto' ? tierForViewers(viewersCount) : config.chatTier;
    this.detector = new ChatSpikeDetector(TIER_RULES[this.tier]);
    this.client = new tmi.Client({ channels: [this.channel] });
  }

  public async start(): Promise<void> {
    this.client.on(
      'message',
      (_channel: string, tags: ChatUserstate, message: string, self: boolean) => {
        if (self) return;
        this.recordMessage({
          username: tags.username || tags['display-name'] || 'user',
          displayName: tags['display-name'] || tags.username || 'user',
          text: message,
          emotes: (tags.emotes as Record<string, string[]> | undefined) ?? null,
        });
      }
    );

    await this.client.connect();
    const r = TIER_RULES[this.tier];
    log(
      'INFO',
      'ChatSensor',
      `Listening to #${this.channel} as a ${this.tier.toUpperCase()} channel (>= ${r.minMessages} msgs or ${r.baselineMultiplier}x baseline / ${r.windowSeconds}s, ${r.minUniqueChatters}+ chatters, ${r.minHypeRatio * 100}%+ hype)`
    );
  }

  public recordMessage(
    msg: { username: string; displayName?: string; text: string; emotes?: Record<string, string[]> | null },
    now = Date.now()
  ): void {
    const verdict = this.detector.add(msg, now);
    if (!verdict.valid) return;

    const line = `${msg.displayName || msg.username}: ${msg.text}`;
    this.timedMessages.push({ t: now, line, hype: verdict.hype });
    while (this.timedMessages.length && this.timedMessages[0].t < now - 360_000) this.timedMessages.shift();
    this.allCollectedMessages.push(line);
    if (this.allCollectedMessages.length > 80) this.allCollectedMessages.shift();
    this.windowMessages.push({ t: now, line });
    const cutoff = now - this.detector.rules.windowSeconds * 1000;
    while (this.windowMessages.length && this.windowMessages[0].t < cutoff) this.windowMessages.shift();

    if (now - this.lastSpikeTime < this.cooldownMs) return;
    const check = this.detector.check(now);

    if (now - this.lastStatusLog > 60_000) {
      this.lastStatusLog = now;
      log('INFO', 'ChatSensor', `#${this.channel} status: ${check.reason}`);
    }
    if (!check.isSpike) return;

    this.lastSpikeTime = now;
    const spikeEvent: ChatSpikeEvent = {
      channel: this.channel,
      messageCount: check.count,
      windowSeconds: this.detector.rules.windowSeconds,
      recentMessages: this.windowMessages.map((m) => m.line),
      triggeredAt: new Date(now),
      tier: this.tier,
      uniqueChatters: check.uniqueChatters,
      hypeRatio: check.hypeRatio,
    };
    log('SUCCESS', 'ChatSensor', `Validated hype spike on #${this.channel}: ${check.reason}`);
    this.emit('spike', spikeEvent);
  }

  /** Streams grow fast after going live (alanzoka starts at ~1 viewer): switch rules when the tier changes */
  public updateViewers(viewersCount: number): void {
    if (config.chatTier !== 'auto') return;
    const tier = tierForViewers(viewersCount);
    if (tier === this.tier) return;
    log('INFO', 'ChatSensor', `#${this.channel} now has ${viewersCount} viewers: switching chat rules ${this.tier} -> ${tier}`);
    this.tier = tier;
    this.detector = new ChatSpikeDetector(TIER_RULES[tier]);
  }

  public getTimedMessages(): TimedChatMessage[] {
    return [...this.timedMessages];
  }

  public getRecentMessages(): string[] {
    return [...this.allCollectedMessages];
  }

  public async stop(): Promise<void> {
    await this.client.disconnect().catch(() => {});
  }
}
