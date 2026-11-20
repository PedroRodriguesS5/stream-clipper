import {
  resolveTargetChannel,
  discoverLiveGtaVIStreams,
  matchesTargetCategory,
  DiscoveredGtaStream,
} from './ingestion/ingestion.js';
import { fetchChannelProfiles } from './ingestion/twitch-gql.js';
import { allowedLogins, checkClipPermission, deniedLogins, loadPermissions } from './compliance/permissions.js';
import { processPostQueue, recoverPostQueue } from './publishing/post-queue.js';
import { ChannelWorker } from './workers/channel-worker.js';
import { collectMetrics } from './metrics/collect-metrics.js';
import { JobQueue } from './workers/job-queue.js';
import { config } from './utils/config.js';
import { ensureDirectories } from './utils/cleanup.js';
import { log } from './utils/logger.js';
import { acquireProcessLock, releaseProcessLock } from './utils/process-lock.js';
import { applySavedSession, runWizard, shouldRunWizard } from './setup/wizard.js';

/**
 * Supervisor: watches up to MAX_CHANNELS live channels at once (one ChannelWorker each).
 *  - every 5 min: drop channels that ended/reran/were blocked, fill free slots with the biggest streams
 *  - every 1 min: check "allowed" channels (alanzoka, gaules...). When one goes live it gets a slot,
 *    replacing the smallest idle non-priority channel if all slots are full
 *  - every 1 min: post the next queued clip (spaced, one upload at a time)
 *
 *   npm start                         # GTA VI (TARGET_CATEGORIES)
 *   npm start -- --dry-run            # never uploads
 */

const DISCOVERY_INTERVAL_MS = 5 * 60_000;
const PRIORITY_CHECK_MS = 60_000;
const PRIORITY = 10;

/** Reruns/VOD replays are not live moments (and their chat doesn't react to the video) */
const isRerun = (title: string) => /^\s*[\[(]?\s*(rerun|reprise|replay)\b/i.test(title);

const livePriorityChannels = async (): Promise<DiscoveredGtaStream[]> => {
  const registry = await loadPermissions();
  // Channels marked "allowed" + channels the user picked in the wizard (blocked ones excluded)
  const preferred = [
    ...new Set([...allowedLogins(registry), ...config.focusChannels.filter((c) => checkClipPermission(registry, c).allowed)]),
  ];
  if (!preferred.length) return [];
  return (await fetchChannelProfiles(preferred))
    // Priority channels (alanzoka...) are watched whenever they are live: any category, any viewer count
    .filter((p) => p.isLive && !isRerun(p.streamTitle))
    .map((p) => ({ login: p.login, viewersCount: p.viewersCount, title: p.streamTitle, category: p.category }));
};

/** Live candidates, best first: priority channels, then the biggest others */
const findCandidates = async (): Promise<DiscoveredGtaStream[]> => {
  const registry = await loadPermissions();

  if (config.twitchChannel && config.twitchChannel !== 'auto') {
    const perm = checkClipPermission(registry, config.twitchChannel);
    if (!perm.allowed) throw new Error(`${config.twitchChannel} is blocked (${perm.reasons.join('; ')})`);
    return [await resolveTargetChannel(config.twitchChannel)];
  }

  // "Só as lives do cellbit": only the chosen channels, no category discovery
  if (config.onlyFocusChannels) return livePriorityChannels();

  const denied = deniedLogins(registry);
  const others =
    config.permissionMode === 'denylist'
      ? (await discoverLiveGtaVIStreams()).filter(
          (s) =>
            s.login !== 'twitch' &&
            !denied.has(s.login.toLowerCase()) &&
            !isRerun(s.title) &&
            s.viewersCount >= config.minViewers
        )
      : [];

  const seen = new Set<string>();
  return [...(await livePriorityChannels()), ...others].filter((s) => !seen.has(s.login) && !!seen.add(s.login));
};

const startApp = async () => {
  acquireProcessLock();
  // Ask what to clip (terminal) or reuse the last answer (unattended / --no-setup)
  const session = shouldRunWizard() ? await runWizard().catch((e) => (log('WARN', 'Setup', `Wizard failed (${(e as Error).message}); using saved/.env settings`), null)) : await applySavedSession();
  if (session) log('INFO', 'Setup', `Clipping: ${session.onlyChannels ? `channels ${session.channels.join(', ')}` : session.categories.join(' | ')}${session.contentTypes.length ? ` | focus: ${session.contentTypes.join(', ')}` : ''}${session.request ? ` ("${session.request}")` : ''}`);
  log(
    'INFO',
    'Main',
    `Starting clipper: up to ${config.maxChannels} channels, ${config.maxConcurrentJobs} clip job(s) at a time, ` +
      `categories=${config.targetCategories.join(' | ')}, language=${config.streamLanguage}, ` +
      `min ${config.minViewers} viewers (priority channels exempt), posts >= ${config.minMinutesBetweenPosts} min apart per platform` +
      `${config.dryRun ? ', DRY RUN (no uploads)' : ''}${config.growthMode ? ', growth mode' : ''}`
  );
  await ensureDirectories([config.bufferDir, config.outputDir]);
  await recoverPostQueue();

  const queue = new JobQueue(config.maxConcurrentJobs);
  const workers = new Map<string, ChannelWorker>();
  const recentlyEnded = new Map<string, number>(); // login -> time it ended (avoid instant re-join)
  const priorityLogins = new Set([...allowedLogins(await loadPermissions()), ...config.focusChannels]);
  let shuttingDown = false;
  let supervising = false;

  const removeWorker = async (w: ChannelWorker, why: string) => {
    if (!workers.has(w.login)) return;
    workers.delete(w.login);
    recentlyEnded.set(w.login, Date.now());
    log('INFO', 'Main', `Removing ${w.login}: ${why}`);
    await w.stop();
  };

  const addWorker = async (c: DiscoveredGtaStream) => {
    const priority = priorityLogins.has(c.login.toLowerCase()) ? PRIORITY : 0;
    const w = new ChannelWorker(c, queue, priority);
    workers.set(c.login, w);
    w.on('ended', (ended: ChannelWorker) => {
      removeWorker(ended, 'stream ended').then(() => supervise()).catch(() => {});
    });
    await w.start().catch(async (err) => {
      log('ERROR', 'Main', `Could not start ${c.login}: ${(err as Error).message}`);
      await removeWorker(w, 'failed to start');
    });
  };

  const status = () => {
    const q = queue.size;
    log(
      'INFO',
      'Main',
      `Watching ${workers.size}/${config.maxChannels}: ${[...workers.values()].map((w) => `${w.login}${w.priority ? '★' : ''}`).join(', ') || '-'} | jobs running ${q.running}, waiting ${q.pending}`
    );
  };

  /** Every minute: give live priority channels (alanzoka...) a slot, evicting if needed */
  const checkPriority = async () => {
    if (shuttingDown || supervising || config.twitchChannel !== 'auto') return;
    supervising = true; // same lock as supervise(): both add channels, never at the same time
    try {
      const live = (await livePriorityChannels()).filter(
        (c) => !workers.has(c.login) && Date.now() - (recentlyEnded.get(c.login) || 0) > 5 * 60_000
      );
      for (const c of live) {
        if (workers.size >= config.maxChannels) {
          const victim = [...workers.values()]
            .filter((w) => !w.priority && !w.busy)
            .sort((a, b) => a.target.viewersCount - b.target.viewersCount)[0];
          if (!victim) {
            log('WARN', 'Main', `${c.login} is live but every slot is busy with a clip; retrying in 1 min`);
            continue;
          }
          await removeWorker(victim, `making room for priority channel ${c.login}`);
        }
        log('SUCCESS', 'Main', `★ Priority channel ${c.login} is live: "${c.title}" (${c.viewersCount} viewers)`);
        await addWorker(c);
        status();
      }
    } catch (err) {
      log('ERROR', 'Main', `Priority check error: ${(err as Error).message}`);
    } finally {
      supervising = false;
    }
  };

  const supervise = async () => {
    if (shuttingDown || supervising) return;
    supervising = true;
    try {
      // Drop channels that went offline or are now a rerun / outside the category / blocked
      const registry = await loadPermissions();
      if (workers.size) {
        const profiles = await fetchChannelProfiles([...workers.keys()]);
        for (const w of [...workers.values()]) {
          const p = profiles.find((x) => x.login === w.login);
          if (p?.isLive) w.updateViewers(p.viewersCount);
          if (!p?.isLive) await removeWorker(w, 'stream offline');
          else if (isRerun(p.streamTitle)) await removeWorker(w, 'stream switched to a rerun');
          else if (!checkClipPermission(registry, w.login).allowed) await removeWorker(w, 'channel was blocked');
          else if (!w.priority && !matchesTargetCategory(p.category, p.streamTitle) && !w.busy)
            await removeWorker(w, `switched category to ${p.category}`);
          // Hysteresis: drop below 80% of MIN_VIEWERS so a stream around the limit doesn't flap
          else if (!w.priority && !w.busy && p.viewersCount < config.minViewers * 0.8)
            await removeWorker(w, `only ${p.viewersCount} viewers (minimum ${config.minViewers})`);
        }
      }

      // Fill free slots with new live channels
      const free = config.maxChannels - workers.size;
      if (free > 0) {
        const cooldownMs = 15 * 60_000;
        const candidates = (await findCandidates()).filter(
          (c) => !workers.has(c.login) && Date.now() - (recentlyEnded.get(c.login) || 0) > cooldownMs
        );
        for (const c of candidates) {
          if (workers.size >= config.maxChannels) break; // re-check: slots can change while we await
          await addWorker(c);
        }
        if (!candidates.length && !workers.size) {
          log('INFO', 'Main', `No live ${config.targetCategories.join('/')} stream with ${config.minViewers}+ viewers right now (priority channels are checked every minute). Trying again in 5 minutes...`);
        }
      }
      status();
    } catch (err) {
      log('ERROR', 'Main', `Supervisor error: ${(err as Error).message}`);
    } finally {
      supervising = false;
    }
  };

  await supervise();
  const superviseTimer = setInterval(supervise, DISCOVERY_INTERVAL_MS);
  const priorityTimer = setInterval(checkPriority, PRIORITY_CHECK_MS);

  // Post queued clips (spaced, one upload at a time)
  const runPostQueue = () => {
    if (!config.dryRun) processPostQueue().catch((err) => log('ERROR', 'PostQueue', (err as Error).message));
  };
  runPostQueue();
  const queueTimer = setInterval(runPostQueue, 60_000);

  // Every 2 h: views/likes of what we posted -> data/video-metrics.json (fed back into moment picking)
  const runMetrics = () => {
    if (config.dryRun) return;
    collectMetrics()
      .then((v) => log('INFO', 'Metrics', `Updated metrics for ${v.length} posted videos`))
      .catch((err) => log('WARN', 'Metrics', (err as Error).message));
  };
  const metricsTimer = setInterval(runMetrics, 2 * 3600_000);
  setTimeout(runMetrics, 5 * 60_000);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('INFO', 'Main', 'Shutting down: stopping workers, letting running clip jobs finish (Ctrl+C again to force)...');
    clearInterval(superviseTimer);
    clearInterval(priorityTimer);
    clearInterval(queueTimer);
    clearInterval(metricsTimer);
    await Promise.all([...workers.values()].map((w) => w.stop()));
    await queue.idle();
    releaseProcessLock();
    process.exit(0);
  };
  process.on('SIGINT', () => (shuttingDown ? process.exit(1) : shutdown()));
  process.on('SIGTERM', shutdown);
};

startApp().catch((err) => {
  log('ERROR', 'Main', 'Fatal startup error', (err as Error).message);
  process.exit(1);
});
