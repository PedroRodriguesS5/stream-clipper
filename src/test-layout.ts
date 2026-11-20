import path from 'path';
import { planLayout } from './video/layout.js';
import { createInfiniteLoopClip, getVideoDurationSeconds } from './video/video.js';
import { discoverLiveGtaVIStreams } from './ingestion/ingestion.js';
import { config } from './utils/config.js';
import { log } from './utils/logger.js';

/**
 * Renders a clip from an existing buffer file to check the vertical framing.
 * Usage: npm run test:layout -- [path/to/buffer.mp4]
 */
const run = async () => {
  const streams = await discoverLiveGtaVIStreams();
  log('INFO', 'LayoutTest', `Live ${config.streamLanguage} streams found: ${streams.length}`, streams.slice(0, 5));

  const input = process.argv[2] || path.join(config.bufferDir, 'live_welovegames_snapshot.mp4');
  const dur = await getVideoDurationSeconds(input);
  const start = Math.max(0, dur - 14);
  const split = start + 6;
  const plan = await planLayout(input, split);
  log('INFO', 'LayoutTest', 'Layout plan', plan);

  const out = path.join(config.outputDir, `layout_test_${plan.kind}.mp4`);
  await createInfiniteLoopClip(
    input,
    out,
    { clip_start: start, clip_end: dur, hook_split_point: split, reason: 'layout test', has_reaction: true, third_party_media: false, what_happened: '', streamer_reaction: '', chat_reaction: '', moment_type: 'gameplay_chaos', virality_score: 7 },
    'GTA 6: ele não acreditou nisso 😱',
    plan
  );
  log('SUCCESS', 'LayoutTest', `Wrote ${out}`);
};

run().catch((e) => {
  log('ERROR', 'LayoutTest', (e as Error).message);
  process.exit(1);
});
