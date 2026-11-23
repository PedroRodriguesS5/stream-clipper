import { createHash } from 'crypto';
import { chromium } from 'playwright';
import { config } from '../utils/config.js';

/**
 * Discreet "follow" call to action burned into the clip, as an A/B test:
 *   none  - control, no CTA
 *   end   - small "＋ Siga para mais" pill for the last 3 s
 *   pulse - the same pill from second 2 to the end, gently pulsing (two sizes alternating)
 * Each clip gets one variant (stable hash of its file name, so the split stays even), saved in
 * its .seo.json; `npm run cta:report` compares subscribers per 1,000 views per variant.
 */
export type CtaVariant = 'none' | 'end' | 'pulse';
export const CTA_VARIANTS: CtaVariant[] = ['none', 'end', 'pulse'];

/** Below the subtitles (1120-1360), above the TikTok/Shorts bottom UI (last ~20% of 1920) */
export const CTA_Y = 1395;
export const CTA_W = 460;
export const CTA_H = 96;

export const enabledVariants = (): CtaVariant[] => {
  const list = config.ctaVariants.filter((v): v is CtaVariant => (CTA_VARIANTS as string[]).includes(v));
  return list.length ? list : ['none'];
};

/** Stable, evenly split assignment from the clip id (same clip -> same variant) */
export const chooseCtaVariant = (clipId: string, variants = enabledVariants()): CtaVariant => {
  const n = createHash('sha1').update(clipId).digest().readUInt32BE(0);
  return variants[n % variants.length];
};

const pillHtml = (text: string, scale: number) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${CTA_W}px;height:${CTA_H}px;background:transparent;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center}
  .pill{display:inline-flex;align-items:center;gap:${Math.round(14 * scale)}px;transform:scale(${scale});
    background:rgba(12,14,20,.72);border:2px solid rgba(255,255,255,.35);border-radius:999px;
    padding:10px 26px 10px 12px;box-shadow:0 6px 18px rgba(0,0,0,.45)}
  .icon{width:46px;height:46px;border-radius:50%;background:#ff2d55;display:flex;align-items:center;justify-content:center;
    color:#fff;font:900 38px/1 "Arial Black",Arial,sans-serif;padding-bottom:3px;box-sizing:border-box}
  .t{color:#fff;font:800 34px/1 "Helvetica Neue",Arial,sans-serif;letter-spacing:.3px;text-shadow:0 2px 4px #000}
</style></head><body><div class="pill"><div class="icon">+</div><div class="t">${text.replace(/[<>&]/g, '')}</div></div></body></html>`;

/** Renders the pill PNG(s): one size, or two for the pulse animation */
export const renderCtaPngs = async (variant: CtaVariant, base: string): Promise<string[]> => {
  if (variant === 'none') return [];
  const scales = variant === 'pulse' ? [1, 1.07] : [1];
  const files: string[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: CTA_W, height: CTA_H }, deviceScaleFactor: 1 });
    for (const [i, s] of scales.entries()) {
      const file = `${base}_cta${i}.png`;
      await page.setContent(pillHtml(config.ctaText, s), { waitUntil: 'load' });
      await page.screenshot({ path: file, omitBackground: true });
      files.push(file);
    }
  } finally {
    await browser.close();
  }
  return files;
};

/**
 * Overlay filters for the CTA inputs (`inputs` are the ffmpeg input indexes of the PNGs).
 * Returns the filter strings and the label of the final video.
 */
export const ctaOverlays = (
  variant: CtaVariant,
  inputs: number[],
  inLabel: string,
  durationSec: number
): { filters: string[]; out: string } => {
  if (variant === 'none' || !inputs.length) return { filters: [], out: inLabel };
  const x = '(W-w)/2';
  const y = `${CTA_Y}`;
  if (variant === 'end') {
    const from = Math.max(0, durationSec - 3).toFixed(2);
    return { filters: [`[${inLabel}][${inputs[0]}:v]overlay=x=${x}:y=${y}:shortest=1:enable='gte(t,${from})'[v_cta]`], out: 'v_cta' };
  }
  // pulse: small and big pill alternate every 0.6 s from second 2
  const [small, big] = inputs;
  return {
    filters: [
      `[${inLabel}][${small}:v]overlay=x=${x}:y=${y}:shortest=1:enable='gte(t,2)*lt(mod(t,1.2),0.6)'[v_cta0]`,
      `[v_cta0][${big ?? small}:v]overlay=x=${x}:y=${y}:shortest=1:enable='gte(t,2)*gte(mod(t,1.2),0.6)'[v_cta]`,
    ],
    out: 'v_cta',
  };
};
