import fs from 'fs/promises';
import path from 'path';
import { DiscoveredGtaStream, TimedChatMessage } from './ingestion/ingestion.js';
import { extractClipWithClaudeAgent, factCheckSEO, generateSEO } from './ai/ai.js';
import { gameKeyword } from './ai/game-profile.js';
import { computeMomentSignals, extractMomentFrames, removeFiles } from './ai/moment-signals.js';
import { pastPerformanceSummary } from './metrics/performance.js';
import { createInfiniteLoopClip, getVideoDurationSeconds } from './video/video.js';
import { evaluateMonetization, MonetizationReport } from './compliance/monetization.js';
import { enqueueClip, publishOrQueue } from './publishing/post-queue.js';
import { config } from './utils/config.js';
import { log } from './utils/logger.js';
import {
  checkMomentDuplicate,
  recordClippedRange,
  getAlreadyClippedSeconds,
} from './utils/clipped-ranges.js';

export interface ClipJobInput {
  target: DiscoveredGtaStream;
  snapshotPath: string;
  /** wall-clock ms when the snapshot's last segment finished recording */
  snapshotEndMs: number;
  timedMessages: TimedChatMessage[];
  triggeredAt: Date;
  /** queue = spaced posting (npm start); direct = upload now (tests) */
  publishMode?: 'queue' | 'direct';
  /** Higher = posted first from the queue (allowed channels like alanzoka) */
  priority?: number;
}

export interface ClipJobResult {
  status: 'skipped' | 'done';
  reason: string;
  clipPath?: string;
  report?: MonetizationReport;
  published?: Record<string, string>;
  seo?: unknown;
  moment?: unknown;
}

/** Minimum numeric reaction before we even ask Claude (cheap pre-filter) */
const MIN_SIGNAL_Z = 1.5;

/**
 * One clip, start to finish:
 * reaction signals -> pick the moment (Claude + frames) -> SEO -> render -> gate -> publish/queue.
 * Skips moments without a real reaction. The snapshot is deleted afterwards.
 */
export const processClip = async (job: ClipJobInput): Promise<ClipJobResult> => {
  const { target, snapshotPath } = job;
  const tag = `Clip:${target.login}`;
  // GTA V streams that are about GTA 6 (launch day) get GTA 6 titles, not "GTA RP"
  const game =
    target.category === 'Grand Theft Auto V' && /gta\s*(6|vi)\b/i.test(target.title) ? 'Grand Theft Auto VI' : target.category;
  let frames: string[] = [];
  try {
    const duration = await getVideoDurationSeconds(snapshotPath);
    const signals = await computeMomentSignals(snapshotPath, duration, job.timedMessages, job.snapshotEndMs);
    const best = signals.bestReaction;
    log('INFO', tag, `1/5 Reaction signals: best audio ${best.audioZ}σ, best chat ${best.chatZ}σ`, signals.candidates.map((c) => `${c.second}s score ${c.score} (screen ${c.visualZ}σ)`));

    if (best.audioZ < MIN_SIGNAL_Z && best.chatZ < MIN_SIGNAL_Z) {
      const reason = `no reaction in audio or chat (audio ${best.audioZ}σ, chat ${best.chatZ}σ)`;
      log('INFO', tag, `Skipped: ${reason}`);
      return { status: 'skipped', reason };
    }

    // Frames around the 3 best candidates, so Claude sees the gameplay action itself (build-up, impact, aftermath)
    const frameSeconds = signals.candidates.slice(0, 3).flatMap((c) => [c.second - 3, c.second, c.second + 3, c.second + 7]);
    frames = await extractMomentFrames(snapshotPath, frameSeconds, snapshotPath.replace(/\.mp4$/, '_moment'));
    const frameRefs = frames.map((f) => ({ second: Number(f.match(/_(\d+)s\.jpg$/)?.[1] || 0), path: f }));

    // Tell Claude which part of this recording was already posted (in buffer seconds)
    const already = await getAlreadyClippedSeconds(target.login, job.snapshotEndMs, duration);

    log('INFO', tag, `2/5 Choosing the moment...${already.length ? ` (already clipped: ${already.map((r) => `${r.from}-${r.to}s`).join(', ')})` : ''}`);
    const decision = await extractClipWithClaudeAgent({
      bufferDurationSeconds: duration,
      chatMessages: job.timedMessages.map((m) => m.line),
      channel: target.login,
      game,
      signals,
      frames: frameRefs,
      pastPerformance: await pastPerformanceSummary().catch(() => undefined),
      alreadyClipped: already,
    });
    log('INFO', tag, `Moment: ${decision.moment_type}, virality ${decision.virality_score}/10`);
    if (decision.third_party_media) {
      const reason = `streamer is watching third-party media (copyright): ${decision.what_happened}`;
      log('INFO', tag, `Skipped: ${reason}`);
      return { status: 'skipped', reason, moment: decision };
    }
    if (!decision.has_reaction) {
      const reason = `no real reaction (${decision.streamer_reaction} / ${decision.chat_reaction}): ${decision.what_happened}`;
      log('INFO', tag, `Skipped: ${reason}`);
      return { status: 'skipped', reason, moment: decision };
    }

    // Duplicate guard: the chosen moment overlaps a clip we already made of this channel
    const chosen = {
      startMs: job.snapshotEndMs - (duration - decision.clip_start) * 1000,
      endMs: job.snapshotEndMs - (duration - decision.clip_end) * 1000,
      climaxMs: job.snapshotEndMs - (duration - decision.hook_split_point) * 1000,
    };
    const dupCheck = await checkMomentDuplicate(target.login, chosen);
    if (dupCheck.isDuplicate) {
      const reason = `same moment as a clip already made (${dupCheck.overlapSeconds}s overlap${dupCheck.conflictTitle ? ` with "${dupCheck.conflictTitle}"` : ''}): ${decision.what_happened}`;
      log('INFO', tag, `Skipped: ${reason}`);
      return { status: 'skipped', reason, moment: decision };
    }

    if (decision.virality_score < config.minViralityScore) {
      const reason = `virality ${decision.virality_score}/10 < ${config.minViralityScore} (${decision.moment_type}): ${decision.what_happened}`;
      log('INFO', tag, `Skipped: ${reason}`);
      return { status: 'skipped', reason, moment: decision };
    }

    const draftSeo = await generateSEO({
      channel: target.login,
      chatMessages: job.timedMessages.map((m) => m.line),
      clipReason: decision.reason,
      game,
      moment: decision,
    });

    // 2nd-Stage Vision Quality Gate & Fact-Check against frames spread over the whole chosen clip
    const span = decision.clip_end - decision.clip_start;
    const step = Math.max(2, span / 10);
    const checkSeconds: number[] = [];
    for (let t = decision.clip_start + 1; t < decision.clip_end; t += step) checkSeconds.push(Math.round(t));
    const checkFrames = await extractMomentFrames(snapshotPath, checkSeconds, snapshotPath.replace(/\.mp4$/, '_check'));
    frames.push(...checkFrames);
    const quality = await factCheckSEO(draftSeo, {
      channel: target.login,
      frames: checkFrames.map((f) => ({ second: Number(f.match(/_(\d+)s\.jpg$/)?.[1] || 0), path: f })),
      moment: decision,
    });

    if (!quality.approved || quality.verifiedViralityScore < config.minViralityScore) {
      const reason = `rejected by 2nd-stage Vision Quality Gate (verified score ${quality.verifiedViralityScore}/10): ${quality.rejectionReason || decision.what_happened}`;
      log('INFO', tag, `Skipped: ${reason}`);
      return { status: 'skipped', reason, moment: decision };
    }

    const { seo, problems } = quality;
    decision.virality_score = quality.verifiedViralityScore;

    // Apply dead-air trimming if the vision validator detected dead lead-in or dead tail
    if (
      quality.trimmedStart !== undefined &&
      quality.trimmedEnd !== undefined &&
      quality.trimmedStart >= decision.clip_start &&
      quality.trimmedEnd <= decision.clip_end &&
      quality.trimmedEnd - quality.trimmedStart >= 16 &&
      quality.trimmedEnd - quality.trimmedStart <= config.clipMaxSeconds
    ) {
      if (quality.trimmedStart !== decision.clip_start || quality.trimmedEnd !== decision.clip_end) {
        log(
          'INFO',
          tag,
          `Trimmed dead air from clip: [${decision.clip_start}s..${decision.clip_end}s] -> [${quality.trimmedStart}s..${quality.trimmedEnd}s]`
        );
        decision.clip_start = Number(quality.trimmedStart.toFixed(2));
        decision.clip_end = Number(quality.trimmedEnd.toFixed(2));
        if (decision.hook_split_point <= decision.clip_start + 1 || decision.hook_split_point >= decision.clip_end - 1) {
          decision.hook_split_point = Number(((decision.clip_start + decision.clip_end) / 2).toFixed(2));
        }
      }
    }

    if (problems.length) log('INFO', tag, `Fact-check fixed: "${draftSeo.title}" -> "${seo.title}"`);

    log('INFO', tag, '3/5 Rendering 9:16 clip...');
    const finalClipPath = path.join(config.outputDir, `clip_${target.login}_${job.triggeredAt.getTime()}_9x16.mp4`);

    // Remember it permanently in data/clipped-ranges.json so restarts/future spikes don't re-clip it
    await recordClippedRange({
      channel: target.login,
      startMs: chosen.startMs,
      endMs: chosen.endMs,
      climaxMs: chosen.climaxMs,
      clipPath: finalClipPath,
      title: seo.title,
      createdAt: new Date().toISOString(),
    });
    const clip = await createInfiniteLoopClip(snapshotPath, finalClipPath, decision, seo.hook_caption, undefined, {
      badge: gameKeyword(game),
    });
    await fs.writeFile(
      finalClipPath.replace(/\.mp4$/, '.seo.json'),
      JSON.stringify({ ...seo, moment: decision, factCheck: problems.length ? { before: draftSeo, problems } : 'ok' }, null, 2)
    );

    log('INFO', tag, '4/5 Monetization gate...');
    const report = await evaluateMonetization({
      channel: target.login,
      streamTitle: target.title,
      category: target.category,
      clip,
      seo,
      chatMessages: job.timedMessages.map((m) => m.line),
      momentAt: job.triggeredAt,
    });

    if (config.dryRun) {
      log('SUCCESS', tag, `5/5 DRY RUN - not uploaded. youtube=${report.youtube.mode} tiktok=${report.tiktok.mode}${report.instagram ? ` instagram=${report.instagram.mode}` : ''}`, {
        clip: path.relative(process.cwd(), clip.path),
        caption: seo.hook_caption,
        title: seo.title,
      });
      return { status: 'done', reason: 'dry run', clipPath: clip.path, report, seo, moment: decision };
    }
    log('INFO', tag, `5/5 Publishing (${config.growthMode ? 'growth mode' : 'monetized only'})...`);
    const published =
      job.publishMode === 'direct' ? await publishOrQueue(report, seo) : await enqueueClip(report, seo, job.priority ?? 0, decision.virality_score);
    log('SUCCESS', tag, 'Done', published);
    return { status: 'done', reason: 'processed', clipPath: clip.path, report, published, seo, moment: decision };
  } finally {
    await removeFiles([snapshotPath, ...frames]);
  }
};
