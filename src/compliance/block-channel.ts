import { loadPermissions, savePermissions, findEntry } from './permissions.js';
import { log } from '../utils/logger.js';

/**
 * Block / unblock a streamer (they will never be clipped or posted, queued clips are cancelled).
 *   npm run block -- <login> "reason"
 *   npm run block -- <login> --unblock
 */
const run = async () => {
  const [login, ...rest] = process.argv.slice(2);
  if (!login) throw new Error('Usage: npm run block -- <login> "reason"   |   npm run block -- <login> --unblock');
  const unblock = rest.includes('--unblock');
  const reason = rest.filter((r) => r !== '--unblock').join(' ') || 'streamer does not allow clips';
  const today = new Date().toISOString().slice(0, 10);

  const registry = await loadPermissions();
  const entry = findEntry(registry, login);

  if (unblock) {
    if (!entry || entry.status !== 'denied') throw new Error(`${login} is not blocked`);
    entry.status = 'unknown';
    entry.notes = `[manual] unblocked on ${today}`;
    entry.updatedAt = today;
  } else if (entry) {
    entry.status = 'denied';
    entry.platformsAllowed = [];
    entry.notes = `[manual] blocked on ${today}: ${reason}`;
    entry.updatedAt = today;
  } else {
    registry.channels.push({
      login: login.toLowerCase(),
      status: 'denied',
      platformsAllowed: [],
      monetizationAllowed: false,
      creditRequired: true,
      rules: [],
      evidence: [{ source: 'user_reported', url: '', quote: reason, checkedAt: today }],
      notes: `[manual] blocked on ${today}: ${reason}`,
      updatedAt: today,
    });
  }

  await savePermissions(registry);
  log('SUCCESS', 'Block', `${login} ${unblock ? 'unblocked' : `blocked (${reason})`}`);
};

run().catch((err) => {
  log('ERROR', 'Block', (err as Error).message);
  process.exit(1);
});
