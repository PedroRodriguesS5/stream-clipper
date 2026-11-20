import { ChatSpikeDetector, TIER_RULES, ChatTier, classifyMessage } from './ingestion/chat-validation.js';
import { log } from './utils/logger.js';

/**
 * Offline checks for the chat validation (no network):  npm run test:chat
 */
let failures = 0;
const expect = (name: string, actual: boolean, expected: boolean, detail = '') => {
  const ok = actual === expected;
  if (!ok) failures++;
  log(ok ? 'SUCCESS' : 'ERROR', 'ChatTest', `${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
};

const hype = ['KKKKKKKK', 'CLIPA ISSO', 'MDS', 'NÃO ACREDITO', 'KEKW', 'PQP', 'caralho kkkk', 'que isso???'];
const calm = ['boa noite', 'qual o nome da musica', 'vai jogar oq hj', 'salve', 'tudo bem?', 'gg'];

/** steady chat for `seconds` at `perSecond` msgs/s, then optionally a burst */
const simulate = (
  tier: ChatTier,
  perSecond: number,
  burst?: { msgs: number; users: number; texts: string[]; seconds: number }
) => {
  const t0 = 1_000_000;
  const det = new ChatSpikeDetector(TIER_RULES[tier], t0);
  let spiked = false;
  let n = 0;
  const steadyEnd = t0 + 240_000;
  for (let t = t0; t < steadyEnd; t += 1000 / perSecond) {
    det.add({ username: `u${n % 400}`, text: `${calm[n % calm.length]} ${n}` }, t);
    n++;
    if (det.check(t).isSpike) spiked = true;
  }
  const steadySpike = spiked;
  let last = det.check(steadyEnd);
  if (burst) {
    const step = (burst.seconds * 1000) / burst.msgs;
    let nextBackground = steadyEnd;
    for (let i = 0; i < burst.msgs; i++) {
      const t = steadyEnd + i * step;
      det.add({ username: `b${i % burst.users}`, text: burst.texts[i % burst.texts.length] }, t);
      // keep background chat running at its normal speed during the burst
      while (nextBackground <= t) {
        det.add({ username: `u${n % 400}`, text: `${calm[n % calm.length]} ${n++}` }, nextBackground + 1);
        nextBackground += 1000 / perSecond;
      }
      last = det.check(t + 2);
      if (last.isSpike) spiked = true;
    }
  }
  return { steadySpike, spiked, last };
};

// classification
expect('bot ignored', classifyMessage({ username: 'Nightbot', text: 'Siga no insta!' }).valid, false);
expect('command ignored', classifyMessage({ username: 'joao', text: '!pix' }).valid, false);
expect('link ignored', classifyMessage({ username: 'joao', text: 'olha https://x.com' }).valid, false);
expect('counting spam ignored', classifyMessage({ username: 'joao', text: '3139' }).valid, false);
expect('kkkk is hype', classifyMessage({ username: 'joao', text: 'kkkkkkk' }).hype, true);
expect('normal msg not hype', classifyMessage({ username: 'joao', text: 'qual o seu setup?' }).hype, false);

// SMALL creator (~0.1 msg/s): 8 people laughing within 20 s must trigger
let r = simulate('small', 0.1, { msgs: 10, users: 8, texts: hype, seconds: 15 });
expect('small: calm chat does not trigger', r.steadySpike, false);
expect('small: real hype burst triggers', r.spiked, true, r.last.reason);

// SMALL creator: one person spamming does NOT trigger
r = simulate('small', 0.1, { msgs: 12, users: 1, texts: hype, seconds: 15 });
expect('small: one spammer does not trigger', r.spiked, false, r.last.reason);

// NORMAL streamer (~1 msg/s): fast but calm chat does not trigger; real hype does
r = simulate('normal', 1, { msgs: 40, users: 30, texts: hype, seconds: 8 });
expect('normal: steady chat does not trigger', r.steadySpike, false);
expect('normal: hype burst triggers', r.spiked, true, r.last.reason);

// HUGE streamer (~8 msg/s = 64 per 8 s window, old rule would fire non-stop)
r = simulate('huge', 8);
expect('huge: constant fast chat does not trigger', r.spiked, false, r.last.reason);
r = simulate('huge', 8, { msgs: 160, users: 120, texts: hype, seconds: 8 });
expect('huge: huge hype burst triggers', r.spiked, true, r.last.reason);
// HUGE streamer: volume jump but not hype (e.g. everyone answering a question)
r = simulate('huge', 8, { msgs: 160, users: 120, texts: ['sim', 'nao', 'talvez', 'eu acho que sim'], seconds: 8 });
expect('huge: non-hype burst does not trigger', r.spiked, false, r.last.reason);

// BIG streamer like cellbit (~14k viewers, ~2 msg/s): steady chat does not fire, a real burst does
r = simulate('big', 2);
expect('big: steady 2 msg/s chat does not trigger', r.spiked, false, r.last.reason);
r = simulate('big', 2, { msgs: 50, users: 40, texts: hype, seconds: 8 });
expect('big: hype burst on a 2 msg/s chat triggers', r.spiked, true, r.last.reason);
r = simulate('big', 2, { msgs: 50, users: 40, texts: ['sim', 'nao', 'talvez', 'eu acho que sim'], seconds: 8 });
expect('big: non-hype burst does not trigger', r.spiked, false, r.last.reason);

if (failures) {
  log('ERROR', 'ChatTest', `${failures} check(s) failed`);
  process.exit(1);
}
log('SUCCESS', 'ChatTest', 'All chat validation checks passed');
