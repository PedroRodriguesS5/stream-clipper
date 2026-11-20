import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs/promises';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { runClaudeJson } from '../ai/claude-cli.js';

const execFileAsync = promisify(execFile);

const OUT_W = 1080;
const OUT_H = 1920;

/** Pixel box inside the source frame */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutKind = 'stack' | 'blur' | 'center' | 'face_center';

export interface LayoutPlan {
  kind: LayoutKind;
  frameW: number;
  frameH: number;
  facecam?: Box;
  gameplay?: Box;
  reason: string;
}

const LAYOUT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    layout: {
      type: 'string',
      enum: ['facecam_overlay', 'full_camera', 'no_camera'],
      description:
        'facecam_overlay = a webcam rectangle sits on top of gameplay/screen content; full_camera = the camera fills most of the frame (IRL / just chatting); no_camera = no visible person',
    },
    facecam: {
      type: 'object',
      description:
        'Bounding box in PIXELS of the whole webcam rectangle (facecam_overlay) or of the main person/face (full_camera). Use zeros for no_camera.',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
    },
    gameplay: {
      type: 'object',
      description:
        'Bounding box in PIXELS of the main game/screen area, excluding chat boxes, alerts and decorative borders. Whole frame if unsure.',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        w: { type: 'number' },
        h: { type: 'number' },
      },
      required: ['x', 'y', 'w', 'h'],
      additionalProperties: false,
    },
    reason: { type: 'string' },
  },
  required: ['layout', 'facecam', 'gameplay', 'reason'],
  additionalProperties: false,
};

export const getVideoDimensions = async (videoPath: string): Promise<{ w: number; h: number }> => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-of',
    'csv=p=0',
    videoPath,
  ]);
  const [w, h] = stdout.trim().split(',').map(Number);
  if (!w || !h) throw new Error(`Could not read video dimensions of ${videoPath}`);
  return { w, h };
};

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

const clampBox = (b: Box, fw: number, fh: number): Box => {
  const w = even(Math.min(Math.max(b.w, 16), fw));
  const h = even(Math.min(Math.max(b.h, 16), fh));
  const x = even(Math.min(Math.max(b.x, 0), fw - w));
  const y = even(Math.min(Math.max(b.y, 0), fh - h));
  return { x, y, w, h };
};

/** Grow a box by `ratio` on every side (so hair/chin/headset are not cut) */
const padBox = (b: Box, ratio: number): Box => ({
  x: b.x - b.w * ratio,
  y: b.y - b.h * ratio,
  w: b.w * (1 + 2 * ratio),
  h: b.h * (1 + 2 * ratio),
});

/**
 * Grows `b` to aspect `targetAspect` (w/h) around its center, so nothing inside `b` is cut
 * (used for the webcam). Clamped to the frame.
 */
const growToAspect = (b: Box, targetAspect: number, fw: number, fh: number): Box => {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  let w = b.w;
  let h = b.h;
  if (w / h > targetAspect) {
    h = w / targetAspect;
    if (h > fh) {
      h = fh;
      w = h * targetAspect;
    }
  } else {
    w = h * targetAspect;
    if (w > fw) {
      w = fw;
      h = w / targetAspect;
    }
  }
  return clampBox({ x: cx - w / 2, y: cy - h / 2, w, h }, fw, fh);
};

/**
 * Crops inside `b` to aspect `targetAspect` so the area is filled (used for gameplay).
 * If `avoid` (the webcam) overlaps the crop, slides the crop sideways inside `b` away from it.
 */
const cropToAspect = (b: Box, targetAspect: number, fw: number, fh: number, avoid?: Box): Box => {
  let w = b.w;
  let h = b.h;
  if (w / h > targetAspect) w = h * targetAspect;
  else h = w / targetAspect;
  let x = b.x + (b.w - w) / 2;
  const y = b.y + (b.h - h) / 2;

  if (avoid) {
    const overlapsY = avoid.y < y + h && avoid.y + avoid.h > y;
    const overlapsX = avoid.x < x + w && avoid.x + avoid.w > x;
    if (overlapsX && overlapsY) {
      const rightOfCam = avoid.x + avoid.w;
      const leftOfCam = avoid.x - w;
      if (rightOfCam + w <= b.x + b.w) x = rightOfCam;
      else if (leftOfCam >= b.x) x = leftOfCam;
    }
  }
  return clampBox({ x, y, w, h }, fw, fh);
};

const parseFractionBox = (raw: string, fw: number, fh: number): Box | undefined => {
  const parts = raw.split(',').map((p) => Number(p.trim()));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 1)) return undefined;
  const [x, y, w, h] = parts;
  return { x: x * fw, y: y * fh, w: w * fw, h: h * fh };
};

const isUsable = (b: Box | undefined, fw: number, fh: number) =>
  !!b && b.w >= fw * 0.05 && b.h >= fh * 0.05 && b.w <= fw && b.h <= fh;

/**
 * Asks the local Claude Code CLI to look at one frame and locate the webcam + gameplay.
 */
const detectWithClaude = async (
  framePath: string,
  fw: number,
  fh: number
): Promise<{ layout: string; facecam: Box; gameplay: Box; reason: string }> => {
  const prompt = [
    `Use the Read tool to open the image at: ${framePath}`,
    `It is a ${fw}x${fh} frame from a live stream (Twitch). Coordinates: origin top-left, x to the right, y down, in pixels of this ${fw}x${fh} image.`,
    `1. Decide the layout: "facecam_overlay" (a webcam showing the streamer's face is placed as a rectangle over the game/screen), "full_camera" (the camera itself fills most of the frame) or "no_camera".`,
    `2. facecam: the full webcam rectangle (including all people visible in it), or for full_camera the box around the main person's head and shoulders.`,
    `3. gameplay: the main game window. If the game is shown inside a frame with chat panels / overlays around it, return only the game window.`,
    `Ignore other video panels that show no person (e.g. an empty room). Be precise; return ONLY JSON matching the schema.`,
  ].join('\n');

  const raw = await runClaudeJson<{ layout: string; facecam: Box; gameplay: Box; reason: string }>(
    prompt,
    LAYOUT_JSON_SCHEMA,
    { tools: ['Read'], timeoutMs: 90_000 }
  );
  if (!raw?.layout) throw new Error('AI returned no layout');
  return raw;
};

/**
 * Decides how to turn a 16:9 stream into a 9:16 short without cutting the streamer's face.
 * `sampleAtSeconds` should be inside the clip (e.g. the hook point).
 */
export const planLayout = async (videoPath: string, sampleAtSeconds: number): Promise<LayoutPlan> => {
  const { w: fw, h: fh } = await getVideoDimensions(videoPath);
  const mode = config.videoLayout;

  if (mode === 'center') return { kind: 'center', frameW: fw, frameH: fh, reason: 'VIDEO_LAYOUT=center' };
  if (mode === 'blur') return { kind: 'blur', frameW: fw, frameH: fh, reason: 'VIDEO_LAYOUT=blur' };

  // Manual regions win over AI detection
  const manualCam = config.facecamRegion ? parseFractionBox(config.facecamRegion, fw, fh) : undefined;
  const manualGame = config.gameplayRegion ? parseFractionBox(config.gameplayRegion, fw, fh) : undefined;
  if (manualCam) {
    return {
      kind: 'stack',
      frameW: fw,
      frameH: fh,
      facecam: manualCam,
      gameplay: manualGame || { x: 0, y: 0, w: fw, h: fh },
      reason: 'FACECAM_REGION set manually',
    };
  }
  if (mode === 'stack') {
    log('WARN', 'Layout', 'VIDEO_LAYOUT=stack but FACECAM_REGION is empty/invalid; detecting with AI.');
  }

  const framePath = path.join(path.dirname(videoPath), `layout_frame_${Date.now()}.jpg`);
  try {
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-ss',
      String(Math.max(0, sampleAtSeconds)),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      framePath,
    ]);

    log('INFO', 'Layout', 'Asking Claude to locate the webcam in a frame...');
    const det = await detectWithClaude(framePath, fw, fh);
    log('INFO', 'Layout', `Detected layout: ${det.layout}`, det);

    if (det.layout === 'facecam_overlay' && isUsable(det.facecam, fw, fh)) {
      const gameplay = isUsable(det.gameplay, fw, fh) ? det.gameplay : { x: 0, y: 0, w: fw, h: fh };
      return { kind: 'stack', frameW: fw, frameH: fh, facecam: det.facecam, gameplay, reason: det.reason };
    }
    if (det.layout === 'full_camera' && isUsable(det.facecam, fw, fh)) {
      return { kind: 'face_center', frameW: fw, frameH: fh, facecam: det.facecam, reason: det.reason };
    }
    return { kind: 'blur', frameW: fw, frameH: fh, reason: `No webcam found: ${det.reason}` };
  } catch (err) {
    log('WARN', 'Layout', `Webcam detection failed (${(err as Error).message}); using safe blur layout.`);
    return { kind: 'blur', frameW: fw, frameH: fh, reason: 'detection failed' };
  } finally {
    await fs.unlink(framePath).catch(() => {});
  }
};

/** Height (px, in the 1080x1920 output) of the webcam panel in the stack layout */
const stackCamHeight = (plan: LayoutPlan): number => {
  const cam = clampBox(padBox(plan.facecam!, 0.04), plan.frameW, plan.frameH);
  return even(Math.min(Math.max((OUT_W * cam.h) / cam.w, OUT_H * 0.25), OUT_H * 0.42));
};

/**
 * FFmpeg `overlay` y expression for the hook caption (`h` = caption height).
 * Stack: just below the webcam panel, so it never covers the face.
 */
export const captionOverlayY = (plan: LayoutPlan): string => {
  if (plan.kind === 'stack' && plan.facecam) return String(stackCamHeight(plan) + 28);
  if (plan.kind === 'blur') return `${Math.round(OUT_H * 0.2)}-h/2`; // blurred band above the video
  return String(Math.round(OUT_H * 0.1));
};

/**
 * Builds the FFmpeg filter that turns `[inLabel]` (source resolution) into a 1080x1920 `[outLabel]`.
 */
export const buildLayoutFilter = (plan: LayoutPlan, inLabel: string, outLabel: string): string => {
  const { frameW: fw, frameH: fh } = plan;

  if (plan.kind === 'stack' && plan.facecam && plan.gameplay) {
    // Webcam keeps (roughly) its own shape, between 25% and 42% of the height
    const cam = clampBox(padBox(plan.facecam, 0.04), fw, fh);
    const camOutH = stackCamHeight(plan);
    const gameOutH = OUT_H - camOutH;
    const camCrop = growToAspect(cam, OUT_W / camOutH, fw, fh);
    const gameCrop = cropToAspect(clampBox(plan.gameplay, fw, fh), OUT_W / gameOutH, fw, fh, cam);
    return [
      `[${inLabel}]split=2[lay_cam_src][lay_game_src]`,
      `[lay_cam_src]crop=${camCrop.w}:${camCrop.h}:${camCrop.x}:${camCrop.y},scale=${OUT_W}:${camOutH},setsar=1[lay_cam]`,
      `[lay_game_src]crop=${gameCrop.w}:${gameCrop.h}:${gameCrop.x}:${gameCrop.y},scale=${OUT_W}:${gameOutH},setsar=1[lay_game]`,
      `[lay_cam][lay_game]vstack=inputs=2[${outLabel}]`,
    ].join(';');
  }

  if (plan.kind === 'face_center' && plan.facecam) {
    const crop = growToAspect(
      { x: plan.facecam.x, y: 0, w: plan.facecam.w, h: fh },
      OUT_W / OUT_H,
      fw,
      fh
    );
    return `[${inLabel}]crop=${crop.w}:${crop.h}:${crop.x}:${crop.y},scale=${OUT_W}:${OUT_H},setsar=1[${outLabel}]`;
  }

  if (plan.kind === 'center') {
    return `[${inLabel}]crop=ih*9/16:ih:(iw-ow)/2:0,scale=${OUT_W}:${OUT_H},setsar=1[${outLabel}]`;
  }

  // blur: full frame, nothing cut, over a blurred zoomed copy
  return [
    `[${inLabel}]split=2[lay_bg_src][lay_fg_src]`,
    `[lay_bg_src]scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H},boxblur=20:2[lay_bg]`,
    `[lay_fg_src]scale=${OUT_W}:-2[lay_fg]`,
    `[lay_bg][lay_fg]overlay=(W-w)/2:(H-h)/2,setsar=1[${outLabel}]`,
  ].join(';');
};
