// Renders the channel's branding images (original designs, no Rockstar artwork) with Playwright.
//   node branding/make-branding.mjs
// Output: branding/*.png
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const DIR = path.resolve('branding');
const frame = (name) => `data:image/jpeg;base64,${fs.readFileSync(path.join(DIR, 'frames', `${name}.jpg`)).toString('base64')}`;
const FRAMES = ['jetski', 'jacare', 'lancha', 'hidroaviao'].filter((f) => fs.existsSync(path.join(DIR, 'frames', `${f}.jpg`)));

const NAME = 'RADAR LEONIDAS';
const font = `"Impact","Arial Black","Helvetica Neue",sans-serif`;
// Vice City-style sunset palette (original colors, not Rockstar's logo)
const css = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: ${font}; color: #fff; overflow: hidden; }
  .sunset { background: linear-gradient(180deg, #1a0533 0%, #4b0f6b 35%, #c2185b 62%, #ff6f3c 82%, #ffc857 100%); }
  .neon { text-shadow: 0 0 8px #ff3ea5, 0 0 22px #ff3ea5, 0 0 44px #ff3ea5, 4px 4px 0 #2a0845; }
  .cyan { color: #5ff3ff; text-shadow: 0 0 10px #00e5ff, 0 0 26px #00e5ff, 3px 3px 0 #08203a; }
  .sun { position: absolute; border-radius: 50%; background: repeating-linear-gradient(180deg, #ffd166 0 14px, #ff7b54 14px 22px, transparent 22px 26px); }
  .grid { position: absolute; left: 0; right: 0; bottom: 0; background:
      linear-gradient(transparent 0 92%, rgba(95,243,255,.55) 92% 100%) 0 0 / 100% 40px,
      linear-gradient(90deg, transparent 0 96%, rgba(95,243,255,.45) 96% 100%) 0 0 / 80px 100%;
      transform: perspective(500px) rotateX(60deg); transform-origin: bottom; }
  .palm { position: absolute; font-size: 1em; filter: brightness(0) drop-shadow(0 0 2px #000); opacity: .85; }
`;

const avatar = `<div class="sunset" style="width:800px;height:800px;position:relative;display:flex;align-items:center;justify-content:center;">
  <div class="sun" style="width:520px;height:520px;top:120px;left:140px;opacity:.95"></div>
  <div class="grid" style="height:260px;opacity:.8"></div>
  <span class="palm" style="font-size:300px;left:-40px;bottom:40px">🌴</span>
  <span class="palm" style="font-size:240px;right:-30px;bottom:60px;transform:scaleX(-1)">🌴</span>
  <div style="position:relative;text-align:center;line-height:.9">
    <div class="neon" style="font-size:250px;letter-spacing:6px">RL</div>
    <div class="cyan" style="font-size:78px;letter-spacing:4px;margin-top:6px">CORTES</div>
    <div style="font-size:64px;letter-spacing:6px;color:#ffd166;text-shadow:3px 3px 0 #2a0845">GTA 6</div>
  </div>
</div>`;

// YouTube banner: 2560x1440, everything important inside the 1546x423 safe area (center)
const tiles = FRAMES.map((f) => `<div style="flex:1;background:url(${frame(f)}) center/cover;"></div>`).join('');
const banner = `<div style="width:2560px;height:1440px;position:relative;background:#120326;">
  <div style="position:absolute;inset:0;display:flex;filter:saturate(1.25)">${tiles}</div>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(26,5,51,.55) 0%, rgba(75,15,107,.55) 40%, rgba(194,24,91,.55) 70%, rgba(255,111,60,.45) 100%)"></div>
  <div style="position:absolute;left:507px;top:508px;width:1546px;height:423px;display:flex;flex-direction:column;align-items:center;justify-content:center;
              background:rgba(18,3,38,.72);border:6px solid #ff3ea5;border-radius:28px;box-shadow:0 0 40px #ff3ea5, inset 0 0 30px rgba(255,62,165,.4)">
    <div class="neon" style="font-size:150px;letter-spacing:10px;line-height:1">${NAME}</div>
    <div class="cyan" style="font-size:58px;letter-spacing:3px;margin-top:14px">OS MELHORES CORTES DE GTA 6 DOS STREAMERS BR</div>
    <div style="font-size:44px;margin-top:18px;color:#ffd166;text-shadow:3px 3px 0 #2a0845;letter-spacing:2px">🐊 ANIMAIS • 🚤 BARCOS • 🚗 CARROS • 💀 FAILS — NOVOS CORTES TODO DIA</div>
  </div>
</div>`;

// Same banner without stream frames (fully original) for places that prefer clean art
const bannerClean = `<div class="sunset" style="width:2560px;height:1440px;position:relative;">
  <div class="sun" style="width:900px;height:900px;left:830px;top:200px;opacity:.9"></div>
  <div class="grid" style="height:520px;opacity:.75"></div>
  <span class="palm" style="font-size:700px;left:120px;bottom:120px">🌴</span>
  <span class="palm" style="font-size:600px;right:140px;bottom:140px;transform:scaleX(-1)">🌴</span>
  <div style="position:absolute;left:507px;top:508px;width:1546px;height:423px;display:flex;flex-direction:column;align-items:center;justify-content:center;
              background:rgba(18,3,38,.78);border:6px solid #ff3ea5;border-radius:28px;box-shadow:0 0 40px #ff3ea5;">
    <div class="neon" style="font-size:160px;letter-spacing:10px;line-height:1">${NAME}</div>
    <div class="cyan" style="font-size:60px;letter-spacing:3px;margin-top:14px">CORTES DE GTA 6 • STREAMERS BR</div>
    <div style="font-size:46px;margin-top:16px;color:#ffd166;text-shadow:3px 3px 0 #2a0845">NOVOS CORTES TODO DIA</div>
  </div>
</div>`;

// TikTok / Shorts vertical cover 1080x1920 (pinned video / promo image)
const coverTiles = FRAMES.map((f) => `<div style="flex:1;background:url(${frame(f)}) center/cover;border-bottom:6px solid #ff3ea5"></div>`).join('');
const cover = `<div style="width:1080px;height:1920px;position:relative;background:#120326;">
  <div style="position:absolute;inset:0;display:flex;flex-direction:column;filter:saturate(1.2)">${coverTiles}</div>
  <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(26,5,51,.15) 0%, rgba(26,5,51,.05) 50%, rgba(26,5,51,.25) 100%)"></div>
  <div style="position:absolute;left:60px;right:60px;top:760px;padding:40px 30px;text-align:center;background:rgba(18,3,38,.85);border:6px solid #ff3ea5;border-radius:30px;box-shadow:0 0 40px #ff3ea5">
    <div class="neon" style="font-size:118px;line-height:1">${NAME}</div>
    <div class="cyan" style="font-size:54px;margin-top:16px">TUDO QUE OS STREAMERS DESCOBRIRAM NO GTA 6</div>
    <div style="font-size:44px;margin-top:16px;color:#ffd166">🐊 🚤 🚗 💀 SEGUE PRA MAIS!</div>
  </div>
</div>`;

const browser = await chromium.launch();
const page = await browser.newPage();
const render = async (html, w, h, file) => {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`, { waitUntil: 'load' });
  await page.screenshot({ path: path.join(DIR, file), clip: { x: 0, y: 0, width: w, height: h } });
  console.log('saved branding/' + file);
};
await render(avatar, 800, 800, 'profile-picture-800.png');
await render(banner, 2560, 1440, 'youtube-banner-2560x1440.png');
await render(bannerClean, 2560, 1440, 'youtube-banner-clean-2560x1440.png');
await render(cover, 1080, 1920, 'cover-vertical-1080x1920.png');
await browser.close();
