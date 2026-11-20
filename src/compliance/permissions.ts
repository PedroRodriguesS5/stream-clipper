import fs from 'fs/promises';
import path from 'path';
import { log } from '../utils/logger.js';
import { config } from '../utils/config.js';

/**
 * Clip permission registry (data/clip-permissions.json).
 *
 * PERMISSION_MODE=denylist (default): every Brazilian channel may be clipped EXCEPT the ones
 *   with `status: "denied"` (block them with `npm run block -- <login>`).
 * PERMISSION_MODE=allowlist: only `status: "allowed"` entries with quoted evidence.
 *
 * `postDelayHours` holds a channel's clips in the post queue (e.g. gaules: 24 h after the live).
 */

export type PermissionStatus = 'allowed' | 'denied' | 'unknown' | 'needs_review';
export type Platform = 'youtube' | 'tiktok' | 'instagram';
export const PLATFORMS: Platform[] = ['youtube', 'tiktok', 'instagram'];
export type ChannelTier = 'small' | 'normal' | 'big' | 'huge';

export interface PermissionEvidence {
  /** twitch_panel | twitch_bio | written_permission (DM/e-mail/Discord) | user_reported | website | video */
  source: string;
  url: string;
  /** Exact text that grants/denies permission (copy/paste, never paraphrase) */
  quote: string;
  checkedAt: string;
}

export interface ChannelPermission {
  login: string;
  displayName?: string;
  status: PermissionStatus;
  /** Platforms where clips may be posted. Empty = none */
  platformsAllowed: Platform[];
  /** true only if the streamer explicitly allows third parties to EARN money with the clips */
  monetizationAllowed: boolean | null;
  creditRequired: boolean;
  /** Streamer's own rules, one per line (e.g. "Marcar @fulano na descrição") */
  rules: string[];
  evidence: PermissionEvidence[];
  tier?: ChannelTier;
  /** Clips of this channel are only posted this many hours after the live moment */
  postDelayHours?: number;
  followers?: number;
  notes?: string;
  updatedAt: string;
}

export interface PermissionRegistry {
  _readme: string;
  channels: ChannelPermission[];
}

export const PERMISSIONS_PATH = path.resolve(process.cwd(), 'data', 'clip-permissions.json');

const README =
  'Clip permission registry. In PERMISSION_MODE=denylist (default) every channel can be clipped except status "denied" ' +
  '(use `npm run block -- <login> "reason"`; deleting an entry does NOT block it). In allowlist mode only status "allowed" ' +
  'with quoted evidence counts. postDelayHours delays posting (e.g. 24). Entries with notes containing [manual] or ' +
  'evidence.source "written_permission" are never overwritten by the scanner.';

export const loadPermissions = async (): Promise<PermissionRegistry> => {
  try {
    const raw = await fs.readFile(PERMISSIONS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as PermissionRegistry;
    return { _readme: README, channels: parsed.channels || [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return { _readme: README, channels: [] };
  }
};

export const savePermissions = async (registry: PermissionRegistry): Promise<void> => {
  await fs.mkdir(path.dirname(PERMISSIONS_PATH), { recursive: true });
  registry.channels.sort((a, b) => a.login.localeCompare(b.login));
  await fs.writeFile(PERMISSIONS_PATH, JSON.stringify({ ...registry, _readme: README }, null, 2) + '\n');
};

export interface PermissionDecision {
  allowed: boolean;
  entry?: ChannelPermission;
  reasons: string[];
}

export const findEntry = (registry: PermissionRegistry, login: string): ChannelPermission | undefined =>
  registry.channels.find((c) => c.login.toLowerCase() === login.toLowerCase());

/** Can we clip + post this channel to `platform`? (monetization is checked separately) */
export const checkClipPermission = (
  registry: PermissionRegistry,
  login: string,
  platform?: Platform
): PermissionDecision => {
  const entry = findEntry(registry, login);
  const reasons: string[] = [];

  if (config.permissionMode === 'denylist') {
    if (entry?.status === 'denied') reasons.push(`${login} is blocked (status "denied")`);
    if (platform && entry?.status === 'allowed' && entry.platformsAllowed.length && !entry.platformsAllowed.includes(platform)) {
      reasons.push(`streamer only allows clips on ${entry.platformsAllowed.join(', ')}`);
    }
    return { allowed: reasons.length === 0, entry, reasons };
  }

  if (!entry) return { allowed: false, reasons: [`${login} is not in data/clip-permissions.json`] };
  if (entry.status !== 'allowed') reasons.push(`permission status is "${entry.status}"`);
  if (!entry.evidence.some((e) => e.quote.trim().length > 0)) reasons.push('no quoted evidence of permission');
  if (platform && !entry.platformsAllowed.includes(platform)) {
    reasons.push(`streamer does not allow clips on ${platform}`);
  }
  return { allowed: reasons.length === 0, entry, reasons };
};

/** Channels explicitly marked allowed (preferred targets in auto mode) */
export const allowedLogins = (registry: PermissionRegistry): string[] =>
  registry.channels
    .filter((c) => c.status === 'allowed' && checkClipPermission(registry, c.login).allowed)
    .map((c) => c.login.toLowerCase());

export const deniedLogins = (registry: PermissionRegistry): Set<string> =>
  new Set(registry.channels.filter((c) => c.status === 'denied').map((c) => c.login.toLowerCase()));

export const upsertPermission = (registry: PermissionRegistry, incoming: ChannelPermission): 'added' | 'updated' | 'kept' => {
  const idx = registry.channels.findIndex((c) => c.login.toLowerCase() === incoming.login.toLowerCase());
  if (idx === -1) {
    registry.channels.push(incoming);
    return 'added';
  }
  const current = registry.channels[idx];
  // Never overwrite a decision backed by written permission or a manual edit
  if (current.evidence.some((e) => e.source === 'written_permission') || current.notes?.includes('[manual]')) {
    return 'kept';
  }
  registry.channels[idx] = { ...current, ...incoming, notes: incoming.notes ?? current.notes };
  log('INFO', 'Permissions', `Updated ${incoming.login}: ${current.status} -> ${incoming.status}`);
  return 'updated';
};
