import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import { TimedChatMessage } from '../ingestion/ingestion.js';

const execFileAsync = promisify(execFile);

/**
 * Signals that show a REAL reaction, so we don't clip "just a good kill":
 *  - audio: loudness per second of the stream (streamer shouting/laughing -> peaks)
 *  - chat:  messages per second lined up with the video (viewers react ~3-15 s after the moment)
 * A good moment = something happens (t) + audio peak right after + chat burst a few seconds later.
 */

export interface SecondSignal {
  second: number;
  loudness: number; // max momentary LUFS in this second
  chat: number; // valid messages that arrived for this second of video
  hype: number; // hype messages (KKKK, MDS, emotes...)
  visual: number; // how much the picture changes (0-1): crashes, explosions, cuts, fast action
}

export interface CandidateMoment {
  second: number;
  audioZ: number; // how much louder than usual (std units) in [t, t+6]
  chatZ: number; // how much more hype chat than usual in [t+3, t+20]
  visualZ: number; // how much more on-screen action than usual in [t-2, t+6]
  score: number;
  sampleChat: string[];
}

export interface MomentSignals {
  duration: number;
  seconds: SecondSignal[];
  candidates: CandidateMoment[];
  bestReaction: { audioZ: number; chatZ: number };
}

/** Max momentary loudness (LUFS) per second, via FFmpeg's ebur128 filter */
export const loudnessPerSecond = (videoPath: string): Promise<number[]> =>
  new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-nostats', '-i', videoPath, '-vn', '-af', 'ebur128', '-f', 'null', '-']);
    const perSecond: number[] = [];
    let buf = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/\bt:\s*([\d.]+)\s+TARGET.*?\bM:\s*(-?[\d.]+|-inf)/);
        if (!m) continue;
        const sec = Math.floor(Number(m[1]));
        const val = m[2] === '-inf' ? -120 : Number(m[2]);
        perSecond[sec] = Math.max(perSecond[sec] ?? -120, val);
      }
    });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(Array.from(perSecond, (v) => v ?? -120)) : reject(new Error(`ebur128 exited ${code}`))));
  });

/** Scene-change score per second (max of 2 samples/s), via FFmpeg's scene detection */
export const sceneChangePerSecond = (videoPath: string): Promise<number[]> =>
  new Promise((resolve) => {
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-nostats', '-loglevel', 'error', '-hwaccel', 'videotoolbox', '-i', videoPath, '-an',
      '-vf', "fps=2,scale=160:-2,select='gte(scene\\,0)',metadata=print:key=lavfi.scene_score:file=-", '-f', 'null', '-',
    ]);
    const perSecond: number[] = [];
    let buf = '';
    let t = 0;
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const pt = line.match(/pts_time:([\d.]+)/);
        if (pt) t = Math.floor(Number(pt[1]));
        const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
        if (sc) perSecond[t] = Math.max(perSecond[t] ?? 0, Number(sc[1]));
      }
    });
    proc.on('error', () => resolve([]));
    proc.on('close', () => resolve(Array.from(perSecond, (v) => v ?? 0)));
  });

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

export const computeMomentSignals = async (
  videoPath: string,
  duration: number,
  timedMessages: TimedChatMessage[],
  snapshotEndWallMs: number
): Promise<MomentSignals> => {
  const n = Math.max(1, Math.floor(duration));
  const [loud, scene] = await Promise.all([
    loudnessPerSecond(videoPath).catch(() => [] as number[]),
    sceneChangePerSecond(videoPath),
  ]);

  const seconds: SecondSignal[] = Array.from({ length: n }, (_, i) => ({
    second: i,
    loudness: loud[i] ?? -120,
    chat: 0,
    hype: 0,
    visual: scene[i] ?? 0,
  }));
  const linesBySecond = new Map<number, string[]>();
  for (const m of timedMessages) {
    const sec = Math.floor(duration - (snapshotEndWallMs - m.t) / 1000);
    if (sec < 0 || sec >= n) continue;
    seconds[sec].chat++;
    if (m.hype) seconds[sec].hype++;
    if (!linesBySecond.has(sec)) linesBySecond.set(sec, []);
    linesBySecond.get(sec)!.push(m.line);
  }

  // Audio: robust z-score vs the stream's usual loudness (ignore silence)
  const audible = seconds.map((s) => s.loudness).filter((v) => v > -70);
  const med = median(audible);
  const mad = median(audible.map((v) => Math.abs(v - med))) * 1.4826 || 1.5;
  const audioZ = seconds.map((s) => (s.loudness > -70 ? (s.loudness - med) / Math.max(mad, 1.5) : -3));

  // Chat: hype messages in [t+3, t+20] vs the average such window
  const win = (t: number) => {
    let sum = 0;
    for (let i = t + 3; i <= Math.min(n - 1, t + 20); i++) sum += seconds[i].hype + seconds[i].chat * 0.25;
    return sum;
  };
  const windows = seconds.map((s) => win(s.second));
  const mean = windows.reduce((a, b) => a + b, 0) / windows.length;
  const std = Math.sqrt(windows.reduce((a, b) => a + (b - mean) ** 2, 0) / windows.length) || 1;
  const chatZ = windows.map((w) => (w - mean) / Math.max(std, 1));

  // Visual action: robust z-score of scene change (a crash, explosion, WASTED screen, fast chase)
  const vis = seconds.map((s) => s.visual);
  const vMed = median(vis);
  const vMad = median(vis.map((v) => Math.abs(v - vMed))) * 1.4826 || 0.02;
  const visualZ = vis.map((v) => (v - vMed) / Math.max(vMad, 0.02));

  const scored = seconds
    .filter((s) => s.second >= 3 && s.second <= n - 8)
    .map((s) => {
      const t = s.second;
      const aZ = Math.max(...audioZ.slice(t, Math.min(n, t + 7)));
      const cZ = chatZ[t];
      // cap so a single hard cut (scene switch, menu) can't dominate
      const vZ = Math.min(4, Math.max(...visualZ.slice(Math.max(0, t - 2), Math.min(n, t + 7))));
      const sample: string[] = [];
      for (let i = t; i <= Math.min(n - 1, t + 20) && sample.length < 6; i++) sample.push(...(linesBySecond.get(i) || []).slice(0, 2));
      return {
        second: t,
        audioZ: +aZ.toFixed(2),
        chatZ: +cZ.toFixed(2),
        visualZ: +vZ.toFixed(2),
        score: +(Math.max(0, aZ) + Math.max(0, cZ) * 1.2 + Math.max(0, vZ) * 0.5).toFixed(2),
        sampleChat: sample.slice(0, 6),
      };
    })
    .sort((a, b) => b.score - a.score);

  // Top 3 moments at least 20 s apart
  const candidates: CandidateMoment[] = [];
  for (const c of scored) {
    if (candidates.every((x) => Math.abs(x.second - c.second) >= 20)) candidates.push(c);
    if (candidates.length === 3) break;
  }

  const bestReaction = candidates.length
    ? { audioZ: Math.max(...candidates.map((c) => c.audioZ)), chatZ: Math.max(...candidates.map((c) => c.chatZ)) }
    : { audioZ: 0, chatZ: 0 };
  return { duration, seconds, candidates, bestReaction };
};

/** Compact 5-second timeline for the prompt */
export const timelineForPrompt = (sig: MomentSignals, timedLinesEvery = 5): string => {
  const rows: string[] = ['sec | loudness_vs_usual | chat_msgs | hype_msgs | screen_change(0-1)'];
  const audible = sig.seconds.map((s) => s.loudness).filter((v) => v > -70);
  const med = median(audible);
  for (let t = 0; t < sig.seconds.length; t += timedLinesEvery) {
    const slice = sig.seconds.slice(t, t + timedLinesEvery);
    const loud = Math.max(...slice.map((s) => s.loudness));
    const chat = slice.reduce((a, s) => a + s.chat, 0);
    const hype = slice.reduce((a, s) => a + s.hype, 0);
    const visual = Math.max(...slice.map((s) => s.visual));
    rows.push(`${String(t).padStart(3)} | ${loud > -70 ? `${(loud - med >= 0 ? '+' : '') + (loud - med).toFixed(1)} dB` : 'silent'} | ${chat} | ${hype} | ${visual.toFixed(2)}`);
  }
  return rows.join('\n');
};

/** Frames around a moment, small JPEGs Claude can Read (webcam + game) */
export const extractMomentFrames = async (videoPath: string, seconds: number[], outPrefix: string): Promise<string[]> => {
  const out: string[] = [];
  for (const [i, s] of seconds.entries()) {
    const file = `${outPrefix}_${i}_${Math.round(s)}s.jpg`;
    try {
      await execFileAsync('ffmpeg', ['-v', 'error', '-y', '-ss', String(Math.max(0, s)), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '5', file]);
      out.push(file);
    } catch {
      /* frame past the end: skip */
    }
  }
  return out;
};

export const removeFiles = (files: string[]) => Promise.all(files.map((f) => fs.unlink(f).catch(() => {})));
