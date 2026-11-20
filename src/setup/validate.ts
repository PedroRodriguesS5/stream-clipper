import type { DraftPlan } from './interpret.js';
import type { ClipSession } from './session.js';

export interface Resolvers {
  category: (name: string) => Promise<string | null>;
  channel: (text: string) => Promise<{ login: string; isLive: boolean; category: string } | null>;
}

/**
 * Checks every name in the AI's plan against Twitch and builds the session.
 * Unknown categories/channels are dropped with a note instead of silently clipping nothing.
 */
export const validatePlan = async (
  plan: DraftPlan,
  request: string,
  r: Resolvers,
  now = new Date()
): Promise<{ session: ClipSession; notes: string[] }> => {
  const notes: string[] = [];
  const categories: string[] = [];
  for (const name of plan.categories) {
    const exact = await r.category(name);
    if (!exact) notes.push(`Categoria "${name}" não existe na Twitch; ignorada.`);
    else if (!categories.includes(exact)) {
      if (exact.toLowerCase() !== name.toLowerCase()) notes.push(`"${name}" → ${exact}`);
      categories.push(exact);
    }
  }
  const channels: string[] = [];
  for (const c of plan.channels) {
    const ch = await r.channel(c);
    if (!ch) notes.push(`Canal "${c}" não encontrado; ignorado.`);
    else if (!channels.includes(ch.login)) {
      channels.push(ch.login);
      notes.push(ch.isLive ? `${ch.login} está ao vivo agora (${ch.category}).` : `${ch.login} está offline: vou clipar quando entrar ao vivo.`);
    }
  }
  if (plan.notSupported) notes.unshift(plan.notSupported);
  const onlyChannels = channels.length > 0 && (plan.onlyChannels || categories.length === 0);
  return {
    notes,
    session: {
      request,
      categories,
      channels,
      onlyChannels,
      language: plan.language,
      contentTypes: plan.contentTypes,
      ...(plan.minViewers !== null ? { minViewers: plan.minViewers } : {}),
      summary: plan.summary,
      createdAt: now.toISOString(),
    },
  };
};

/** The session is runnable: something to watch */
export const isRunnable = (s: ClipSession) => s.categories.length > 0 || s.channels.length > 0;
