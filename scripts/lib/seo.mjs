// Small shared helpers for turning Gemini's per-video `keywords` output (see
// script-gen.mjs) into YouTube tags and description hashtags that actually
// reflect what a specific video covers, instead of the same fixed boilerplate
// on every single upload. Two reasons this matters: it's better search SEO
// (real keywords beat generic ones), and it reduces how identical every
// upload looks to YouTube's "inauthentic content" review — a channel where
// every description is a copy-paste of the last one reads as templated.

/** Turns "artificial intelligence" into "#ArtificialIntelligence". Drops
 * anything that isn't a letter/number/space before camel-casing, so stray
 * punctuation from a Gemini keyword never breaks the tag. */
function toHashtag(phrase) {
  const clean = String(phrase ?? "").replace(/[^a-zA-Z0-9 ]/g, "").trim();
  if (!clean) return null;
  const camel = clean
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  return camel ? `#${camel}` : null;
}

/**
 * @param {string[]} keywords - per-video keywords from Gemini (may be empty/missing)
 * @param {string[]} baseHashtags - always-included channel hashtags, e.g. ["#geopolitics", "#top10"]
 * @param {number} max - cap on total hashtags returned
 * @returns {string[]}
 */
export function buildHashtags(keywords = [], baseHashtags = [], max = 8) {
  const fromKeywords = (keywords || []).map(toHashtag).filter(Boolean);
  const all = [...baseHashtags, ...fromKeywords];
  return [...new Set(all)].slice(0, max);
}

/**
 * @param {string[]} keywords - per-video keywords from Gemini
 * @param {string[]} places - country/city names actually mentioned in the script
 * @param {string[]} baseTags - always-included channel tags
 * @param {number} max - YouTube allows up to ~500 total tag characters; keeping the
 *   count modest avoids ever bumping into that
 */
export function buildTags(keywords = [], places = [], baseTags = [], max = 15) {
  const all = [...baseTags, ...(keywords || []), ...(places || [])]
    .map((t) => String(t ?? "").trim())
    .filter(Boolean);
  return [...new Set(all)].slice(0, max);
}
