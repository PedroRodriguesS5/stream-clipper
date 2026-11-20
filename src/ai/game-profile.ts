/**
 * Per-game SEO vocabulary. Every hashtag, search phrase and title keyword comes from here,
 * so a GTA RP or VALORANT clip never gets GTA 6 tags (the gate blocks wrong-game metadata).
 */
export interface GameProfile {
  /** How viewers write the game in titles/searches ("GTA 6") */
  keyword: string;
  /** Hashtag-safe slug of the keyword ("gta6") */
  slug: string;
  /** Broad discovery tags, most important first ("#gta6", "#gtavi") */
  broadTags: string[];
  /** Brazilian niche tags ("#gta6brasil") */
  nicheTags: string[];
  /** Extra spellings people search, used in the hidden YouTube tags field */
  searchAliases: string[];
  /** Places/characters worth naming in prompts (GTA 6 only for now) */
  lore: string[];
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

export const gameKeyword = (game: string): string =>
  /grand theft auto vi\b/i.test(game) ? 'GTA 6' : /grand theft auto v\b/i.test(game) ? 'GTA RP' : game;

export const gameProfile = (game: string): GameProfile => {
  const keyword = gameKeyword(game);
  const slug = slugify(keyword) || 'gameplay';
  if (keyword === 'GTA 6') {
    return {
      keyword,
      slug,
      broadTags: ['#gta6', '#gtavi'],
      nicheTags: ['#gta6brasil', '#gta6gameplay'],
      searchAliases: ['gta 6', 'gta6', 'gta vi', 'grand theft auto vi'],
      lore: ['Vice City', 'Leonida', 'Jason', 'Lucia'],
    };
  }
  if (keyword === 'GTA RP') {
    return {
      keyword,
      slug,
      broadTags: ['#gtarp', '#gta5'],
      nicheTags: ['#gtarpbrasil', '#gtarpcortes'],
      searchAliases: ['gta rp', 'gtarp', 'gta 5 rp', 'gta v roleplay'],
      lore: [],
    };
  }
  return {
    keyword,
    slug,
    broadTags: [`#${slug}`],
    nicheTags: [`#${slug}brasil`, `#${slug}clips`],
    searchAliases: [keyword.toLowerCase()],
    lore: [],
  };
};
