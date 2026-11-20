import { execFile } from 'child_process';
import { existsSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { chromium } from 'playwright';
import { maskProfanity } from '../compliance/profanity.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import { highlightKeywords } from './caption.js';

const execFileAsync = promisify(execFile);

/**
 * Burned-in speech subtitles (Whisper, local, free):
 *   clip audio -> whisper.cpp (large-v3-turbo, pt, Silero VAD) -> words with timestamps
 *   -> filter (English game dialogue, hallucinations, low confidence) -> mask profanity
 *   -> 1-3 word chunks -> one transparent PNG per chunk -> ffconcat image track for FFmpeg overlay.
 * Works without FFmpeg drawtext/libass (this machine's FFmpeg has neither).
 * TikTok/Instagram read on-screen text and speech for search, and most people watch muted.
 */

export interface SubWord {
  text: string;
  start: number;
  end: number;
  p: number;
}
export interface SubSegment {
  text: string;
  start: number;
  end: number;
  words: SubWord[];
}
export interface SubChunk {
  text: string;
  start: number;
  end: number;
}

/** Canvas of every subtitle PNG (all frames must share one size for the concat track) */
export const SUB_W = 1000;
export const SUB_H = 240;
/** Top of the subtitle canvas in the 1080x1920 output: ~60% down, above TikTok/Reels bottom UI (last ~20%) */
export const SUB_Y = 1120;

export const subtitlesAvailable = (): boolean =>
  config.subtitles !== 'off' && existsSync(config.whisperModelPath);

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  p?: number;
}
interface WhisperSegment {
  text: string;
  offsets: { from: number; to: number };
  tokens?: WhisperToken[];
}

/** Whisper tokens -> words (a token starting with a space begins a new word) */
export const tokensToWords = (tokens: WhisperToken[]): SubWord[] => {
  const words: SubWord[] = [];
  for (const t of tokens) {
    if (/^\[_/.test(t.text) || !t.text) continue;
    const startsWord = /^\s/.test(t.text) || words.length === 0;
    const text = t.text.trim();
    if (!text) continue;
    if (startsWord) {
      words.push({ text, start: t.offsets.from / 1000, end: t.offsets.to / 1000, p: t.p ?? 1 });
    } else {
      const w = words[words.length - 1];
      w.text += text;
      w.end = t.offsets.to / 1000;
      // Punctuation tokens are often low-confidence and say nothing about the word itself
      if (!/^[\p{P}\p{S}]+$/u.test(text)) w.p = Math.min(w.p, t.p ?? 1);
    }
  }
  return words;
};

/**
 * With --vad, whisper.cpp maps SEGMENT times back to the real timeline but leaves TOKEN times on
 * the speech-only (compressed) timeline (seen: segment at 5.47 s, its tokens at 2.06 s).
 * Segment times are right, so stretch the words linearly into the segment; if the token times
 * collapse to one instant, spread the words by their length.
 */
export const fitWordsToSegment = (words: SubWord[], text: string, segStart: number, segEnd: number): SubSegment => {
  if (!words.length) return { text, start: segStart, end: segEnd, words };
  const w0 = words[0].start;
  const wN = words[words.length - 1].end;
  const span = segEnd - segStart;
  if (wN - w0 > 0.05) {
    const k = span / (wN - w0);
    for (const w of words) {
      w.start = segStart + (w.start - w0) * k;
      w.end = segStart + (w.end - w0) * k;
    }
  } else {
    const total = words.reduce((n, w) => n + w.text.length + 1, 0);
    let t = segStart;
    for (const w of words) {
      const d = (span * (w.text.length + 1)) / total;
      w.start = t;
      w.end = t + d;
      t += d;
    }
  }
  return { text, start: segStart, end: segEnd, words };
};

const EN = new Set('the you a an to of and is are was it that this i me my your he she they we in on at for with what do don\'t not have has be been just get got go going him her them there here over named ever guy man hey yeah oh okay ok can will would said tell'.split(' '));
const PT = new Set('que é eu não o a os as de do da pra para isso isto tá ta tô to mas meu minha você vc ele ela eles nós aqui ali lá já vai foi tem né cara mano uma um no na com por se mais muito olha nossa caramba gente então ai'.split(' '));

/** Drops English (game NPC dialogue) sentences: the audience reads Portuguese */
export const looksEnglish = (text: string): boolean => {
  const words = text.toLowerCase().replace(/[^\p{L}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  const en = words.filter((w) => EN.has(w)).length;
  const pt = words.filter((w) => PT.has(w) || /[ãõçáéíóúâêô]/.test(w)).length;
  return en >= 2 && en > pt;
};

/** Things Whisper writes on music/silence/game noise */
const HALLUCINATION =
  /(amara\.org|legendas? (pela|por)|obrigad[oa] por assistir|inscreva-se|se inscreva|ative o sininho|transcri[çc][ãa]o|subt[íi]tulos|www\.|\.com\b|♪)/i;

export const cleanSegments = (segments: SubSegment[]): SubSegment[] => {
  const out: SubSegment[] = [];
  for (const s of segments) {
    const text = s.text.trim();
    if (!text || HALLUCINATION.test(text) || looksEnglish(text)) continue;
    const avgP = s.words.reduce((n, w) => n + w.p, 0) / Math.max(1, s.words.length);
    if (avgP < 0.45 || (s.words.length === 1 && avgP < 0.7)) continue;
    // Whisper sometimes repeats the previous sentence on noise
    if (out.length && out[out.length - 1].text.toLowerCase() === text.toLowerCase()) continue;
    out.push({ ...s, text });
  }
  return out;
};

/** 1-3 words per chunk (max ~18 chars), split at punctuation; no flicker between close chunks */
export const chunkWords = (segments: SubSegment[], maxWords = 3, maxChars = 18): SubChunk[] => {
  const chunks: SubChunk[] = [];
  for (const seg of segments) {
    let cur: SubWord[] = [];
    const flush = () => {
      if (!cur.length) return;
      chunks.push({ text: cur.map((w) => w.text).join(' '), start: cur[0].start, end: cur[cur.length - 1].end });
      cur = [];
    };
    for (const w of seg.words) {
      const len = [...cur, w].map((x) => x.text).join(' ').length;
      if (cur.length && (cur.length >= maxWords || len > maxChars)) flush();
      cur.push(w);
      if (/[.!?…,;:]$/.test(w.text)) flush();
    }
    flush();
  }
  // Whisper often gives several words the same timestamp: walk forward so every chunk gets
  // a readable slot (>= 0.45 s) without overlapping the previous one
  let prevEnd = 0;
  for (const c of chunks) {
    c.text = maskProfanity(c.text.replace(/[,;:]$/, ''));
    c.start = Math.max(c.start, prevEnd);
    c.end = Math.min(Math.max(c.end, c.start + 0.45), c.start + 2.5);
    prevEnd = c.end;
  }
  // Bridge small gaps so the text doesn't blink between chunks
  for (let i = 0; i < chunks.length - 1; i++) {
    if (chunks[i + 1].start - chunks[i].end < 0.35) chunks[i].end = chunks[i + 1].start;
  }
  return chunks.filter((c) => c.end - c.start >= 0.12 && /[\p{L}\p{N}]/u.test(c.text));
};

const srtTime = (t: number) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
export const toSrt = (segments: SubSegment[]): string =>
  segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${maskProfanity(s.text)}\n`).join('\n');

/** Runs whisper.cpp on [start, end] of the video. Returns cleaned segments (may be empty). */
export const transcribe = async (videoPath: string, start: number, end: number, workBase: string): Promise<SubSegment[]> => {
  const wav = `${workBase}_sub.wav`;
  const jsonBase = `${workBase}_sub`;
  try {
    await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-ss', String(start), '-to', String(end), '-i', videoPath, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
    const lang = config.contentLocale.toLowerCase().startsWith('pt') ? 'pt' : 'auto';
    const args = ['-m', config.whisperModelPath, '-f', wav, '-l', lang, '-ojf', '-of', jsonBase, '-np', '-mc', '0', '-sns'];
    if (existsSync(config.whisperVadModelPath)) args.push('--vad', '-vm', config.whisperVadModelPath);
    await execFileAsync(config.whisperCliPath, args, { timeout: 180_000, maxBuffer: 20 * 1024 * 1024 });
    const data = JSON.parse(await fs.readFile(`${jsonBase}.json`, 'utf-8')) as { transcription: WhisperSegment[] };
    const segments: SubSegment[] = data.transcription.map((s) =>
      fitWordsToSegment(tokensToWords(s.tokens || []), s.text, s.offsets.from / 1000, s.offsets.to / 1000)
    );
    return cleanSegments(segments);
  } finally {
    await Promise.all([wav, `${jsonBase}.json`].map((f) => fs.unlink(f).catch(() => {})));
  }
};

const chunkHtml = (text: string) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${SUB_W}px;height:${SUB_H}px;background:transparent;overflow:hidden}
  body{display:flex;align-items:center;justify-content:center}
  .t{max-width:820px;text-align:center;color:#fff;text-transform:uppercase;
     font:900 76px/1.08 "Arial Black","Helvetica Neue",Impact,sans-serif;letter-spacing:.5px;
     -webkit-text-stroke:3px #000;paint-order:stroke fill;
     text-shadow:0 5px 0 #000,0 0 18px rgba(0,0,0,.85)}
  .t b{color:#ffe600}
</style></head><body><div class="t">${highlightKeywords(text)}</div></body></html>`;

export interface SubtitleTrack {
  /** ffconcat file: one PNG per chunk + blank gaps, timed to the clip */
  concatPath: string;
  srtPath: string;
  chunks: SubChunk[];
  files: string[];
}

/**
 * Builds the subtitle image track for [start, end] of the source video.
 * Returns undefined when Whisper is missing or nobody speaks (Portuguese) in the clip.
 */
export const buildSubtitleTrack = async (
  videoPath: string,
  start: number,
  end: number,
  outBase: string
): Promise<SubtitleTrack | undefined> => {
  if (!subtitlesAvailable()) return undefined;
  const t0 = Date.now();
  const segments = await transcribe(videoPath, start, end, outBase);
  const chunks = chunkWords(segments);
  const wordCount = chunks.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
  if (wordCount < 4) {
    log('INFO', 'Subtitles', `No usable Portuguese speech (${wordCount} words); no subtitles`);
    return undefined;
  }

  const dir = `${outBase}_subs`;
  await fs.mkdir(dir, { recursive: true });
  const files: string[] = [];
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: SUB_W, height: SUB_H }, deviceScaleFactor: 1 });
    const blank = path.join(dir, 'blank.png');
    await page.setContent('<html><body style="margin:0;background:transparent"></body></html>');
    await page.screenshot({ path: blank, omitBackground: true });
    files.push(blank);
    for (const [i, c] of chunks.entries()) {
      const file = path.join(dir, `s${String(i).padStart(3, '0')}.png`);
      await page.setContent(chunkHtml(c.text), { waitUntil: 'load' });
      await page.screenshot({ path: file, omitBackground: true });
      files.push(file);
    }
  } finally {
    await browser.close();
  }

  // ffconcat: blank until the first word, each chunk for its duration, blank in gaps, blank at the end
  const lines = ['ffconcat version 1.0'];
  const add = (file: string, dur: number) => {
    if (dur <= 0.01) return;
    lines.push(`file '${path.basename(file)}'`, `duration ${dur.toFixed(3)}`);
  };
  let t = 0;
  chunks.forEach((c, i) => {
    add(files[0], c.start - t);
    add(files[i + 1], c.end - Math.max(c.start, t));
    t = Math.max(c.end, t);
  });
  const total = end - start;
  add(files[0], Math.max(0.1, total - t));
  lines.push(`file '${path.basename(files[0])}'`); // last entry repeated so its duration is honoured
  const concatPath = path.join(dir, 'subs.ffconcat');
  await fs.writeFile(concatPath, lines.join('\n') + '\n');

  const srtPath = `${outBase}.srt`;
  await fs.writeFile(srtPath, toSrt(segments));
  log('SUCCESS', 'Subtitles', `${chunks.length} subtitle chunks (${wordCount} words) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { concatPath, srtPath, chunks, files: [...files, concatPath] };
};

export const removeSubtitleTrack = async (track?: SubtitleTrack) => {
  if (!track) return;
  await fs.rm(path.dirname(track.concatPath), { recursive: true, force: true }).catch(() => {});
};
