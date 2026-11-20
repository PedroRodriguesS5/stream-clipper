import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { google } from 'googleapis';
import { chromium, Cookie, Page } from 'playwright';
import axios from 'axios';
import { config } from '../utils/config.js';
import { SEOMetadata } from '../ai/ai.js';
import { log } from '../utils/logger.js';
import { formatInstagramCaption, formatTikTokCaption, formatYouTube } from './platform-seo.js';

export { formatTikTokCaption } from './platform-seo.js';

export interface RawBrowserCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string | null;
  expirationDate?: number;
  expires?: number;
}

/**
 * Normalizes Cookie-Editor JSON cookies into Playwright's strict Cookie format
 */
export const normalizePlaywrightCookies = (rawCookies: RawBrowserCookie[]): Cookie[] => {
  return rawCookies.map((c) => {
    const rawSameSite = (c.sameSite || '').toLowerCase();
    let sameSite: 'Strict' | 'Lax' | 'None' = 'Lax';
    if (rawSameSite === 'no_restriction' || rawSameSite === 'none') {
      sameSite = 'None';
    } else if (rawSameSite === 'strict') {
      sameSite = 'Strict';
    }

    const expires = c.expires ?? (c.expirationDate ? Math.floor(c.expirationDate) : -1);

    return {
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || '/',
      secure: Boolean(c.secure ?? (sameSite === 'None' ? true : false)),
      httpOnly: Boolean(c.httpOnly),
      sameSite,
      expires,
    };
  });
};

export const loadTikTokCookies = async (): Promise<Cookie[]> => {
  if (fs.existsSync(config.tiktokCookiesPath)) {
    const content = await fsPromises.readFile(config.tiktokCookiesPath, 'utf-8');
    const raw = JSON.parse(content) as RawBrowserCookie[];
    return normalizePlaywrightCookies(raw);
  }

  if (config.tiktokSessionCookie) {
    return [
      {
        name: 'sessionid',
        value: config.tiktokSessionCookie,
        domain: '.tiktok.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        expires: -1,
      },
    ];
  }

  throw new Error('No TikTok cookies found in cookies/tiktok.json or TIKTOK_SESSION_COOKIE');
};

/**
 * Verifies Google OAuth2 credentials by refreshing the access token.
 */
export const verifyYouTubeAuth = async (): Promise<{
  authenticated: boolean;
  accessTokenPreview?: string;
}> => {
  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    'https://developers.google.com/oauthplayground'
  );

  oauth2Client.setCredentials({
    refresh_token: config.googleRefreshToken,
  });

  const tokenResponse = await oauth2Client.getAccessToken();
  if (!tokenResponse.token) {
    throw new Error('Failed to obtain Google OAuth2 access token from refresh_token');
  }

  return {
    authenticated: true,
    accessTokenPreview: `${tokenResponse.token.slice(0, 12)}...`,
  };
};

/**
 * Uploads the edited 9:16 clip to YouTube Shorts via YouTube Data API v3.
 */
export const uploadToYouTube = async (
  videoPath: string,
  seo: SEOMetadata,
  privacyStatus: 'private' | 'unlisted' | 'public' = 'public'
): Promise<string> => {
  log('INFO', 'YouTubePublisher', `Uploading ${videoPath} to YouTube Shorts (${privacyStatus})...`);

  const oauth2Client = new google.auth.OAuth2(
    config.googleClientId,
    config.googleClientSecret,
    'https://developers.google.com/oauthplayground'
  );

  oauth2Client.setCredentials({
    refresh_token: config.googleRefreshToken,
  });

  const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

  // Title/description/tags sized to YouTube's limits (platform-seo.ts); #Shorts goes in the description
  const yt = formatYouTube(seo);

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: yt.title,
        description: yt.description,
        tags: yt.tags,
        categoryId: '20', // Gaming
        defaultLanguage: config.contentLocale,
        defaultAudioLanguage: config.contentLocale,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: false,
      },
    },
    media: {
      body: fs.createReadStream(videoPath),
    },
  });

  const videoId = res.data.id || 'unknown';
  const shortUrl = `https://youtube.com/shorts/${videoId}`;
  log('SUCCESS', 'YouTubePublisher', `Uploaded YouTube Short! URL: ${shortUrl}`);
  return shortUrl;
};

/** Selects "Everyone" in "Who can see this post"; throws if it can't be confirmed */
const ensureTikTokPublic = async (page: Page): Promise<string> => {
  const label = page.locator('text=/Who can see this post|Quem pode ver (esta|este) (publicação|post|vídeo)/i').first();
  await label.waitFor({ state: 'visible', timeout: 20_000 });
  const combo = page.locator('button[role="combobox"]').filter({ hasText: /Everyone|Todos|Friends|Amigos|Only you|Only me|Somente você|Apenas eu/i }).first();
  const current = ((await combo.textContent()) || '').trim();
  if (/^(Everyone|Todos)$/i.test(current)) return current;

  await combo.click();
  await page.locator('[role="option"]').filter({ hasText: /^(Everyone|Todos)$/i }).first().click({ timeout: 10_000 });
  await page.waitForTimeout(500);
  const after = ((await combo.textContent()) || '').trim();
  if (!/^(Everyone|Todos)$/i.test(after)) throw new Error(`Could not set TikTok visibility to Everyone (shows "${after}")`);
  return after;
};

/** Opens TikTok Studio's content list and looks for the new post */
const verifyTikTokPost = async (
  page: Page,
  captionStart: string
): Promise<{ found: boolean; privacy?: string; underReview?: boolean }> => {
  await page.goto('https://www.tiktok.com/tiktokstudio/content', { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText);
    const idx = text.indexOf(captionStart);
    if (idx >= 0) {
      const around = text.slice(idx, idx + 1500); // captions now include a long description before the privacy column
      const privacy = around.match(/Everyone|Todos|Only me|Somente você|Apenas eu|Friends|Amigos/i)?.[0];
      return { found: true, privacy, underReview: /under review|em análise/i.test(around) };
    }
  }
  return { found: false };
};

/**
 * Automates TikTok upload using Playwright with normalized session cookies from cookies/tiktok.json
 */
export const uploadToTikTok = async (
  videoPath: string,
  seo: SEOMetadata,
  options: { dryRun?: boolean; headless?: boolean } = {}
): Promise<{
  cookiesLoaded: number;
  hasSessionId: boolean;
  url: string;
  posted?: boolean;
  privacy?: string;
  underReview?: boolean;
  screenshotPath?: string;
}> => {
  const { dryRun = false, headless = true } = options;
  const cookies = await loadTikTokCookies();
  const hasSessionId = cookies.some(
    (c) => (c.name === 'sessionid' || c.name === 'sessionid_ss') && c.value.length > 5
  );

  log(
    'INFO',
    'TikTokPublisher',
    `Loaded ${cookies.length} TikTok cookies (sessionid present: ${hasSessionId})`
  );

  const browser = await chromium.launch({
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    await context.addCookies(cookies);

    if (dryRun) {
      log(
        'SUCCESS',
        'TikTokPublisher',
        'Dry-run: Playwright context initialized and accepted all TikTok cookies!'
      );
      return {
        cookiesLoaded: cookies.length,
        hasSessionId,
        url: 'https://www.tiktok.com/tiktokstudio/upload',
        posted: false,
      };
    }

    const page = await context.newPage();
    // Any failure below leaves a screenshot so we can see what blocked the upload (modal, captcha...)
    const failShot = async () => {
      const file = path.join(config.outputDir, 'tiktok_upload_failed.png');
      await page.screenshot({ path: file }).catch(() => {});
      return file;
    };
    try {
    log('INFO', 'TikTokPublisher', 'Navigating to TikTok Studio Upload page...');
    await page.goto('https://www.tiktok.com/tiktokstudio/upload', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });

    // Wait a moment for redirects or SPA hydration
    await page.waitForTimeout(5000);
    const currentUrl = page.url();
    log('INFO', 'TikTokPublisher', `Current TikTok URL: ${currentUrl}`);

    if (currentUrl.includes('/login')) {
      const loginShot = path.join(config.outputDir, 'tiktok_login_redirect.png');
      await page.screenshot({ path: loginShot });
      throw new Error(
        `TikTok redirected to login (${currentUrl}). Session cookies may be expired. Screenshot saved to ${loginShot}`
      );
    }

    // Locate file input ( either on main page or inside an iframe )
    log('INFO', 'TikTokPublisher', `Attaching video file: ${videoPath}`);
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 45_000 });
    await fileInput.setInputFiles(videoPath);

    log('INFO', 'TikTokPublisher', 'Waiting for video upload & caption editor...');
    const captionEditor = page.locator('[contenteditable="true"]').first();
    await captionEditor.waitFor({ state: 'visible', timeout: 45_000 });
    await page.waitForTimeout(3500);

    // Dismiss TikTok Studio modals/popups ("Turn on automatic content checks?" -> Cancel, "New editing features added" -> Got it)
    const dismissModalButtons = async () => {
      // If a previous click opened "Sure you want to cancel your upload?", answer No (keep the upload)
      const cancelConfirm = page
        .locator('[role="dialog"], [class*="modal" i], [class*="Modal"]')
        .filter({ hasText: /cancel your upload|cancelar (o |seu )?(envio|upload)/i });
      if (await cancelConfirm.first().isVisible().catch(() => false)) {
        log('INFO', 'TikTokPublisher', 'Keeping the upload ("cancel your upload?" -> No)');
        await cancelConfirm.first().locator('button').filter({ hasText: /^\s*(No|Não)\s*$/i }).first().click({ force: true }).catch(() => {});
        await page.waitForTimeout(800);
      }
      // Only buttons INSIDE pop-ups: the upload form itself has a "Cancel" (discard upload) button
      const modals = page.locator('[role="dialog"], [class*="modal" i], [class*="Modal"]').filter({ hasNotText: /cancel your upload|cancelar (o |seu )?(envio|upload)/i });
      // "Got it"/"Not now" are always safe to click (tips/popovers); "Cancel" only inside pop-ups,
      // because the upload form itself has a "Cancel" (discard upload) button
      for (const label of ['Got it', 'Not now', 'Entendi', 'Agora não', 'Cancel', 'Cancelar']) {
        const scope = /^cancel/i.test(label) ? modals : page;
        const btns = scope.locator(`button:has-text("${label}")`);
        const count = await btns.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const btn = btns.nth(i);
          if (await btn.isVisible().catch(() => false)) {
            log('INFO', 'TikTokPublisher', `Dismissing modal button: "${label}"`);
            await btn.click({ force: true }).catch(() => {});
            await page.waitForTimeout(800);
          }
        }
      }
    };

    await dismissModalButtons();
    await page.waitForTimeout(1000);
    await dismissModalButtons();

    // Wait until "Uploaded" indicator appears
    await page
      .locator('text=Uploaded')
      .first()
      .waitFor({ state: 'visible', timeout: 45_000 })
      .catch(() => {});

    // Clear default filename caption and enter SEO title + specific search tags + hashtags
    const captionText = formatTikTokCaption(seo);
    await dismissModalButtons();
    log('INFO', 'TikTokPublisher', `Setting caption: "${captionText}"`);
    await captionEditor.click();
    await page.waitForTimeout(300);
    // Select all existing default filename text inside the DraftJS editor and delete it
    await captionEditor.click({ clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Meta+A');
    await page.keyboard.press('Backspace');
    // Line by line: Escape closes any @mention/#hashtag suggestion list so Enter only adds a line break
    const lines = captionText.split('\n');
    for (const [i, line] of lines.entries()) {
      if (line) await page.keyboard.type(line, { delay: 10 });
      await page.keyboard.press('Escape');
      if (i < lines.length - 1) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1500);

    // Scroll down to reveal the Post button at the bottom of the form
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);

    // Visibility: force "Everyone" and refuse to post if we can't confirm it
    await dismissModalButtons();
    const visibility = await ensureTikTokPublic(page);
    log('INFO', 'TikTokPublisher', `Visibility set to: ${visibility}`);

    const postButton = page
      .locator('[data-e2e="post_video_button"], button:text-is("Post"), button:text-is("Publicar")')
      .last();

    await postButton.waitFor({ state: 'visible', timeout: 60_000 });
    await postButton.scrollIntoViewIfNeeded();

    const prePostShot = path.join(config.outputDir, 'tiktok_before_post.png');
    await page.screenshot({ path: prePostShot });
    log('INFO', 'TikTokPublisher', `Saved pre-post screenshot to ${prePostShot}`);

    await postButton.click();
    log('INFO', 'TikTokPublisher', 'Clicked Post button! Checking for confirmation dialogs...');

    await page.waitForTimeout(3000);
    for (const confirmText of ['Post now', 'Continue to post', 'Publicar agora']) {
      const confirmBtn = page.locator(`button:has-text("${confirmText}")`).first();
      if (await confirmBtn.isVisible().catch(() => false)) {
        log('INFO', 'TikTokPublisher', `Clicking confirmation button: "${confirmText}"`);
        await confirmBtn.click();
      }
    }

    await page.waitForTimeout(8000);
    const postShot = path.join(config.outputDir, 'tiktok_after_post.png');
    await page.screenshot({ path: postShot });

    // Verify: the post must appear in TikTok Studio's content list
    const check = await verifyTikTokPost(page, seo.title.slice(0, 25));
    log(
      check.found ? 'SUCCESS' : 'ERROR',
      'TikTokPublisher',
      check.found
        ? `TikTok post confirmed in Studio (privacy: ${check.privacy}${check.underReview ? ', under review' : ''})`
        : 'TikTok post NOT found in Studio after posting',
      { screenshot: postShot }
    );
    return {
      cookiesLoaded: cookies.length,
      hasSessionId,
      url: page.url(),
      posted: check.found,
      privacy: check.privacy,
      underReview: check.underReview,
      screenshotPath: postShot,
    };
    } catch (err) {
      throw new Error(`${(err as Error).message.split('\n')[0]} | screenshot: ${await failShot()}`);
    }
  } finally {
    await browser.close();
  }
};

/** Instagram's 24 h publishing quota is used up; the post queue pauses Instagram instead of failing the clip */
export class InstagramDailyLimitError extends Error {}

const graphError = (err: unknown): string => {
  const e = err as { response?: { data?: { error?: { message?: string; code?: number; error_subcode?: number }; debug_info?: { message?: string } } }; message?: string };
  const g = e.response?.data?.error;
  if (g) return `${g.message} (code ${g.code}${g.error_subcode ? `/${g.error_subcode}` : ''})`;
  return e.response?.data?.debug_info?.message || e.message || String(err);
};

/**
 * Publishes a Reel from the LOCAL file with the Instagram Graph API resumable upload
 * (Facebook Login for Business: graph.facebook.com + rupload.facebook.com), so no public
 * video URL is needed. Steps (Meta docs, Nov 2026):
 *   1. check content_publishing_limit (quota per 24 h)
 *   2. POST /{ig-user-id}/media  media_type=REELS upload_type=resumable caption=...
 *   3. POST rupload.facebook.com/ig-api-upload/{v}/{container}  (Authorization: OAuth <token>, offset, file_size)
 *   4. poll GET /{container}?fields=status_code until FINISHED
 *   5. POST /{ig-user-id}/media_publish creation_id=...
 * Needs an Instagram professional (Business/Creator) account linked to a Facebook Page and a token with
 * instagram_basic, instagram_content_publish, pages_read_engagement.
 */
export const uploadToInstagram = async (videoPath: string, seo: SEOMetadata): Promise<string> => {
  if (!config.instagramAccessToken || !config.instagramAccountId) {
    throw new Error('Instagram not configured (set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID)');
  }
  const v = config.instagramApiVersion;
  const graph = `https://graph.facebook.com/${v}`;
  const auth = { Authorization: `OAuth ${config.instagramAccessToken}` };
  const size = (await fsPromises.stat(videoPath)).size;
  if (size > 300 * 1024 * 1024) throw new Error(`Reel is ${(size / 1048576).toFixed(0)} MB; Instagram accepts at most 300 MB`);

  try {
    // 1. Quota
    const quota = await axios.get(`${graph}/${config.instagramAccountId}/content_publishing_limit`, {
      params: { fields: 'quota_usage,config' },
      headers: auth,
    });
    const q = quota.data?.data?.[0];
    if (q && q.config?.quota_total && q.quota_usage >= q.config.quota_total) {
      throw new InstagramDailyLimitError(`Instagram publishing limit reached (${q.quota_usage}/${q.config.quota_total} in 24 h)`);
    }

    // 2. Container
    const caption = formatInstagramCaption(seo);
    log('INFO', 'InstagramPublisher', `Creating Reel container (${(size / 1048576).toFixed(1)} MB)...`);
    const container = await axios.post(`${graph}/${config.instagramAccountId}/media`, null, {
      params: { media_type: 'REELS', upload_type: 'resumable', caption, thumb_offset: 500 },
      headers: auth,
    });
    const containerId: string = container.data.id;
    const uploadUri: string = container.data.uri || `https://rupload.facebook.com/ig-api-upload/${v}/${containerId}`;

    // 3. Bytes
    await axios.post(uploadUri, await fsPromises.readFile(videoPath), {
      headers: { ...auth, offset: '0', file_size: String(size), 'Content-Type': 'application/octet-stream' },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 10 * 60_000,
    });
    log('INFO', 'InstagramPublisher', `Uploaded; waiting for Instagram to process container ${containerId}...`);

    // 4. Processing (Meta suggests polling about once a minute; Reels this short are usually ready in < 2 min)
    let status = 'IN_PROGRESS';
    for (let i = 0; i < 20 && status === 'IN_PROGRESS'; i++) {
      await new Promise((r) => setTimeout(r, 30_000));
      const st = await axios.get(`${graph}/${containerId}`, { params: { fields: 'status_code,status' }, headers: auth });
      status = st.data.status_code;
      if (status === 'ERROR' || status === 'EXPIRED') throw new Error(`Instagram could not process the Reel: ${st.data.status || status}`);
    }
    if (status !== 'FINISHED') throw new Error(`Instagram still processing after 10 min (status ${status})`);

    // 5. Publish + permalink
    const pub = await axios.post(`${graph}/${config.instagramAccountId}/media_publish`, null, {
      params: { creation_id: containerId },
      headers: auth,
    });
    const mediaId: string = pub.data.id;
    const link = await axios
      .get(`${graph}/${mediaId}`, { params: { fields: 'permalink' }, headers: auth })
      .then((r) => r.data.permalink as string)
      .catch(() => `instagram media ${mediaId}`);
    log('SUCCESS', 'InstagramPublisher', `Reel published: ${link}`);
    return link;
  } catch (err) {
    if (err instanceof InstagramDailyLimitError) throw err;
    throw new Error(`Instagram upload failed: ${graphError(err)}`);
  }
};
