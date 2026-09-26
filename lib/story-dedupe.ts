// Story-level duplicate detection.
//
// The AI rewriter phrases the same event differently every time
// ("KAA Issues Guidelines on Lost Items Following Viral JKIA Video" vs
// "KAA Issues Advisory After Viral JKIA Phone Incident Video"), so plain
// word-overlap between headlines misses most repeats. This module:
//
//   1. normalises words (plurals, -ed/-ing, Ksh/Sh amounts, synonyms),
//   2. drops generic news verbs ("issues", "clarifies", "unveils"...),
//   3. weights every word by how RARE it is across recent articles, so
//      names that appear everywhere (Ruto, Uhuru, Nairobi, 2027) count for
//      little, while specific ones (JKIA, Embu, Wandayi, Muthaiga) count a lot,
//   4. treats recurring "memes / hilarious posts" roundups as one series.
//
// Pure functions only - no Redis, no Next.js imports - so it can be unit
// tested with plain Node.

export interface StoryLike {
  headline: string;
  teaser?: string;
}

const STOP_WORDS = new Set([
  // grammar
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "as",
  "at", "by", "from", "into", "over", "after", "before", "is", "are", "was",
  "were", "be", "been", "has", "have", "had", "will", "can", "could", "would",
  "should", "may", "its", "it", "his", "her", "their", "this", "that", "these",
  "those", "who", "what", "why", "how", "when", "where", "which", "not", "no",
  "all", "out", "up", "off", "more", "most", "than", "about", "amid", "against",
  "during", "following", "ahead", "despite", "under", "within", "along", "via",
  "your", "you", "our", "we", "they", "he", "she", "them", "him", "set", "way",
  // generic newsroom verbs / fillers the rewriter reuses for every story
  "new", "fresh", "latest", "update", "report", "reports", "say", "says", "said",
  "issue", "issues", "issued", "statement", "clarify", "clarifies", "clarified",
  "reveal", "reveals", "announce", "announces", "unveil", "unveils", "urge",
  "urges", "urged", "warn", "warns", "warning", "claim", "claims", "defend",
  "defends", "react", "reacts", "respond", "responds", "demand", "demands",
  "deny", "denies", "urgent", "major", "massive", "strict", "official",
  "officials", "senior", "top", "key", "big", "brand", "multiple", "several",
  "state", "government", "kenya", "kenyan", "kenyans", "county", "national",
  "president", "leader", "leaders", "day", "week", "today", "move", "plan",
  "plans", "bid", "call", "calls", "make", "makes", "take", "takes", "get",
  "accuse", "accuses", "accused", "allege", "alleges", "slam", "slams",
  "blast", "blasts", "hit", "hits", "dismiss", "dismisses", "back", "backs",
  "right", "start", "share", "shares",
]);

// Words the rewriter swaps for one another. Map each to a canonical form.
const SYNONYMS: Record<string, string> = {
  // recurring memes roundups
  meme: "meme", memes: "meme", hilarious: "meme", humorous: "meme",
  funny: "meme", laughter: "meme", laugh: "meme", laughs: "meme",
  tweets: "meme", trending: "meme",
  // guidance-type notices
  advisory: "guidance", guideline: "guidance", guidelines: "guidance",
  directive: "guidance", directives: "guidance", regulation: "guidance",
  regulations: "guidance", rules: "guidance", procedures: "guidance",
  // events
  rally: "rally", rallies: "rally", meeting: "rally", gathering: "rally",
  chaos: "violence", arson: "violence", violence: "violence", clash: "violence",
  chaotic: "violence", unrest: "violence",
  deceased: "dead", dead: "dead", deaths: "dead", death: "dead", killed: "dead",
  bribe: "bribe", bribery: "bribe",
  arrested: "arrest", arrest: "arrest", nabbed: "arrest", nabs: "arrest",
  // spelling variants
  nino: "elnino", "niño": "elnino",
  opiyo: "wandayi",
  // two-word names: count the person once, not twice
  rigathi: "gachagua", kenyatta: "uhuru", william: "ruto", babu: "owino",
  kithure: "kindiki", johnson: "sakaja", edwin: "sifuna", ahmed: "hassan",
};

// Meaningful two-letter terms that would otherwise be dropped as too short.
const SHORT_KEEP = new Set(["ai", "dp", "cs", "ps", "mp", "un", "uk", "dr"]);

function stem(word: string): string {
  if (word.length <= 4 || /^\d/.test(word)) return word;
  if (word.endsWith("ies") && word.length > 5) return word.slice(0, -3) + "y";
  if (word.endsWith("ing") && word.length > 6) return word.slice(0, -3);
  if (word.endsWith("ed") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("es") && word.length > 5) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function storyTokens(text: string): string[] {
  const cleaned = (text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    // "Ksh100,000" / "Sh 100,000" / "KSh2.7B" -> the number itself
    .replace(/\b(?:k?sh|kes)\s*(?=\d)/g, "")
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ");

  const out = new Set<string>();
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw) continue;
    if (raw.length < 3 && !/^\d+$/.test(raw) && !SHORT_KEEP.has(raw)) continue;
    if (STOP_WORDS.has(raw)) continue;
    const syn = SYNONYMS[raw];
    const token = syn ?? stem(raw);
    if (STOP_WORDS.has(token)) continue;
    out.add(token);
  }
  // A lone year ("2027") says nothing about which story it is.
  for (const t of Array.from(out)) if (/^20\d\d$/.test(t)) out.delete(t);
  return Array.from(out);
}

export function isMemeRoundup(story: StoryLike): boolean {
  return storyTokens(story.headline).includes("meme") ||
    /monday blues|memes?\b/i.test(story.headline);
}

export class StoryMatcher {
  private df = new Map<string, number>();
  private n: number;

  // Build IDF weights from the current article pool (headlines + teasers).
  constructor(corpus: StoryLike[]) {
    this.n = Math.max(corpus.length, 1);
    for (const story of corpus) {
      for (const t of new Set(storyTokens(story.headline))) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
  }

  private isRare(token: string): boolean {
    return (this.df.get(token) ?? 0) <= Math.max(4, Math.ceil(this.n * 0.02));
  }

  private weight(token: string): number {
    const df = this.df.get(token) ?? 0;
    return Math.log((this.n + 1) / (df + 1)) + 1;
  }

  /** 0..1 - how much of the smaller story's rare-word weight is shared. */
  headlineSimilarity(a: string, b: string): { score: number; shared: string[] } {
    const A = storyTokens(a);
    const B = new Set(storyTokens(b));
    if (!A.length || !B.size) return { score: 0, shared: [] };

    const shared = A.filter((t) => B.has(t));
    const wShared = shared.reduce((s, t) => s + this.weight(t), 0);
    const wA = A.reduce((s, t) => s + this.weight(t), 0);
    const wB = Array.from(B).reduce((s, t) => s + this.weight(t), 0);
    return { score: wShared / Math.min(wA, wB), shared };
  }

  isSameStory(a: StoryLike, b: StoryLike): boolean {
    // Daily memes roundups are one recurring series, not separate news.
    if (isMemeRoundup(a) && isMemeRoundup(b)) return true;

    const h = this.headlineSimilarity(a.headline, b.headline);
    // At least one shared word must be specific to a handful of stories
    // (a place, a less-common name, an amount) - sharing only "Ruto" and
    // "Uhuru" is not the same story.
    const hasAnchor = h.shared.some((t) => this.isRare(t));
    if (hasAnchor && h.shared.length >= 2 && h.score >= 0.45) return true;

    // Teasers carry the specifics (names, places, amounts) the headline
    // sometimes drops - use them as a second, stricter signal.
    if (a.teaser && b.teaser && hasAnchor) {
      const t = this.headlineSimilarity(
        `${a.headline} ${a.teaser}`,
        `${b.headline} ${b.teaser}`,
      );
      if (t.shared.length >= 4 && t.score >= 0.45) return true;
    }
    return false;
  }
}
