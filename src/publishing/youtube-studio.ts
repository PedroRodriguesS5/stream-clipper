import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { BrowserContext, chromium, Page } from 'playwright';
import { SEOMetadata } from '../ai/ai.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { normalizePlaywrightCookies, RawBrowserCookie } from './publishing.js';
import { formatYouTube } from './platform-seo.js';

/**
 * Uploads a Short through YouTube Studio in a headless browser using your session cookies
 * (cookies/youtube.json exported with Cookie-Editor while logged in on youtube.com).
 *
 * Why not the API: videos uploaded through an UNVERIFIED Google API project are locked to
 * private by YouTube. The Studio website has no such lock, so "Public" really is public.
 *
 * Every field is read back after it is set; if something doesn't stick we stop with an error
 * instead of publishing a half-filled video. Works with Studio in Portuguese or English.
 */

/** Logged-in browser profile (cookies refresh themselves; created by `npm run youtube:login`) */
const profileReady = () => fs.existsSync(path.join(config.youtubeProfileDir, 'Default'));

export const youtubeCookiesAvailable = () => profileReady() || fs.existsSync(config.youtubeCookiesPath);

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * Google rotates its session cookies (__Secure-1PSIDTS, SIDCC) while you use YouTube. A frozen
 * Cookie-Editor export never receives those updates, so Google ends that session after a day or
 * two ("redirected to login" even though the cookie expiry dates are far away). A persistent
 * browser profile keeps the rotated cookies, and we also write them back to cookies/youtube.json
 * so the metrics collector stays logged in.
 */
const openPersistent = async (headless: boolean): Promise<BrowserContext> => {
  await fsPromises.mkdir(config.youtubeProfileDir, { recursive: true });
  const fresh = !profileReady();
  const context = await chromium.launchPersistentContext(config.youtubeProfileDir, {
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1440, height: 950 },
    userAgent: UA,
  });
  // Always load the cookie file: it is rewritten with Google's rotated cookies after every run,
  // so it is the newest copy. (The headless browser can't rely on the profile alone: on macOS,
  // Playwright's headless shell doesn't read cookies saved by the visible browser at login.)
  void fresh;
  if (fs.existsSync(config.youtubeCookiesPath)) {
    const raw = JSON.parse(await fsPromises.readFile(config.youtubeCookiesPath, 'utf-8')) as RawBrowserCookie[];
    await context.addCookies(normalizePlaywrightCookies(raw));
  }
  return context;
};

/** Writes the browser's current Google/YouTube cookies back in Cookie-Editor format */
export const saveYouTubeCookies = async (context: BrowserContext) => {
  const cookies = (await context.cookies()).filter((c) => /(^|\.)(youtube|google)\.com$/.test(c.domain.replace(/^\./, '')) || /youtube\.com|google\.com/.test(c.domain));
  if (!cookies.some((c) => c.name === 'SID' || c.name === '__Secure-1PSID')) return; // not logged in: keep the old file
  const out: RawBrowserCookie[] = cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite === 'None' ? 'no_restriction' : c.sameSite.toLowerCase(),
    ...(c.expires > 0 ? { expirationDate: c.expires } : {}),
  }));
  await fsPromises.mkdir(path.dirname(config.youtubeCookiesPath), { recursive: true });
  await fsPromises.writeFile(config.youtubeCookiesPath, JSON.stringify(out, null, 2));
};

export class YouTubeDailyLimitError extends Error {}
const DAILY_LIMIT = /limite diário de envios|daily upload limit/i;

const shot = async (page: Page, name: string) => {
  const file = path.join(config.outputDir, `youtube_${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
};

const openStudio = async (headless = true): Promise<{ browser: { close: () => Promise<void> }; page: Page }> => {
  const context = await openPersistent(headless);
  const page = context.pages()[0] || (await context.newPage());
  const close = async () => {
    await saveYouTubeCookies(context).catch((e) => log('WARN', 'YouTubeStudio', `Could not save refreshed cookies: ${(e as Error).message}`));
    await context.close();
  };
  return { browser: { close }, page };
};

/**
 * One-time (or whenever Google logs us out): opens a visible browser on YouTube Studio with the
 * uploader's profile so you can log in by hand. Waits until Studio loads, then saves the session.
 *   npm run youtube:login
 */
export const youtubeInteractiveLogin = async (timeoutMin = 10): Promise<void> => {
  const context = await openPersistent(false);
  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    log('INFO', 'YouTubeStudio', `Log in to the channel's Google account in the browser window (waiting up to ${timeoutMin} min)...`);
    await page.waitForURL(/studio\.youtube\.com\/channel\//, { timeout: timeoutMin * 60_000 });
    await page.waitForTimeout(3000);
    await saveYouTubeCookies(context);
    log('SUCCESS', 'YouTubeStudio', `Logged in. Session saved in ${config.youtubeProfileDir} and ${config.youtubeCookiesPath}`);
  } finally {
    await context.close();
  }
};

const assertLoggedIn = async (page: Page) => {
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(page.url())) {
    throw new Error(`YouTube redirected to login. Run \`npm run youtube:login\` and log in once. Screenshot: ${await shot(page, 'login')}`);
  }
};

const TITLE_BOX = '#title-textarea #textbox';
const DESC_BOX = '#description-textarea #textbox';

/** Sets a contenteditable textbox and verifies the text stuck (YouTube may re-render it) */
export const setTextbox = async (page: Page, selector: string, text: string, label: string) => {
  const box = page.locator(selector).first();
  for (let attempt = 1; attempt <= 3; attempt++) {
    await box.click();
    // Select everything inside the box and delete it (Cmd+A on macOS, Ctrl+A elsewhere)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(300);
    if (((await box.innerText()) || '').trim().length) {
      await box.evaluate((el) => (el.textContent = ''));
    }
    await page.keyboard.insertText(text);
    await page.waitForTimeout(1200);
    const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
    if (norm((await box.innerText()) || '') === norm(text)) return;
    log('WARN', 'YouTubeStudio', `${label} did not stick (attempt ${attempt}); retrying...`);
  }
  throw new Error(`Could not set the ${label}. Screenshot: ${await shot(page, `${label}_failed`)}`);
};

const checkRadio = async (page: Page, name: string, label: string) => {
  const radio = page.locator(`tp-yt-paper-radio-button[name="${name}"]`).first();
  await radio.scrollIntoViewIfNeeded().catch(() => {});
  for (let attempt = 1; attempt <= 3; attempt++) {
    await radio.click({ timeout: 30_000 });
    await page.waitForTimeout(700);
    if ((await radio.getAttribute('aria-checked')) === 'true') return;
  }
  throw new Error(`Could not select "${label}". Screenshot: ${await shot(page, `${name}_failed`)}`);
};

/**
 * Fills the upload/draft dialog (already open) and publishes as PUBLIC. Returns the Shorts URL.
 */
const fillDetailsAndPublish = async (page: Page, seo: SEOMetadata): Promise<string> => {
  // Same YouTube rules as the API path: 4 hashtags + #Shorts, no keyword list in the description
  const { title, description } = formatYouTube(seo);

  // YouTube pre-fills the title with the file name once the upload initializes; wait for it,
  // otherwise it overwrites whatever we type.
  const titleBox = page.locator(TITLE_BOX).first();
  await titleBox.waitFor({ state: 'visible', timeout: 90_000 });
  for (let i = 0; i < 60; i++) {
    if (((await titleBox.innerText()) || '').trim().length > 0) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(2500);

  await setTextbox(page, TITLE_BOX, title, 'title');
  await setTextbox(page, DESC_BOX, description, 'description');
  await checkRadio(page, 'VIDEO_MADE_FOR_KIDS_NOT_MFK', 'Not made for kids');
  log('INFO', 'YouTubeStudio', 'Title, description and audience set; going to Visibility...');

  // Next until the visibility step (Details -> Video elements -> Checks -> Visibility)
  const publicRadio = page.locator('tp-yt-paper-radio-button[name="PUBLIC"]').first();
  for (let i = 0; i < 5 && !(await publicRadio.isVisible().catch(() => false)); i++) {
    await page.locator('#next-button').first().click({ timeout: 30_000 });
    await page.waitForTimeout(2000);
  }
  await checkRadio(page, 'PUBLIC', 'Public');

  // Wait until the upload/processing allows publishing, then publish
  const done = page.locator('#done-button').first();
  for (let i = 0; i < 180 && (await done.getAttribute('aria-disabled').catch(() => 'true')) === 'true'; i++) {
    await page.waitForTimeout(2000);
  }
  // Read the video id before publishing (the dialog shows the link while uploading)
  const id = await page.evaluate(() => {
    const hrefs = [...document.querySelectorAll('a')].map((a) => a.href);
    const m = hrefs.map((h) => h.match(/(?:youtu\.be\/|shorts\/|watch\?v=|\/video\/)([\w-]{11})/)).find(Boolean);
    return m ? m[1] : null;
  });
  await shot(page, 'before_publish');
  const doneLabel = ((await done.innerText().catch(() => '')) || 'Publish').trim();
  await done.click({ timeout: 30_000 });
  log('INFO', 'YouTubeStudio', `Clicked "${doneLabel}" (video ${id ?? 'id unknown'}), confirming it is public...`);
  if (!id) throw new Error(`Publish clicked but the video id could not be read. Screenshot: ${await shot(page, 'after_publish')}`);

  // Confirm through YouTube's public oEmbed endpoint (only answers for public videos)
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/shorts/${id}&format=json`).catch(() => null);
    if (res?.ok) return `https://youtube.com/shorts/${id}`;
    await page.waitForTimeout(6000);
  }
  throw new Error(`Video ${id} was published but is not publicly visible after 4 minutes. Screenshot: ${await shot(page, 'after_publish')}`);
};

export const uploadToYouTubeStudio = async (
  videoPath: string,
  seo: SEOMetadata,
  options: { headless?: boolean } = {}
): Promise<string> => {
  const { browser, page } = await openStudio(options.headless);
  try {
    log('INFO', 'YouTubeStudio', 'Opening YouTube Studio upload...');
    await page.goto('https://www.youtube.com/upload', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(6000);
    await assertLoggedIn(page);

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached', timeout: 60_000 });
    await fileInput.setInputFiles(videoPath);
    log('INFO', 'YouTubeStudio', 'Video attached; waiting for YouTube to initialize the upload...');
    await page.waitForTimeout(8000);
    if (DAILY_LIMIT.test(await page.evaluate(() => document.body.innerText).catch(() => ''))) {
      // Close the dialog without leaving a half-done draft behind
      await page.locator('#close-button, ytcp-button#close-button, [aria-label="Fechar"], [aria-label="Close"]').first().click({ timeout: 5000 }).catch(() => {});
      throw new YouTubeDailyLimitError(`YouTube daily upload limit reached (verify the channel at https://www.youtube.com/verify to raise it). Screenshot: ${await shot(page, 'daily_limit')}`);
    }

    const url = await fillDetailsAndPublish(page, seo).catch(async (err) => {
      if (DAILY_LIMIT.test(await page.evaluate(() => document.body.innerText).catch(() => ''))) {
        throw new YouTubeDailyLimitError(`YouTube daily upload limit reached (verify the channel at https://www.youtube.com/verify). ${(err as Error).message.split('\n')[0]}`);
      }
      // Keep evidence: what dialog/message blocked us (daily upload limit, verification, policy...)
      const file = await shot(page, 'upload_failed');
      const dialog = await page
        .locator('tp-yt-paper-dialog, ytcp-uploads-dialog, ytcp-dialog')
        .first()
        .innerText()
        .catch(() => '');
      throw new Error(`${(err as Error).message.split('\n')[0]} | dialog: ${dialog.replace(/\s+/g, ' ').slice(0, 400)} | screenshot: ${file}`);
    });
    log('SUCCESS', 'YouTubeStudio', `Published PUBLIC Short: ${url}`);
    return url;
  } finally {
    await browser.close();
  }
};

/**
 * Finishes an upload that was left as a draft (matched by its current title, e.g. the file name)
 * instead of uploading the file again.
 */
export const publishYouTubeDraft = async (draftTitleContains: string, seo: SEOMetadata): Promise<string> => {
  const { browser, page } = await openStudio();
  try {
    await page.goto('https://studio.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(5000);
    await assertLoggedIn(page);
    const channelUrl = page.url().match(/studio\.youtube\.com\/channel\/[\w-]+/)?.[0];
    await page.goto(`https://${channelUrl}/videos/short`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8000);

    const row = page.locator('ytcp-video-row').filter({ hasText: draftTitleContains }).first();
    await row.waitFor({ state: 'visible', timeout: 30_000 });
    await row.getByText(/Editar rascunho|Edit draft/i).first().click();
    log('INFO', 'YouTubeStudio', `Opened draft "${draftTitleContains}"`);

    const url = await fillDetailsAndPublish(page, seo);
    log('SUCCESS', 'YouTubeStudio', `Published PUBLIC Short from draft: ${url}`);
    return url;
  } finally {
    await browser.close();
  }
};

/** Fixes the title of an already-published video (Studio edit page) */
export const updateYouTubeTitle = async (videoId: string, title: string): Promise<void> => {
  const { browser, page } = await openStudio();
  try {
    await page.goto(`https://studio.youtube.com/video/${videoId}/edit`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8000);
    await assertLoggedIn(page);
    await page.locator(TITLE_BOX).first().waitFor({ state: 'visible', timeout: 60_000 });
    await setTextbox(page, TITLE_BOX, title.slice(0, 100), 'title');
    const save = page.locator('ytcp-button#save, #save').first();
    await save.click({ timeout: 30_000 });
    await page.waitForTimeout(4000);
    log('SUCCESS', 'YouTubeStudio', `Updated title of ${videoId}`);
  } finally {
    await browser.close();
  }
};
