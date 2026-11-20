import path from 'path';
import fs from 'fs/promises';
import { ChatVelocitySensor, ChatSpikeEvent } from './ingestion/ingestion.js';
import { extractClipWithClaudeAgent, generateSEO } from './ai/ai.js';
import { generateTestStreamBuffer, createInfiniteLoopClip } from './video/video.js';
import { verifyYouTubeAuth, uploadToTikTok } from './publishing/publishing.js';
import { config } from './utils/config.js';
import { ensureDirectories } from './utils/cleanup.js';
import { log } from './utils/logger.js';

const runEndToEndTest = async () => {
  log('INFO', 'E2E-Test', '=== Starting End-to-End Pipeline Verification ===');
  await ensureDirectories([config.bufferDir, config.outputDir]);

  // 1. Test the adaptive chat validation (small channel: calm chat, then a real hype burst)
  log('INFO', 'E2E-Test', 'Step 1: Simulating calm chat followed by a hype spike...');
  const sensor = new ChatVelocitySensor(config.twitchChannel, 50);
  let capturedSpike: ChatSpikeEvent | null = null;
  sensor.on('spike', (ev: ChatSpikeEvent) => {
    capturedSpike = ev;
  });

  const t0 = Date.now();
  for (let s = 0; s < 120; s += 20) {
    sensor.recordMessage({ username: `calm_${s}`, text: 'boa noite chat' }, t0 + s * 1000);
  }
  const sampleMessages = ['KKKKKKKKKK', 'CLIPA ISSO', 'MDS QUE ISSO', 'NÃO ACREDITO', 'KEKW', 'PQP ELE FEZ'];
  for (let i = 1; i <= 12; i++) {
    sensor.recordMessage(
      { username: `viewer_${i}`, text: sampleMessages[i % sampleMessages.length] },
      t0 + 130_000 + i * 500
    );
  }

  if (!capturedSpike) {
    throw new Error('ChatVelocitySensor did not emit a spike event!');
  }

  // 2. Generate synthetic 12-second 1080p stream buffer via FFmpeg
  const testBufferPath = path.join(config.bufferDir, 'test_stream_buffer.mp4');
  const outputClipPath = path.join(config.outputDir, 'test_infinite_loop_9x16.mp4');
  await generateTestStreamBuffer(testBufferPath, 12);

  // 3. Test Claude Code CLI Agent Decision Engine + 9Router SEO
  log('INFO', 'E2E-Test', 'Step 2: Calling Claude Code Agent (CLI) for clip timestamps...');
  const spike: ChatSpikeEvent = capturedSpike;
  const decision = await extractClipWithClaudeAgent({
    bufferDurationSeconds: 12,
    chatMessages: spike.recentMessages,
    channel: config.twitchChannel,
  });

  log('INFO', 'E2E-Test', 'Step 3: Calling local 9Router for SEO metadata...');
  const seo = await generateSEO({
    channel: config.twitchChannel,
    chatMessages: spike.recentMessages,
    clipReason: decision.reason,
  });

  // 4. Test FFmpeg 9:16 crop + hook_split_point Infinite Loop Stitch
  log('INFO', 'E2E-Test', 'Step 4: Rendering 9:16 Infinite Loop clip with FFmpeg...');
  await createInfiniteLoopClip(testBufferPath, outputClipPath, decision);
  const stat = await fs.stat(outputClipPath);
  log('SUCCESS', 'E2E-Test', `Generated 9:16 infinite loop MP4 (${(stat.size / 1024).toFixed(1)} KB)`);

  // 5. Verify Google OAuth2 credentials from .env
  log('INFO', 'E2E-Test', 'Step 5: Verifying Google / YouTube OAuth2 credentials from .env...');
  const ytAuth = await verifyYouTubeAuth();
  log('SUCCESS', 'E2E-Test', 'Google YouTube OAuth2 verified!', ytAuth);

  // 6. Verify TikTok cookies from cookies/tiktok.json in Playwright
  log('INFO', 'E2E-Test', 'Step 6: Verifying TikTok cookies injection in Playwright...');
  const tiktokCheck = await uploadToTikTok(outputClipPath, seo, { dryRun: true, headless: true });
  log('SUCCESS', 'E2E-Test', 'TikTok cookies verified in Playwright!', tiktokCheck);

  log('SUCCESS', 'E2E-Test', '=== ALL PIPELINE TESTS PASSED SUCCESSFULLY ===');
};

runEndToEndTest().catch((err) => {
  log('ERROR', 'E2E-Test', 'Pipeline test failed', (err as Error).stack || (err as Error).message);
  process.exit(1);
});
