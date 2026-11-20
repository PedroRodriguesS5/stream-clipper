/** Portuguese swear words checked in titles/captions/descriptions (advertiser-friendly rules) */
export const PROFANITY =
  /\b(caralho|porra|puta|pqp|fdp|foda|fod[ea]r|merda|cu|buceta|viado|vagabund[ao]|arrombad[ao]|desgraça|cacete|krl|crl|vsf|vtnc|tnc)\b/i;

/** Wider list for burned-in subtitles: streamers and English game dialogue both swear */
const SUBTITLE_PROFANITY =
  /(?<![\p{L}\p{N}])(caralho|porra|puta|pqp|fdp|foda\w*|fod[ei]\w*|merda|cu|cuz[ãa]o|buceta|viado|vagabund[ao]|arrombad[ao]|desgraça\w*|cacete|pica|piroca|bosta|krl|crl|vsf|vtnc|tnc|fuck\w*|shit\w*|bitch\w*|asshole|motherfuck\w*|dick|pussy|cunt|nigg\w*)(?![\p{L}\p{N}])/giu;

/**
 * One letter hidden, like Brazilian cortes channels do: "foda" -> "f*da", "porra" -> "p*rra",
 * "fuck" -> "f*ck". Viewers still read it; the exact word is gone for text/OCR checks.
 * The first vowel after the first letter becomes "*" (the middle letter if there is no vowel: "krl" -> "k*l").
 */
export const maskProfanity = (text: string): string =>
  text.replace(SUBTITLE_PROFANITY, (w) => {
    if (w.length <= 2) return `${w[0]}*`;
    const chars = [...w];
    const v = chars.findIndex((c, i) => i > 0 && /[aeiouáéíóúâêôãõà]/i.test(c));
    chars[v > 0 ? v : Math.floor(chars.length / 2)] = '*';
    return chars.join('');
  });
