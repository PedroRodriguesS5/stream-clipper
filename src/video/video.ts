import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { ExtractClipDecision } from '../ai/ai.js';
import { log } from '../utils/logger.js';
import fs from 'fs/promises';
import { planLayout, buildLayoutFilter, captionOverlayY, LayoutPlan } from './layout.js';
import { renderCaptionPng } from './caption.js';
import { buildSubtitleTrack, removeSubtitleTrack, SUB_Y, SubtitleTrack } from './subtitles.js';

const execFileAsync = promisify(execFile);

export const getVideoDurationSeconds = async (videoPath: string): Promise<number> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    videoPath,
  ]);
  const dur = parseFloat(stdout.trim());
  return isNaN(dur) ? 10 : Number(dur.toFixed(2));
};

const runFFmpeg = (args: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to start ffmpeg: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-600)}`));
      }
    });
  });
};

/**
 * Takes the Claude timestamps (`clip_start`, `clip_end`, `hook_split_point`),
 * crops the video to 9:16 vertical (1080x1920), and renders in natural chronological
 * order (`[clip_start..clip_end]`) so the setup, visual payoff, and streamer reaction
 * flow naturally without jarring backwards time-jumps.
 */
export const createInfiniteLoopClip = async (
  inputPath: string,
  outputPath: string,
  decision: ExtractClipDecision,
  subtitleText?: string,
  layoutPlan?: LayoutPlan,
  options: { badge?: string } = {}
): Promise<ClipRenderResult> => {
  const { clip_start, clip_end, hook_split_point } = decision;

  // Decide framing (webcam on top + gameplay below, face-centered crop, or blurred full frame)
  const plan = layoutPlan ?? (await planLayout(inputPath, hook_split_point));
  log('INFO', 'VideoEngine', `Layout: ${plan.kind} (${plan.reason})`);

  log(
    'INFO',
    'VideoEngine',
    `Creating 9:16 chronological clip: [${clip_start}s..${clip_end}s] (climax at ${hook_split_point}s)`
  );

  // Hook caption: rendered to a transparent PNG (works without drawtext) and overlaid
  const captionText = (subtitleText || '').trim().slice(0, 60);
  let captionPath: string | undefined;
  if (captionText) {
    try {
      captionPath = outputPath.replace(/\.mp4$/, '_caption.png');
      await renderCaptionPng(captionText, captionPath, 960, options.badge);
    } catch (err) {
      log('WARN', 'VideoEngine', `Caption render failed (${(err as Error).message}); continuing without caption.`);
      captionPath = undefined;
    }
  }
  const capY = captionOverlayY(plan);

  // Speech subtitles (Whisper). Never blocks the render: any failure = clip without subtitles.
  let subs: SubtitleTrack | undefined;
  try {
    subs = await buildSubtitleTrack(inputPath, clip_start, clip_end, outputPath.replace(/\.mp4$/, ''));
  } catch (err) {
    log('WARN', 'VideoEngine', `Subtitles failed (${(err as Error).message.split('\n')[0]}); continuing without them.`);
  }

  // Filter graph: chronological trim [clip_start -> clip_end] reframed to 1080x1920 by the layout filter,
  // then the hook caption (input 1) and the subtitle image track (next input) on top.
  const capIn = captionPath ? 1 : -1;
  const subIn = subs ? (captionPath ? 2 : 1) : -1;
  const overlays: string[] = [];
  let last = 'v_lay';
  if (capIn > 0) {
    overlays.push(`[${last}][${capIn}:v]overlay=x=(W-w)/2:y=${capY}:shortest=1[v_cap]`);
    last = 'v_cap';
  }
  if (subIn > 0) {
    // Slightly left of centre: TikTok/Reels action buttons sit on the right edge
    overlays.push(`[${last}][${subIn}:v]overlay=x=(W-w)/2-30:y=${SUB_Y}:eof_action=pass[v_sub]`);
    last = 'v_sub';
  }
  const filterComplex = [
    `[0:v]trim=start=${clip_start}:end=${clip_end},setpts=PTS-STARTPTS[v_cat]`,
    `[0:a]atrim=start=${clip_start}:end=${clip_end},asetpts=PTS-STARTPTS[a_out]`,
    buildLayoutFilter(plan, 'v_cat', 'v_lay'),
    ...overlays,
    `[${last}]format=yuv420p[v_out]`,
  ].join(';');

  const args = [
    '-y',
    '-i',
    inputPath,
    ...(captionPath ? ['-loop', '1', '-i', captionPath] : []),
    ...(subs ? ['-f', 'concat', '-safe', '0', '-i', subs.concatPath] : []),
    '-filter_complex',
    filterComplex,
    '-map',
    '[v_out]',
    '-map',
    '[a_out]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '23',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    outputPath,
  ];

  try {
    await runFFmpeg(args);
  } finally {
    if (captionPath) await fs.unlink(captionPath).catch(() => {});
    await removeSubtitleTrack(subs);
  }
  log('SUCCESS', 'VideoEngine', `Rendered 9:16 infinite loop video -> ${outputPath}`);
  return {
    path: outputPath,
    layout: plan,
    hasCaption: !!captionPath,
    hasSubtitles: !!subs,
    durationSeconds: Number((clip_end - clip_start).toFixed(2)),
  };
};

export interface ClipRenderResult {
  path: string;
  layout: LayoutPlan;
  hasCaption: boolean;
  /** Whisper speech subtitles burned in (an .srt is saved next to the clip) */
  hasSubtitles?: boolean;
  durationSeconds: number;
}

/**
 * Generates a synthetic 16:9 1920x1080 sample stream buffer with audio
 * for testing the full pipeline without waiting for a live stream.
 */
export const generateTestStreamBuffer = async (
  outputPath: string,
  durationSeconds = 12
): Promise<string> => {
  log('INFO', 'VideoEngine', `Generating ${durationSeconds}s test stream buffer at ${outputPath}...`);
  await runFFmpeg([
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1920x1080:rate=30:duration=${durationSeconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=44100:duration=${durationSeconds}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    outputPath,
  ]);
  return outputPath;
};
