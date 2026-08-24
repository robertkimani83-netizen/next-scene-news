// Shared Gemini script-generation logic for both pipelines (long-form
// documentaries and Shorts) — same JSON contract either way (title +
// per-segment text/location/visualQuery/rank/countryCode), just a different
// prompt/length target depending on `short`. Keeping this in one place means
// a model-list fix (like the Aug 2026 gemini-2.0/1.5 deprecation) only has
// to happen once for both pipelines.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

/** Ask Gemini for a documentary script broken into narratable sentences,
 * each paired with a short visual search phrase. Falls back across a few
 * free Gemini models the same way the VOX254 pipeline does.
 *
 * @param {string} topic
 * @param {{short?: boolean}} opts - short:true asks for a tight ~25-40s
 *   vertical-video script (single hook/fact, no full countdown) instead of
 *   the ~60-90s long-form documentary script.
 */
export async function generateScript(topic, opts = {}) {
  const { short = false } = opts;

  const prompt = short
    ? `Write a short, punchy vertical-video (YouTube Shorts) narration script (about 25-40 seconds spoken, roughly 70-110 words) on this topic: "${topic}".

Style: fast-paced, hook-first, "NEXTSCENE TV - THE FUTURE UNCOVERED" tone. Grab attention in the FIRST sentence — no throat-clearing, no "did you know", start with the surprising fact or claim itself. Short sentences, punchy delivery, one clear takeaway. End with a quick line encouraging the viewer to follow for more (not a full sentence about subscribing — keep it snappy, e.g. "Follow for more.").

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "a short punchy YouTube title, under 60 characters",
  "segments": [
    {
      "text": "one narration sentence",
      "location": "the specific country or city this sentence is about, e.g. 'Monaco' or 'Dubai, UAE' — empty string \\"\\" if the sentence doesn't name a specific place",
      "visualQuery": "2-5 word stock footage search phrase for this sentence, e.g. 'Monaco marina yachts' — if a place is named, the phrase MUST include that place's name",
      "rank": "usually null for a single-topic Short unless the topic is itself a short countdown (e.g. top 3) and this sentence reveals one entry — null otherwise",
      "countryCode": "ISO 3166-1 alpha-2 two-letter country code in lowercase matching location, e.g. 'mc' for Monaco — empty string \\"\\" if location is empty"
    }
  ]
}
Each segment.text should be ONE short sentence. Aim for 6-9 segments total (do not include a separate welcome/intro sentence — the first segment IS the hook). Every segment about a specific country MUST name that country in both "location" and "visualQuery".`
    : `Write a short documentary-style narration script (about 60-90 seconds spoken, roughly 150-220 words) on this topic: "${topic}".

Style: authoritative, cinematic, "NEXTSCENE TV - THE FUTURE UNCOVERED" tone — the kind of voice-over used in geopolitics/future-predictions YouTube videos. Short punchy sentences. No intro pleasantries, start directly with a hook.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "a short punchy YouTube title, under 70 characters",
  "segments": [
    {
      "text": "one narration sentence",
      "location": "the specific country or city this sentence is about, e.g. 'Kenya' or 'Shanghai, China' — empty string \\"\\" if the sentence doesn't name a specific place",
      "visualQuery": "2-5 word stock footage search phrase for this sentence, e.g. 'Shanghai skyline night' — if a place is named, the phrase MUST include that place's name",
      "rank": "if this topic is a numbered ranking (Top 10, etc.) and this sentence is the one revealing one specific entry, the number for that entry as it's spoken in the narration (e.g. 10, 9, ... 1, or 1, 2, ... 10 — whichever direction you're counting in) — use null for every segment if this topic isn't a numbered ranking, and null for segments (like the hook or a wrap-up line) that aren't revealing a specific ranked entry",
      "countryCode": "ISO 3166-1 alpha-2 two-letter country code in lowercase matching location, e.g. 'ke' for Kenya, 'cn' for China — empty string \\"\\" if location is empty"
    }
  ]
}
Each segment.text should be ONE sentence. Aim for 10-16 segments total. Every segment about a specific country MUST name that country in both "location" and "visualQuery" — never leave the visual generic when a real place is being discussed, since the footage needs to visibly match the country being talked about.`;

  const models = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  let lastErr;
  for (const model of models) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        }
      );
      if (!res.ok) throw new Error(`${model} responded ${res.status}`);
      const data = await res.json();
      let raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      raw = raw.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
      const parsed = JSON.parse(raw);
      if (!parsed.segments?.length) throw new Error("no segments returned");
      return parsed;
    } catch (err) {
      lastErr = err;
      console.warn(`[script] ${model} failed: ${err.message}, trying next model...`);
    }
  }
  throw new Error(`all Gemini models failed: ${lastErr?.message}`);
}

/** Deterministically rotates through a topic pool over time (no persistent
 * state needed between separate GitHub Actions runs): buckets the current
 * hour and picks pool[hourBucket % pool.length]. Runs that land in
 * different hours (which every scheduled run does, since they're spaced
 * hours apart) get different topics, cycling through the whole pool before
 * repeating — much less repetitive than picking randomly, which can and
 * does pick the same topic twice in a row. */
export function pickTopic(pool) {
  const hourBucket = Math.floor(Date.now() / 3_600_000);
  return pool[hourBucket % pool.length];
}
