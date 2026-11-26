import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ quiet: true }); // dotenv 17+ logs "injected env" on every load otherwise

export interface AppConfig {
  twitchChannel: string;
  /** First target category (kept for prompts/messages) */
  targetCategory: string;
  /** Categories to clip, e.g. ["Grand Theft Auto VI"]. ["any"] = every category (testing) */
  targetCategories: string[];
  /** Normal (non-priority) channels need at least this many viewers */
  minViewers: number;
  /** How many live channels are watched at the same time */
  maxChannels: number;
  /** How many clips are processed (Claude + FFmpeg) at the same time */
  maxConcurrentJobs: number;
  /** Minimum minutes between two posts on the same platform (npm start queue) */
  minMinutesBetweenPosts: number;
  /** Daily posting plan per platform: at least `min` (target), never more than `max` */
  postsPerDay: Record<'youtube' | 'tiktok' | 'instagram', { min: number; max: number }>;
  /** Local hours when posting is allowed: [start, end) e.g. 10-23 */
  postHours: { start: number; end: number };
  /** Only clips scored at least this are posted (lowered to minViralityScore when behind the daily minimum) */
  minPostScore: number;
  /** Queued clips older than this are dropped as stale */
  maxQueueAgeHours: number;
  /** Clips scored below this (1-10, by Claude) are not posted */
  minViralityScore: number;
  /** Render + check everything but never upload (also via `--dry-run`) */
  dryRun: boolean;
  /** Twitch broadcaster language code used to discover streams (e.g. PT, EN, ES) */
  streamLanguage: string;
  /** Locale used for titles, descriptions and hashtags (pt-BR or pt-PT) */
  contentLocale: string;
  /** auto = AI detects webcam; stack = webcam top / gameplay bottom; blur = full frame on blurred bg; center = plain center crop */
  videoLayout: 'auto' | 'stack' | 'blur' | 'center';
  /** Optional manual webcam box "x,y,w,h" as fractions 0-1 of the frame (skips AI detection) */
  facecamRegion: string;
  /** Optional manual gameplay box "x,y,w,h" as fractions 0-1 of the frame */
  gameplayRegion: string;
  /** auto = pick small/normal/big rules from the viewer count */
  chatTier: 'auto' | 'small' | 'normal' | 'big' | 'huge';
  /** Categories scanned by `npm run scan:permissions` */
  scanCategories: string[];
  /** Clip length range in seconds (TikTok Creator Rewards needs > 60 s) */
  clipMinSeconds: number;
  clipMaxSeconds: number;
  /** Is the posting account accepted in these programs? (cannot be read from the APIs) */
  /** denylist = clip every channel except blocked ones; allowlist = only verified permission */
  permissionMode: 'denylist' | 'allowlist';
  /** true = post even when the accounts are not yet in YPP / Creator Rewards (to grow them) */
  growthMode: boolean;
  youtubePartnerProgram: boolean;
  youtubePrivacy: 'private' | 'unlisted' | 'public';
  tiktokCreatorRewards: boolean;
  chatSpikeThreshold: number;
  chatWindowSeconds: number;
  segmentDurationSeconds: number;
  segmentWrapCount: number;
  claudeCliPath: string;
  nineRouterEndpoint: string;
  nineRouterModel: string;
  nineRouterApiKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRefreshToken: string;
  tiktokCookiesPath: string;
  /** Cookie-Editor export from youtube.com, used by the YouTube Studio browser uploader */
  youtubeCookiesPath: string;
  /** Persistent Chromium profile for YouTube Studio uploads (keeps Google's rotating session alive) */
  youtubeProfileDir: string;
  /** browser = YouTube Studio (public works); api = Data API (locked private on unverified projects) */
  youtubeUploadMethod: 'browser' | 'api';
  tiktokSessionCookie: string;
  instagramAccessToken: string;
  instagramAccountId: string;
  /** Graph API version used for Reels publishing */
  instagramApiVersion: string;
  /** true when Instagram credentials are set: clips are also queued as Reels */
  instagramEnabled: boolean;
  /** auto = burn Whisper subtitles when whisper-cli + model exist; off = never */
  subtitles: 'auto' | 'off';
  whisperCliPath: string;
  whisperModelPath: string;
  /** Silero VAD model: stops Whisper looping/hallucinating on game audio */
  whisperVadModelPath: string;
  /** Delete output/clip_*.mp4 once every platform it was queued for is done and it was posted somewhere */
  deleteClipsAfterPost: boolean;
  /** Also delete never-posted clips (expired/blocked) older than this many hours. 0 = keep them */
  deleteUnpostedClipsAfterHours: number;
  /** Channels the user asked for in the startup wizard: watched whenever live, any category */
  focusChannels: string[];
  /** true = watch only focusChannels (no category discovery) */
  onlyFocusChannels: boolean;
  /** What kind of moments the user asked for (wizard); steers the moment picker */
  contentFocus: { request: string; types: string[] } | null;
  /** auto = upload with TikTok Studio (browser); manual = export clip + caption to a phone-synced folder */
  tiktokMode: 'auto' | 'manual';
  /** Folder for manual TikTok exports (default iCloud Drive/Stream Clipper/TikTok) */
  tiktokManualDir: string;
  /** Manual exports older than this many days are removed */
  tiktokManualKeepDays: number;
  /** Follow-CTA A/B test variants (none,end,pulse); clips rotate between them */
  ctaVariants: string[];
  /** Text of the follow CTA pill */
  ctaText: string;
  bufferDir: string;
  outputDir: string;
}

const targetCategories = (process.env.TARGET_CATEGORIES || process.env.TARGET_CATEGORY || 'Grand Theft Auto VI')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

export const config: AppConfig = {
  twitchChannel: process.env.TWITCH_CHANNEL || 'auto',
  targetCategory: targetCategories[0],
  targetCategories,
  maxChannels: Math.max(1, Number(process.env.MAX_CHANNELS || 3)),
  minViewers: Math.max(0, Number(process.env.MIN_VIEWERS ?? 1000)),
  maxConcurrentJobs: Math.max(1, Number(process.env.MAX_CONCURRENT_JOBS || 1)),
  minMinutesBetweenPosts: Math.max(0, Number(process.env.MIN_MINUTES_BETWEEN_POSTS ?? 10)),
  maxQueueAgeHours: Math.max(0.5, Number(process.env.MAX_QUEUE_AGE_HOURS || 3)),
  postsPerDay: Object.fromEntries(
    (['youtube', 'tiktok', 'instagram'] as const).map((p) => {
      const P = p.toUpperCase();
      const max = Math.max(1, Number(process.env[`POSTS_PER_DAY_MAX_${P}`] || process.env.POSTS_PER_DAY_MAX || 10));
      const min = Math.min(max, Math.max(0, Number(process.env[`POSTS_PER_DAY_MIN_${P}`] || process.env.POSTS_PER_DAY_MIN || 5)));
      return [p, { min, max }];
    })
  ) as AppConfig['postsPerDay'],
  postHours: (() => {
    const m = (process.env.POST_HOURS || '10-23').match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
    const start = m ? Math.min(23, Number(m[1])) : 10;
    const end = m ? Math.min(24, Number(m[2])) : 23;
    return end > start ? { start, end } : { start: 10, end: 23 };
  })(),
  minPostScore: Math.min(10, Math.max(1, Number(process.env.MIN_POST_SCORE || 8))),
  minViralityScore: Math.min(10, Math.max(7, Number(process.env.MIN_VIRALITY_SCORE || 7))),
  dryRun: process.env.DRY_RUN === 'true' || process.argv.includes('--dry-run'),
  streamLanguage: (process.env.STREAM_LANGUAGE || 'PT').toUpperCase(),
  contentLocale: process.env.CONTENT_LOCALE || 'pt-BR',
  videoLayout: (['auto', 'stack', 'blur', 'center'].includes(process.env.VIDEO_LAYOUT || '')
    ? process.env.VIDEO_LAYOUT
    : 'auto') as AppConfig['videoLayout'],
  facecamRegion: process.env.FACECAM_REGION || '',
  gameplayRegion: process.env.GAMEPLAY_REGION || '',
  chatTier: (['small', 'normal', 'big', 'huge'].includes(process.env.CHAT_TIER || '')
    ? process.env.CHAT_TIER
    : 'auto') as AppConfig['chatTier'],
  scanCategories: (
    process.env.SCAN_CATEGORIES ||
    'Grand Theft Auto VI,Grand Theft Auto V,Just Chatting,Minecraft,Counter-Strike,VALORANT,League of Legends,Fortnite'
  )
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean),
  // Growth mode: tight clips (18-38s) with zero dead padding for maximum retention. Monetized: > 60 s for TikTok Creator Rewards.
  clipMinSeconds: Number(process.env.CLIP_MIN_SECONDS || (process.env.GROWTH_MODE === 'true' ? 18 : 62)),
  clipMaxSeconds: Number(process.env.CLIP_MAX_SECONDS || (process.env.GROWTH_MODE === 'true' ? 38 : 90)),
  permissionMode: process.env.PERMISSION_MODE === 'allowlist' ? 'allowlist' : 'denylist',
  growthMode: process.env.GROWTH_MODE === 'true',
  youtubePartnerProgram: process.env.YOUTUBE_PARTNER_PROGRAM === 'true',
  youtubePrivacy: (['private', 'unlisted', 'public'].includes(process.env.YOUTUBE_PRIVACY || '')
    ? process.env.YOUTUBE_PRIVACY
    : 'private') as AppConfig['youtubePrivacy'],
  tiktokCreatorRewards: process.env.TIKTOK_CREATOR_REWARDS === 'true',
  chatSpikeThreshold: Number(process.env.CHAT_SPIKE_THRESHOLD || 20),
  chatWindowSeconds: Number(process.env.CHAT_WINDOW_SECONDS || 10),
  segmentDurationSeconds: Number(process.env.SEGMENT_DURATION_SECONDS || 30),
  segmentWrapCount: Number(process.env.SEGMENT_WRAP_COUNT || 10),
  claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude',
  nineRouterEndpoint:
    process.env.NINEROUTER_ENDPOINT || 'http://localhost:20128/v1/chat/completions',
  nineRouterModel: process.env.NINEROUTER_MODEL || 'code',
  nineRouterApiKey: process.env.NINEROUTER_API_KEY || 'local-9router',
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || '',
  tiktokCookiesPath:
    process.env.TIKTOK_COOKIES_PATH || path.resolve(process.cwd(), 'cookies/tiktok.json'),
  tiktokSessionCookie: process.env.TIKTOK_SESSION_COOKIE || '',
  youtubeCookiesPath:
    process.env.YOUTUBE_COOKIES_PATH || path.resolve(process.cwd(), 'cookies/youtube.json'),
  youtubeProfileDir: path.resolve(process.cwd(), process.env.YOUTUBE_PROFILE_DIR || 'browser-profile/youtube'),
  youtubeUploadMethod: process.env.YOUTUBE_UPLOAD_METHOD === 'api' ? 'api' : 'browser',
  instagramAccessToken: process.env.INSTAGRAM_ACCESS_TOKEN || '',
  instagramAccountId: process.env.INSTAGRAM_ACCOUNT_ID || '',
  instagramApiVersion: process.env.INSTAGRAM_API_VERSION || 'v27.0',
  instagramEnabled:
    process.env.INSTAGRAM_ENABLED !== 'false' && Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID),
  subtitles: process.env.SUBTITLES === 'off' ? 'off' : 'auto',
  whisperCliPath: process.env.WHISPER_CLI_PATH || 'whisper-cli',
  whisperModelPath: path.resolve(process.cwd(), process.env.WHISPER_MODEL || 'models/ggml-large-v3-turbo-q5_0.bin'),
  whisperVadModelPath: path.resolve(process.cwd(), process.env.WHISPER_VAD_MODEL || 'models/ggml-silero-v5.1.2.bin'),
  deleteClipsAfterPost: process.env.DELETE_CLIPS_AFTER_POST !== 'false',
  deleteUnpostedClipsAfterHours: Math.max(0, Number(process.env.DELETE_UNPOSTED_CLIPS_AFTER_HOURS || 0)),
  tiktokMode: process.env.TIKTOK_MODE === 'manual' ? 'manual' : 'auto',
  tiktokManualDir: process.env.TIKTOK_MANUAL_DIR || '',
  tiktokManualKeepDays: Math.max(1, Number(process.env.TIKTOK_MANUAL_KEEP_DAYS || 3)),
  ctaVariants: (process.env.CTA_VARIANTS || 'none,end,pulse').split(',').map((v) => v.trim()).filter(Boolean),
  ctaText: process.env.CTA_TEXT || 'Siga para mais',
  focusChannels: (process.env.FOCUS_CHANNELS || '').split(',').map((c) => c.trim().toLowerCase()).filter(Boolean),
  onlyFocusChannels: false,
  contentFocus: null,
  // BUFFER_DIR / OUTPUT_DIR let tests use temp folders (the post queue's cleanup deletes files there)
  bufferDir: path.resolve(process.cwd(), process.env.BUFFER_DIR || 'buffer'),
  outputDir: path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'output'),
};

