import fs from 'fs/promises';
import path from 'path';
import { evaluateMonetization } from './compliance/monetization.js';
import { publishOrQueue } from './publishing/post-queue.js';
import { planLayout } from './video/layout.js';
import { config } from './utils/config.js';
import { log } from './utils/logger.js';

/**
 * Gate + queue scenarios on an already-rendered clip. Never uploads anything:
 * only the delayed (queued) scenario calls publishOrQueue.
 *   npm run test:gate -- output/<clip>.mp4
 */
const run = async () => {
  const clipPath = path.resolve(process.argv[2] || '');
  await fs.access(clipPath);
  const layout = { ...(await planLayout(clipPath, 2)), kind: 'stack' as const };
  const base = {
    streamTitle: 'GTA RP com a tropa',
    category: 'Grand Theft Auto V',
    clip: { path: clipPath, layout, hasCaption: true, durationSeconds: 80 },
    chatMessages: ['user1: KKKKKKK', 'user2: CLIPA'],
    momentAt: new Date(),
  };
  const seoFor = (ch: string) => ({
    hook_caption: 'NINGUÉM ESPERAVA ESSE FINAL 😱',
    title: `GTA RP: momento insano na live do ${ch}`,
    description: `Corte da live do @${ch} na Twitch. Segue pra mais cortes!`,
    hashtags: ['#gtarp', '#gta5', '#cortes'],
  });

  log('INFO', 'GateTest', `growthMode=${config.growthMode} permissionMode=${config.permissionMode}`);

  // 1. gaules (allowed, 24 h delay) -> growth post, queued for +24 h
  const g = await evaluateMonetization({ ...base, channel: 'gaules', seo: seoFor('gaules') });
  log('INFO', 'GateTest', `gaules -> youtube=${g.youtube.mode} tiktok=${g.tiktok.mode} postAfter=${g.youtube.postAfter}`);
  log('INFO', 'GateTest', 'gaules publishOrQueue', await publishOrQueue(g, seoFor('gaules')));

  // 2. unknown Brazilian streamer, not blocked -> growth (not posted here)
  const u = await evaluateMonetization({ ...base, channel: 'surskity11', seo: seoFor('surskity11') });
  log('INFO', 'GateTest', `surskity11 -> youtube=${u.youtube.mode} tiktok=${u.tiktok.mode}`);

  // 3. title without credit + react stream -> blocked
  const b = await evaluateMonetization({
    ...base,
    channel: 'surskity11',
    streamTitle: 'REACT de vídeos do YouTube',
    seo: { ...seoFor('x'), title: 'Momento insano', description: 'Olha isso' },
  });
  log('INFO', 'GateTest', `react/no-credit -> youtube=${b.youtube.mode} tiktok=${b.tiktok.mode}`);
};

run().catch((e) => {
  log('ERROR', 'GateTest', (e as Error).message);
  process.exit(1);
});
