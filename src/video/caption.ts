import { chromium } from 'playwright';
import { log } from '../utils/logger.js';

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const KEYWORDS = [
  'GTA 6',
  'GTA VI',
  'CARRO',
  'CARROS',
  'BARCO',
  'BARCOS',
  'LANCHA',
  'LANCHAS',
  'JACARÉ',
  'JACARÉS',
  'PÂNTANO',
  'MECÂNICA',
  'MECÂNICAS',
  'FÍSICA',
  'TUNAGEM',
  'POLÍCIA',
  'CAPOTOU',
  'BATEU',
  'DESTRUIU',
  'ACHOU',
  'TESTOU',
  'EXPLODIU',
  'PÉ-GRANDE',
  'PÉ GRANDE',
  'ALBINO',
  'ANIMAL',
  'ANIMAIS',
  'MOTOR',
  'PILOTOU',
];

/**
 * Highlights target gaming and GTA search keywords in bright TikTok yellow (<b>)
 * for maximum human visual hook in the first 3 seconds and clean OCR indexing by TikTok's algorithm.
 */
export const highlightKeywords = (text: string): string => {
  const escaped = KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return escapeHtml(text).replace(pattern, '<b>$1</b>');
};

/**
 * Renders a high-retention, high-contrast hook caption (e.g. "A FÍSICA DESSE CARRO NO GTA 6 💀")
 * to a transparent PNG.
 * Includes a prominent "GTA VI" badge and highlighted keywords so:
 *  1. Viewers on TikTok instantly lock their eyes on the topic in the first 2-3 seconds.
 *  2. TikTok's computer vision OCR clearly reads the search keywords to rank and recommend the clip.
 */
export const renderCaptionPng = async (text: string, outPath: string, width = 960, badge?: string): Promise<string> => {
  const formattedHtml = highlightKeywords(text);
  // Badge = the game actually streamed (it used to say "GTA VI" on every clip, even GTA RP/VALORANT)
  const badgeHtml = badge ? `<div class="badge">${escapeHtml(badge.toUpperCase())}</div>` : '';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;background:transparent;display:flex;justify-content:center;align-items:center;padding:16px}
    #c{
      display:inline-flex;
      flex-direction:column;
      align-items:center;
      max-width:${width}px;
      padding:16px 36px 20px 36px;
      border-radius:28px;
      background:rgba(12, 14, 20, 0.88);
      border:3px solid rgba(255, 230, 0, 0.85);
      box-shadow:0 12px 35px rgba(0, 0, 0, 0.85);
      text-align:center;
    }
    .badge{
      display:inline-block;
      background:#ffe600;
      color:#000;
      font:900 26px/1 "Arial Black", Impact, sans-serif;
      letter-spacing:2px;
      padding:4px 16px;
      border-radius:12px;
      margin-bottom:10px;
      text-transform:uppercase;
      box-shadow:0 2px 8px rgba(0,0,0,0.4);
    }
    .text{
      color:#ffffff;
      font:900 58px/1.14 "Arial Black", "Helvetica Neue", Impact, sans-serif;
      letter-spacing:.5px;
      text-transform:uppercase;
      -webkit-text-stroke:2px #000;
      text-shadow:0 4px 6px #000;
    }
    .text b{
      color:#ffe600;
      -webkit-text-stroke:2px #000;
    }
  </style></head><body>
    <div id="c">
      ${badgeHtml}
      <div class="text">${formattedHtml}</div>
    </div>
  </body></html>`;

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: width + 100, height: 600 }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load' });
    await page.locator('#c').screenshot({ path: outPath, omitBackground: true });
    log('INFO', 'Caption', `Rendered hook caption PNG -> ${outPath}`);
    return outPath;
  } finally {
    await browser.close();
  }
};
