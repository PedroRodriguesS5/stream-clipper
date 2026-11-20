import { runClaudeJson } from '../ai/claude-cli.js';
import { discoverLiveStreams, fetchChannelProfiles, ChannelProfile } from '../ingestion/twitch-gql.js';
import { config } from '../utils/config.js';
import { log } from '../utils/logger.js';
import {
  ChannelPermission,
  ChannelTier,
  loadPermissions,
  savePermissions,
  upsertPermission,
} from './permissions.js';
import { tierForViewers } from '../ingestion/chat-validation.js';

/**
 * Scans live Portuguese channels (big AND small) for clip rules written in their Twitch
 * bio/panels, classifies them with Claude, and records the result in data/clip-permissions.json.
 *
 *   npm run scan:permissions                 # scan live PT channels in SCAN_CATEGORIES
 *   npm run scan:permissions -- loud_coringa  # (re)check specific channels
 *
 * IMPORTANT: panels that are only images have no readable text. Those channels stay "unknown";
 * check them by hand or ask the streamer (docs/pedido-de-permissao.md).
 */

const CLIP_TEXT = /\bcortes?\b|\bclip(e|es|s)?\b|\bediç(ão|oes|ões)\b|\beditor(es)?\b|\breupload|\brepost/i;

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['allowed', 'denied', 'unknown'],
      description:
        'allowed ONLY if the text explicitly lets third parties/fans post clips of the streams OUTSIDE Twitch (YouTube/TikTok/redes sociais). Clip contests that only mention Twitch clips are unknown. Promoting the streamer\'s OWN official clip channel is NOT permission (unknown). denied if it forbids it.',
    },
    monetizationAllowed: {
      type: ['boolean', 'null'],
      description: 'true only if the text explicitly allows third parties to monetize; false if forbidden; null if not mentioned',
    },
    creditRequired: { type: 'boolean' },
    platformsAllowed: {
      type: 'array',
      items: { type: 'string', enum: ['youtube', 'tiktok'] },
      description: 'Only platforms the text names explicitly ("redes sociais"/"todas as plataformas" counts as both). Empty if none named.',
    },
    rules: { type: 'array', items: { type: 'string' }, description: 'Each rule the streamer wrote, in Portuguese' },
    quote: { type: 'string', description: 'The exact sentence(s) copied from the text that support the decision' },
    hasOwnClipChannel: { type: 'boolean' },
  },
  required: ['status', 'monetizationAllowed', 'creditRequired', 'platformsAllowed', 'rules', 'quote', 'hasOwnClipChannel'],
  additionalProperties: false,
};

interface Classification {
  status: 'allowed' | 'denied' | 'unknown';
  monetizationAllowed: boolean | null;
  creditRequired: boolean;
  platformsAllowed: ('youtube' | 'tiktok')[];
  rules: string[];
  quote: string;
  hasOwnClipChannel: boolean;
}

const profileTexts = (p: ChannelProfile) =>
  [
    p.description ? `[bio] ${p.description}` : '',
    ...p.panels.map((x, i) => `[painel ${i + 1}] ${x.title} ${x.description} ${x.linkURL}`.trim()),
  ].filter((t) => t.length > 12);

const classify = async (p: ChannelProfile, texts: string[]): Promise<Classification> =>
  runClaudeJson<Classification>(
    [
      `You review the public Twitch channel text of the Brazilian streamer "${p.login}" to find their rules for third-party clips ("cortes").`,
      `Be strict and literal. Do not assume permission. Only the text below counts:`,
      texts.join('\n---\n').slice(0, 12_000),
      `Return JSON. The "quote" must be copied verbatim from the text above (empty string if nothing relevant).`,
    ].join('\n\n'),
    CLASSIFY_SCHEMA,
    { timeoutMs: 90_000 }
  );

const run = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const explicit = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const registry = await loadPermissions();

  let logins: string[];
  if (explicit.length) {
    logins = explicit;
  } else {
    const streams = await discoverLiveStreams(config.streamLanguage, config.scanCategories, { includeSmall: true });
    logins = streams.map((s) => s.login);
    log('INFO', 'PermissionScan', `Found ${logins.length} live ${config.streamLanguage} channels in ${config.scanCategories.length} categories`);
  }

  const profiles = await fetchChannelProfiles(logins);
  const stats = { scanned: profiles.length, withClipText: 0, allowed: 0, denied: 0, unknown: 0 };

  for (const p of profiles) {
    const texts = profileTexts(p);
    const clipTexts = texts.filter((t) => CLIP_TEXT.test(t));
    if (!clipTexts.length && !explicit.length) continue;
    stats.withClipText++;

    let c: Classification;
    try {
      c = clipTexts.length
        ? await classify(p, clipTexts)
        : { status: 'unknown', monetizationAllowed: null, creditRequired: true, platformsAllowed: [], rules: [], quote: '', hasOwnClipChannel: false };
    } catch (err) {
      log('WARN', 'PermissionScan', `Could not classify ${p.login}: ${(err as Error).message}`);
      continue;
    }

    // Safety net: an "allowed" without a verbatim quote from the channel text is downgraded
    const quoteIsReal = c.quote.trim().length > 10 && clipTexts.some((t) => t.includes(c.quote.trim().slice(0, 40)));
    let status: ChannelPermission['status'] = c.status;
    if (status === 'allowed' && !quoteIsReal) status = 'needs_review';
    // Inviting fans to clip (e.g. a clip contest) without naming YouTube/TikTok is not enough
    if (status === 'allowed' && !c.platformsAllowed.length) status = 'needs_review';

    const tier: ChannelTier = tierForViewers(p.viewersCount);
    const entry: ChannelPermission = {
      login: p.login,
      displayName: p.displayName,
      status,
      platformsAllowed: status === 'allowed' ? c.platformsAllowed : [],
      monetizationAllowed: c.monetizationAllowed,
      creditRequired: c.creditRequired,
      rules: c.rules,
      evidence: c.quote
        ? [{ source: 'twitch_panel', url: `https://www.twitch.tv/${p.login}/about`, quote: c.quote, checkedAt: today }]
        : [],
      tier,
      followers: p.followers,
      notes: status === 'needs_review'
        ? 'Text encourages clipping but does not clearly allow reposting on YouTube/TikTok or monetizing. Confirm with the streamer.'
        : c.hasOwnClipChannel
        ? 'Has an official clip channel of their own. Ask permission before posting (docs/pedido-de-permissao.md).'
        : status === 'unknown'
          ? 'No explicit rule found in text panels (image panels are not readable). Ask the streamer.'
          : undefined,
      updatedAt: today,
    };

    const result = upsertPermission(registry, entry);
    stats[status === 'allowed' ? 'allowed' : status === 'denied' ? 'denied' : 'unknown']++;
    log('INFO', 'PermissionScan', `${p.login} (${tier}, ${p.followers} followers): ${status} [${result}]`, c.quote || undefined);
  }

  await savePermissions(registry);
  log('SUCCESS', 'PermissionScan', 'Scan finished -> data/clip-permissions.json', stats);
};

run().catch((err) => {
  log('ERROR', 'PermissionScan', (err as Error).message);
  process.exit(1);
});
