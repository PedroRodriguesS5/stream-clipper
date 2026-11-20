import path from 'path';
import { RollingStreamBuffer, ChatVelocitySensor } from './ingestion/ingestion.js';
import { discoverLiveStreams, fetchChannelProfiles, LiveStreamInfo } from './ingestion/twitch-gql.js';
import { tierForViewers } from './ingestion/chat-validation.js';
import { getVideoDurationSeconds } from './video/video.js';
import { processClip } from './pipeline.js';
import { config } from './utils/config.js';
import { ensureDirectories } from './utils/cleanup.js';
import { log } from './utils/logger.js';

/**
 * Real live trial on Portuguese GTA streams that are live RIGHT NOW.
 *   npm run test:live                       # auto: one bigger + one small channel
 *   npm run test:live -- loginA loginB      # specific channels
 *   npm run test:live -- --dry-run          # everything except the upload
 *
 * Each clip goes through the monetization gate; it is only posted where the gate passes.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BUFFER_SECONDS = Number(process.env.TEST_BUFFER_SECONDS || 180);

const pickTargets = async (explicit: string[]): Promise<LiveStreamInfo[]> => {
  const live = await discoverLiveStreams(config.streamLanguage, ['Grand Theft Auto VI', 'Grand Theft Auto V'], {
    includeSmall: true,
  });
  if (explicit.length) {
    // Any channel/game: read its live title, category and viewers directly
    const profiles = await fetchChannelProfiles(explicit.map((l) => l.toLowerCase()));
    return profiles
      .filter((p) => {
        if (!p.isLive) log('WARN', 'Live-Test', `${p.login} is not live; skipping`);
        return p.isLive;
      })
      .map((p) => ({ login: p.login, viewersCount: p.viewersCount, title: p.streamTitle, category: p.category }));
  }
  const sorted = live.filter((s) => s.login !== 'twitch').sort((a, b) => b.viewersCount - a.viewersCount);
  const bigger = sorted.find((s) => tierForViewers(s.viewersCount) !== 'small');
  const small = sorted.find((s) => s.viewersCount >= 10 && s.viewersCount < 100);
  return [bigger, small].filter((s): s is LiveStreamInfo => !!s);
};

const trialChannel = async (target: LiveStreamInfo) => {
  const tag = `Live:${target.login}`;
  const bufferDir = path.join(config.bufferDir, target.login);
  await ensureDirectories([bufferDir]);

  const buffer = new RollingStreamBuffer(target.login, bufferDir, 10, 20);
  const chat = new ChatVelocitySensor(target.login, target.viewersCount);
  let spikes = 0;
  chat.on('spike', () => spikes++);

  log('INFO', tag, `Buffering ${BUFFER_SECONDS}s of https://twitch.tv/${target.login} (${target.viewersCount} viewers, ${chat.tier} tier)...`);
  await buffer.start('720p60,720p,480p,best');
  await chat.start();
  await sleep(BUFFER_SECONDS * 1000);

  const snapshot = path.join(bufferDir, `snapshot_${Date.now()}.mp4`);
  const snap = await buffer.snapshotBuffer(snapshot);
  buffer.stop();
  await chat.stop();
  const timedMessages = chat.getTimedMessages();
  log('INFO', tag, `Buffered ${await getVideoDurationSeconds(snapshot)}s, ${timedMessages.length} valid chat messages, ${spikes} validated spike(s)`);

  // Same pipeline as `npm start` (reaction signals -> moment -> SEO -> render -> gate -> publish unless --dry-run)
  const result = await processClip({
    target,
    snapshotPath: snapshot,
    snapshotEndMs: snap.endWallMs,
    timedMessages,
    triggeredAt: new Date(),
    publishMode: 'direct',
  });
  return {
    channel: target.login,
    viewers: target.viewersCount,
    tier: chat.tier,
    status: result.status,
    reason: result.reason,
    clip: result.clipPath ? path.relative(process.cwd(), result.clipPath) : undefined,
    moment: result.moment,
    seo: result.seo,
    youtube: result.report?.youtube.mode,
    tiktok: result.report?.tiktok.mode,
    published: result.published,
  };
};

const run = async () => {
  await ensureDirectories([config.bufferDir, config.outputDir]);
  const targets = await pickTargets(process.argv.slice(2).filter((a) => !a.startsWith('-')));
  if (!targets.length) throw new Error('No live Portuguese GTA streams found right now.');
  log('INFO', 'Live-Test', `Testing ${targets.length} live channel(s): ${targets.map((t) => `${t.login} (${t.viewersCount})`).join(', ')}`);

  const results = await Promise.allSettled(targets.map(trialChannel));
  results.forEach((r, i) =>
    r.status === 'fulfilled'
      ? log('SUCCESS', 'Live-Test', `Result for ${targets[i].login}`, r.value)
      : log('ERROR', 'Live-Test', `Trial failed for ${targets[i].login}`, (r.reason as Error).message)
  );
};

run().catch((err) => {
  log('ERROR', 'Live-Test', (err as Error).stack || (err as Error).message);
  process.exit(1);
});
