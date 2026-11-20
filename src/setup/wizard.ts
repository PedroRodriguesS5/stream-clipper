import { createInterface } from 'readline/promises';
import { stdin, stdout } from 'process';
import { config } from '../utils/config.js';
import { interpretRequest, DraftPlan } from './interpret.js';
import { loadPreferences, memorySummary, performanceByGame, rankSuggestions, remember, savePreferences, Suggestion } from './preferences.js';
import { applySession, ClipSession, loadSession, MOMENT_LABELS, saveSession } from './session.js';
import { liveCount, resolveCategory, resolveChannel, trendingCategories } from './twitch-lookup.js';
import { isRunnable, validatePlan } from './validate.js';

/**
 * Startup wizard (`npm start` in a terminal, or `npm run setup`): asks what to clip,
 * suggests games, turns the answer into a plan with AI, confirms, then remembers the choice.
 * Unattended runs (no terminal) skip it and reuse data/session.json.
 */

const color = !process.env.NO_COLOR && stdout.isTTY;
const c = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c('1');
const dim = c('2');
const cyan = c('36');
const green = c('32');
const yellow = c('33');

export const shouldRunWizard = (argv = process.argv) =>
  stdin.isTTY && stdout.isTTY && !argv.includes('--no-setup') && process.env.SETUP !== 'off';

const describe = (s: ClipSession) => {
  const what = s.onlyChannels
    ? `só os canais ${s.channels.join(', ')}`
    : [s.categories.join(', '), s.channels.length ? `+ canais ${s.channels.join(', ')}` : ''].filter(Boolean).join(' ');
  const content = s.contentTypes.length ? s.contentTypes.map((t) => MOMENT_LABELS[t]).join('; ') : 'qualquer momento bom';
  return { what, content };
};

const printPlan = async (s: ClipSession, notes: string[]) => {
  const { what, content } = describe(s);
  const minViewers = s.minViewers ?? config.minViewers;
  const live = s.onlyChannels ? null : await liveCount(s.language, s.categories, minViewers);
  console.log('');
  console.log(bold('  Plano'));
  if (s.summary) console.log(`  ${cyan(s.summary)}`);
  console.log(`  ${dim('O quê:')}     ${what}`);
  console.log(`  ${dim('Conteúdo:')}  ${content}`);
  console.log(`  ${dim('Idioma:')}    ${s.language}   ${dim('Mín. espectadores:')} ${minViewers}`);
  if (live !== null) console.log(`  ${dim('Agora:')}     ${live ? green(`${live} lives ao vivo combinam`) : yellow('nenhuma live combina agora (vou esperar e checar a cada 5 min)')}`);
  if (live === 0 && minViewers > 100) console.log(dim(`  Dica: responda "canais pequenos" para aceitar lives com menos de ${minViewers} espectadores.`));
  for (const n of notes) console.log(`  ${yellow('•')} ${n}`);
  console.log('');
};

export const runWizard = async (): Promise<ClipSession | null> => {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const [prefs, last, performance, trending] = await Promise.all([
      loadPreferences(),
      loadSession(),
      performanceByGame(),
      trendingCategories(config.streamLanguage).catch(() => []),
    ]);
    const suggestions: Suggestion[] = rankSuggestions(prefs, trending, performance);

    console.log('');
    console.log(bold('  🎬 Stream Clipper') + dim('  —  o que vamos clipar hoje?'));
    console.log('');
    suggestions.forEach((s, i) => console.log(`  ${cyan(String(i + 1).padStart(2))}) ${bold(s.category)}  ${dim(s.reasons.join(' · '))}`));
    if (!suggestions.length) console.log(dim('  (sem sugestões: Twitch indisponível e nenhum histórico ainda)'));
    console.log('');
    if (last) console.log(`  ${dim('Enter')} = repetir a última: ${describe(last).what} (${describe(last).content})`);
    console.log(`  Digite um ${bold('número')}, ou descreva com suas palavras, por exemplo:`);
    console.log(dim('    "fails engraçados de minecraft"   "só as lives do cellbit"   twitch.tv/alanzoka   "o de sempre"'));
    console.log('');

    let answer = (await rl.question(bold('  > '))).trim();
    if (!answer && last) {
      applySession(last);
      console.log(green(`  ✓ Repetindo: ${describe(last).what}`));
      return last;
    }
    if (!answer) answer = suggestions[0]?.category || config.targetCategory;
    const pick = Number(answer);
    if (Number.isInteger(pick) && pick >= 1 && pick <= suggestions.length) answer = suggestions[pick - 1].category;

    let previous: DraftPlan | undefined;
    let request = answer;
    for (let round = 0; round < 6; round++) {
      console.log(dim('  Entendendo o pedido...'));
      const { plan, via } = await interpretRequest(request, {
        language: config.streamLanguage,
        trending: suggestions.map((s) => s.category),
        memory: memorySummary(prefs),
        previous,
      });
      const { session, notes } = await validatePlan(plan, previous ? `${previous.summary || answer}; ${request}` : request, {
        category: resolveCategory,
        channel: resolveChannel,
      });
      if (via === 'heuristic') notes.push('IA indisponível: plano montado por palavras-chave.');
      if (!isRunnable(session)) {
        console.log(yellow(`  Não encontrei nenhum jogo ou canal nisso. ${notes.join(' ')}`));
        request = (await rl.question(bold('  Tente de novo > '))).trim() || suggestions[0]?.category || config.targetCategory;
        previous = undefined;
        continue;
      }
      await printPlan(session, notes);
      const ok = (await rl.question(`  ${bold('Confirmar?')} ${dim('[S/n, ou digite um ajuste, ex.: "só canais pequenos", "inclua valorant"]')} `)).trim();
      if (!ok || /^(s|sim|y|yes|ok)$/i.test(ok)) {
        await saveSession(session);
        await savePreferences(remember(prefs, session));
        applySession(session);
        console.log(green('  ✓ Salvo. Começando...\n'));
        return session;
      }
      if (/^(n|n[ãa]o|no)$/i.test(ok)) {
        request = (await rl.question(bold('  O que você quer clipar? > '))).trim();
        previous = undefined;
        continue;
      }
      previous = plan;
      request = ok;
    }
    console.log(yellow('  Muitas tentativas; usando a configuração do .env.'));
    return null;
  } finally {
    rl.close();
  }
};

/** For unattended runs: reuse the last confirmed session, if any */
export const applySavedSession = async (): Promise<ClipSession | null> => {
  const s = await loadSession();
  if (s && isRunnable(s)) applySession(s);
  return s;
};
