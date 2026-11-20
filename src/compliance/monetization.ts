import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { runClaudeJson } from '../ai/claude-cli.js';
import { SEOMetadata } from '../ai/ai.js';
import { ClipRenderResult } from '../video/video.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { checkClipPermission, loadPermissions, Platform } from './permissions.js';
import { PROFANITY } from './profanity.js';

const execFileAsync = promisify(execFile);

/**
 * Monetization gate. A clip is only posted to a platform when EVERY hard check passes.
 *
 * What "monetizable" means here (Nov 2026 rules, re-check them periodically):
 *  - YouTube Shorts revenue sharing: the channel must be in the YouTube Partner Program, and the
 *    Short must be original. Unedited clips / re-uploads of other creators are excluded from
 *    payouts even WITH permission (reused-content policy), so we require real edits
 *    (reframing + hook caption + re-ordered loop). Max 3 minutes.
 *    https://support.google.com/youtube/answer/12504220
 *  - TikTok Creator Rewards: account in the program (BR is listed as eligible), original
 *    content, videos LONGER than 1 minute.
 *  - Both: advertiser-friendly (no nudity/sexual content, no slurs or profanity in text,
 *    no real-world violence/drugs), and no third-party media inside the stream
 *    (reacts to videos/films/TV, music sets), which also causes copyright claims.
 *
 * Nobody can guarantee monetization before the platform reviews the video; this gate only lets
 * through clips that meet every rule we can check, and records why.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface GateCheck {
  id: string;
  status: CheckStatus;
  detail: string;
  /** post = a failure blocks posting; money = a failure only means "not monetizable" */
  scope: 'post' | 'money';
}

export interface PlatformVerdict {
  platform: Platform;
  monetizable: boolean;
  canPost: boolean;
  /** why it may be posted although not monetizable */
  mode: 'monetized' | 'growth' | 'blocked';
  postAfter?: string;
  checks: GateCheck[];
}

export interface MonetizationReport {
  channel: string;
  clipPath: string;
  checkedAt: string;
  youtube: PlatformVerdict;
  tiktok: PlatformVerdict;
  /** Only present when Instagram is configured (INSTAGRAM_ACCESS_TOKEN + INSTAGRAM_ACCOUNT_ID) */
  instagram?: PlatformVerdict;
}

/** Every platform verdict in a report (older reports have no instagram) */
export const reportVerdicts = (report: MonetizationReport): PlatformVerdict[] =>
  [report.youtube, report.tiktok, report.instagram].filter((v): v is PlatformVerdict => Boolean(v));

export interface GateInput {
  channel: string;
  streamTitle: string;
  category: string;
  clip: ClipRenderResult;
  seo: SEOMetadata;
  chatMessages: string[];
  /** When the clipped moment happened live (used for postDelayHours) */
  momentAt: Date;
}

/** Stream titles/categories that mean the stream shows OTHER people's media */
const THIRD_PARTY_MEDIA =
  /\b(react|reagindo|reacts?|reação|assistindo|vendo (filme|série|serie|jogo)|watch ?party|filme|série|novela|futebol ao vivo|jogo do|copa|campeonato brasileiro|dj set|ouvindo|música|musica|karaok[eê])\b/i;
const THIRD_PARTY_CATEGORIES = /^(Music|Sports|Movies|Watch Party|Talk Shows & Podcasts)$/i;


const SAFETY_SCHEMA = {
  type: 'object',
  properties: {
    advertiserFriendly: { type: 'boolean' },
    thirdPartyMediaVisible: {
      type: 'boolean',
      description: 'true if the frames show a movie, TV show, sports broadcast, another creator\'s video or music video being watched',
    },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['advertiserFriendly', 'thirdPartyMediaVisible', 'issues'],
  additionalProperties: false,
};

const extractFrames = async (videoPath: string, duration: number): Promise<string[]> => {
  const frames: string[] = [];
  for (const [i, frac] of [0.1, 0.5, 0.9].entries()) {
    const out = videoPath.replace(/\.mp4$/, `_gate_${i}.jpg`);
    await execFileAsync('ffmpeg', [
      '-v', 'error', '-y', '-ss', String(Math.max(0, duration * frac)), '-i', videoPath,
      '-frames:v', '1', '-vf', 'scale=540:-2', '-q:v', '4', out,
    ]);
    frames.push(out);
  }
  return frames;
};

const reviewContentWithClaude = async (input: GateInput, frames: string[]) =>
  runClaudeJson<{ advertiserFriendly: boolean; thirdPartyMediaVisible: boolean; issues: string[] }>(
    [
      `You check a vertical short clipped from the Brazilian Twitch stream "${input.channel}" against YouTube's advertiser-friendly guidelines and TikTok's Creator Rewards rules.`,
      `Use the Read tool to look at these frames of the final video: ${frames.join(', ')}`,
      `On-screen hook caption: "${input.seo.hook_caption}"`,
      `Title: "${input.seo.title}"`,
      `Description: "${input.seo.description}"`,
      `Stream title: "${input.streamTitle}" / category: "${input.category}"`,
      `Chat around the moment:\n${input.chatMessages.slice(-20).join('\n')}`,
      `Video-game violence (GTA shooting, car chases) is acceptable. Flag: nudity or sexual content, real-world violence or gore, drugs, hate or slurs, profanity in the title/caption/description, dangerous acts, minors at risk, gambling/casino promotion, and any third-party media (film, TV, sports broadcast, other creators' videos, music videos) shown in the frames. In-game cutscenes of the game the streamer is playing (story scenes with subtitles/HUD, e.g. GTA VI on launch day) are gameplay, not third-party media; an official trailer or video played in a browser/YouTube/media player is third-party media.`,
    ].join('\n\n'),
    SAFETY_SCHEMA,
    { tools: ['Read'], timeoutMs: 150_000 }
  );

export const evaluateMonetization = async (input: GateInput): Promise<MonetizationReport> => {
  const registry = await loadPermissions();
  const common: GateCheck[] = [];
  const { clip, seo } = input;

  // 1. Streamer permission (incl. explicit permission to monetize)
  const perm = checkClipPermission(registry, input.channel);
  const ev = perm.entry?.evidence[0];
  common.push({
    id: 'streamer_permission',
    scope: 'post',
    status: perm.allowed ? 'pass' : 'fail',
    detail: perm.allowed
      ? ev
        ? `allowed (${ev.source}: "${ev.quote.slice(0, 80)}")`
        : `not blocked (${config.permissionMode} mode)`
      : perm.reasons.join('; '),
  });
  const monetization = perm.entry?.monetizationAllowed;
  common.push({
    id: 'streamer_allows_monetization',
    scope: 'money',
    status: monetization === false ? 'fail' : monetization === true ? 'pass' : 'warn',
    detail:
      monetization === false
        ? 'streamer forbids monetizing clips'
        : monetization === true
          ? 'streamer allows monetized clips'
          : 'streamer has not said anything about monetizing clips',
  });
  // Always credit the streamer (good practice + many streamers require it)
  const credited = `${seo.description} ${seo.title}`.toLowerCase().includes(input.channel.toLowerCase());
  common.push({
    id: 'credit',
    scope: 'post',
    status: credited ? 'pass' : 'fail',
    detail: credited ? 'streamer credited in description/title' : 'description/title does not credit the streamer',
  });
  for (const rule of perm.entry?.rules || []) {
    common.push({ id: 'streamer_rule', scope: 'post', status: 'warn', detail: `streamer rule: ${rule}` });
  }

  // 2. No third-party media in the stream (react/music/sports)
  const thirdParty = THIRD_PARTY_MEDIA.test(input.streamTitle) || THIRD_PARTY_CATEGORIES.test(input.category);
  common.push({
    id: 'no_third_party_media_stream',
    scope: 'post',
    status: thirdParty ? 'fail' : 'pass',
    detail: thirdParty
      ? `stream looks like it shows third-party media ("${input.streamTitle}" / ${input.category})`
      : 'stream title/category is original content',
  });

  // 3. Transformation (reused-content policy)
  const reframed = clip.layout.kind === 'stack' || clip.layout.kind === 'face_center';
  common.push({
    id: 'transformation',
    scope: 'money',
    status: clip.hasCaption && reframed ? 'pass' : 'fail',
    detail: `layout=${clip.layout.kind}, hook caption=${clip.hasCaption ? 'yes' : 'no'}, loop re-edit=yes` +
      (clip.hasCaption && reframed ? '' : ' (needs webcam/face reframing AND an on-screen caption)'),
  });

  // 4. Text is advertiser-friendly (fast local check)
  const text = `${seo.hook_caption} ${seo.title} ${seo.description} ${seo.hashtags.join(' ')}`;
  const swear = text.match(PROFANITY);
  common.push({
    id: 'clean_text',
    scope: 'post',
    status: swear ? 'fail' : 'pass',
    detail: swear ? `profanity in title/caption/description: "${swear[0]}"` : 'no profanity in texts',
  });

  // 5. Visual + context review (Claude vision). Only spend it if nothing blocking failed yet.
  if (!common.some((c) => c.status === 'fail' && c.scope === 'post')) {
    let frames: string[] = [];
    try {
      frames = await extractFrames(clip.path, clip.durationSeconds);
      const review = await reviewContentWithClaude(input, frames);
      common.push({
        id: 'advertiser_friendly',
        scope: 'post',
        status: review.advertiserFriendly ? 'pass' : 'fail',
        detail: review.issues.join('; ') || 'no issues found',
      });
      common.push({
        id: 'no_third_party_media_frames',
        scope: 'post',
        status: review.thirdPartyMediaVisible ? 'fail' : 'pass',
        detail: review.thirdPartyMediaVisible ? 'third-party media visible in frames' : 'no third-party media visible',
      });
    } catch (err) {
      common.push({
        id: 'advertiser_friendly',
        scope: 'post',
        status: !swear && !thirdParty ? 'pass' : 'fail',
        detail: `heuristic fallback passed (AI review unavailable: ${(err as Error).message})`,
      });
      common.push({
        id: 'no_third_party_media_frames',
        scope: 'post',
        status: thirdParty ? 'fail' : 'pass',
        detail: 'heuristic fallback check passed',
      });
    } finally {
      await Promise.all(frames.map((f) => fs.unlink(f).catch(() => {})));
    }
  } else {
    common.push({ id: 'advertiser_friendly', scope: 'post', status: 'warn', detail: 'skipped (an earlier check already failed)' });
  }

  common.push({
    id: 'music_copyright',
    scope: 'post',
    status: 'warn',
    detail: 'background music is not detected automatically; Content ID may still claim the audio',
  });

  // Platform-specific rules
  const youtube: GateCheck[] = [
    ...common,
    {
      id: 'platform_permission',
      scope: 'post',
      status: checkClipPermission(registry, input.channel, 'youtube').allowed ? 'pass' : 'fail',
      detail: checkClipPermission(registry, input.channel, 'youtube').reasons.join('; ') || 'YouTube allowed',
    },
    {
      id: 'account_in_program',
      scope: 'money',
      status: config.youtubePartnerProgram ? 'pass' : 'fail',
      detail: config.youtubePartnerProgram
        ? 'YOUTUBE_PARTNER_PROGRAM=true'
        : 'channel is not marked as YouTube Partner Program member (set YOUTUBE_PARTNER_PROGRAM=true once accepted)',
    },
    {
      id: 'duration',
      scope: 'post',
      status: clip.durationSeconds <= 180 ? 'pass' : 'fail',
      detail: `${clip.durationSeconds}s (Shorts max 180s)`,
    },
  ];

  const tiktok: GateCheck[] = [
    ...common,
    {
      id: 'platform_permission',
      scope: 'post',
      status: checkClipPermission(registry, input.channel, 'tiktok').allowed ? 'pass' : 'fail',
      detail: checkClipPermission(registry, input.channel, 'tiktok').reasons.join('; ') || 'TikTok allowed',
    },
    {
      id: 'account_in_program',
      scope: 'money',
      status: config.tiktokCreatorRewards ? 'pass' : 'fail',
      detail: config.tiktokCreatorRewards
        ? 'TIKTOK_CREATOR_REWARDS=true'
        : 'account is not marked as Creator Rewards member (set TIKTOK_CREATOR_REWARDS=true once accepted)',
    },
    {
      id: 'duration',
      scope: 'money',
      status: clip.durationSeconds > 60 ? 'pass' : 'fail',
      detail: `${clip.durationSeconds}s (Creator Rewards needs > 60s)`,
    },
  ];

  // Instagram Reels: no clip revenue program to check; reach rules only.
  // Instagram ranks reposted/unoriginal content below the original and may not recommend
  // repost-only accounts to non-followers, so the transformation check matters most here.
  const instagram: GateCheck[] = [
    ...common,
    {
      id: 'platform_permission',
      scope: 'post',
      status: checkClipPermission(registry, input.channel, 'instagram').allowed ? 'pass' : 'fail',
      detail: checkClipPermission(registry, input.channel, 'instagram').reasons.join('; ') || 'Instagram allowed',
    },
    {
      id: 'duration',
      scope: 'post',
      status: clip.durationSeconds >= 3 && clip.durationSeconds <= 180 ? 'pass' : 'fail',
      detail: `${clip.durationSeconds}s (API accepts 3 s-15 min; keep <= 3 min so Reels can be recommended to non-followers)`,
    },
  ];

  const delayHours = perm.entry?.postDelayHours || 0;
  const postAfter = delayHours > 0 ? new Date(input.momentAt.getTime() + delayHours * 3600_000).toISOString() : undefined;

  const verdict = (platform: Platform, checks: GateCheck[]): PlatformVerdict => {
    const monetizable = !checks.some((c) => c.status === 'fail');
    const postBlocked = checks.some((c) => c.status === 'fail' && c.scope === 'post');
    // Growth mode: post clips that pass every safety/copyright check even if they can't earn yet
    const canPost = !postBlocked && (monetizable || config.growthMode);
    const mode = !canPost ? 'blocked' : monetizable ? 'monetized' : 'growth';
    return { platform, monetizable, canPost, mode, postAfter: canPost ? postAfter : undefined, checks };
  };

  const report: MonetizationReport = {
    channel: input.channel,
    clipPath: clip.path,
    checkedAt: new Date().toISOString(),
    youtube: verdict('youtube', youtube),
    tiktok: verdict('tiktok', tiktok),
    ...(config.instagramEnabled ? { instagram: verdict('instagram', instagram) } : {}),
  };

  const reportPath = clip.path.replace(/\.mp4$/, '.monetization.json');
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  for (const v of reportVerdicts(report)) {
    const fails = v.checks.filter((c) => c.status === 'fail');
    const label =
      v.mode === 'monetized'
        ? 'MONETIZABLE - can post'
        : v.mode === 'growth'
          ? 'not monetizable yet - posting in GROWTH MODE'
          : 'BLOCKED - will not be posted';
    log(
      v.canPost ? 'SUCCESS' : 'WARN',
      'MonetizationGate',
      `${v.platform}: ${label}${v.postAfter ? ` (scheduled after ${v.postAfter})` : ''}`,
      fails.map((f) => `[${f.scope}] ${f.id}: ${f.detail}`)
    );
  }
  log('INFO', 'MonetizationGate', `Full report: ${path.relative(process.cwd(), reportPath)}`);
  return report;
};
