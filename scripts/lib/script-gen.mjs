// Shared Gemini script-generation logic for both pipelines (long-form
// documentaries and Shorts) — same JSON contract either way (title +
// per-segment text/location/visualQuery/rank/countryCode), just a different
// prompt/length target depending on `short`. Keeping this in one place means
// a model-list fix (like the Aug 2026 gemini-2.0/1.5 deprecation) only has
// to happen once for both pipelines.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Sept 16 2026: added as part of the NEXTSCENE channel-upgrade brief —
// every topic (long-form or Short) now names which content pillar it
// belongs to, and this guidance gets folded into the script prompt so the
// SAME topic idea is written differently depending on its pillar (a Strange
// Borders piece leans on verified geography, a Future 2035 piece has to
// label speculation, etc.) instead of every video getting one generic
// treatment. Callers that don't pass a pillar (or pass one not listed here)
// fall back to the Hidden World guidance, which is the safest default (it's
// also the pillar real channel analytics show performs best).
const PILLAR_GUIDANCE = {
  "Hidden World":
    `This is a HIDDEN WORLD story — a strange place, hidden location, unusual city, remote territory, geographic anomaly, or place with unusual rules that most people have never heard of. The viewer should finish thinking "I didn't know that existed." This is the channel's strongest-performing pillar on real analytics, so lean all the way into genuine surprise rather than playing it safe.`,
  "You Didn't Know":
    `This is a YOU DIDN'T KNOW story — reveal ONE specific surprising fact and build the whole script around it: fact, then explanation, then a twist that makes it land harder. The viewer should finish thinking "wait, how did I not know that?"`,
  "Strange Borders":
    `This is a STRANGE BORDERS story — an international border, enclave/exclave, a town or building split by a border, a road that crosses borders oddly, or another territorial anomaly. Every specific geographic or border claim must be something broadly reported and well-established — if you are not confident a claim is accurate, drop it or soften it to something you ARE sure of rather than guessing at specifics.`,
  "Future 2035":
    `This is a FUTURE 2035 story — future technology, AI, future cities, transportation, energy, infrastructure, automation, space, or climate-driven change. This is the one pillar where labeling matters more than anywhere else on the channel: for every forward-looking claim, the sentence itself must make clear whether it is already happening (say so plainly, e.g. "is already running in..."), currently under development (e.g. "is being built/tested right now"), or a prediction/possibility (e.g. "could happen within a decade" / "some experts predict"). Never phrase a prediction as if it were settled fact.`,
  "World Power":
    `This is a WORLD POWER story — a trade route, resource, strategic location, port, canal, chokepoint, or piece of global infrastructure/supply chain. Avoid sensational claims ("could destroy the economy!") — instead explain WHY this specifically matters using real reasoning (who depends on it, what breaks if it's disrupted, who benefits), the way an evidence-led analyst would, not a doom-clickbait channel.`,
};

const DEFAULT_PILLAR = "Hidden World";

function pillarGuidance(pillar) {
  return PILLAR_GUIDANCE[pillar] ?? PILLAR_GUIDANCE[DEFAULT_PILLAR];
}

// Sept 16 2026: the HOOK -> MYSTERY -> EXPLAIN -> ESCALATE -> PAYOFF beat
// structure from the channel-upgrade brief, folded into both prompts below
// as explicit per-beat guidance mapped onto the existing segment count,
// rather than a separate pipeline stage — Gemini already writes the whole
// script in one call, so the structure has to live inside that one prompt.
const BEAT_STRUCTURE = `Structure the segments like a tiny documentary building to a twist, NOT a flat list of facts:
- HOOK (segment 1): the single most interesting statement, stated directly. Never open with "today we're going to...", "did you know...", or any throat-clearing — start with the surprising fact or claim itself.
- MYSTERY (next 1-2 segments): describe the place/object/event just enough to make the viewer ask "how?" or "why?" — don't fully answer yet.
- EXPLAIN (the middle segments): give the real explanation in short, punchy sentences, one idea per sentence.
- ESCALATE (one segment near the end): introduce a genuinely surprising twist or bigger stakes than the viewer expected. Open it with a short transition in the spirit of "But here's the strange part...", "And it gets stranger...", "Here's what most people miss...", or "There's more to this story..." — vary the exact phrasing video to video, never reuse the same transition every time.
- PAYOFF (the final segment): the single strongest closing fact or twist. This must be the last thing said before the video ends, so make it land — do NOT end on a call-to-action or sign-off line (no "follow for more", no "subscribe"); that closing beat is added separately in code, not written by you.`;

/** Ask Gemini for a documentary script broken into narratable sentences,
 * each paired with a short visual search phrase. Falls back across a few
 * free Gemini models the same way the VOX254 pipeline does.
 *
 * @param {string} topic
 * @param {{short?: boolean, pillar?: string}} opts - short:true asks for a
 *   tight ~25-40s vertical-video script (single hook/fact, no full
 *   countdown) instead of the ~60-90s long-form documentary script.
 *   pillar: one of the PILLAR_GUIDANCE keys above (defaults to "Hidden
 *   World" if omitted or unrecognized) — shapes HOW the topic is written,
 *   not just its length.
 */
export async function generateScript(topic, opts = {}) {
  const { short = false, pillar } = opts;
  const guidance = pillarGuidance(pillar);

  const prompt = short
    ? `Write a short, punchy vertical-video (YouTube Shorts) narration script (about 25-40 seconds spoken, roughly 70-110 words) on this topic: "${topic}".

${guidance}

${BEAT_STRUCTURE}

Style: fast-paced, "NEXTSCENE - THE FUTURE UNCOVERED" tone — a small discovery/documentary brand, not a generic facts channel. Short sentences, punchy delivery, one clear takeaway per sentence.

Accuracy: only state facts, figures and rankings you're genuinely confident are well-established and broadly reported — round or approximate a number rather than invent a precise-sounding one you're not sure of. This audience is quick to call out channels in the comments for numbers that seem made up, so a vague-but-true claim beats a specific-but-shaky one.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "a scroll-stopping YouTube title, under 60 characters. Avoid plain, generic ranking phrasing like 'Top 10 Richest Countries in Asia' — lead with a curiosity gap or a surprising claim that makes someone need to know the answer, e.g. in the spirit of (write NEW titles, never reuse these) 'The Border That Runs Through a House', 'The City Nobody Can Easily Reach', 'Why This Tiny Island Matters'. Stay accurate to the real content — a stronger hook on the same facts, not clickbait that misleads.",
  "segments": [
    {
      "text": "one narration sentence",
      "location": "the specific country or city this sentence is about, e.g. 'Monaco' or 'Dubai, UAE' — empty string \\"\\" if the sentence doesn't name a specific place",
      "visualQuery": "2-5 word stock footage search phrase for this sentence, e.g. 'Monaco marina yachts' — if a place is named, the phrase MUST include that place's name",
      "rank": "usually null for a single-topic Short unless the topic is itself a short countdown (e.g. top 3) and this sentence reveals one entry — null otherwise",
      "countryCode": "ISO 3166-1 alpha-2 two-letter country code in lowercase matching location, e.g. 'mc' for Monaco — empty string \\"\\" if location is empty"
    }
  ],
  "commentary": "ONE extra sentence giving a genuine analytical take or 'here's why this matters' perspective on the topic — not just another fact, an actual point of view. Vary how you open this from video to video (don't default to the same phrase like 'What this shows is' every time) so the channel doesn't read as templated. Must be exactly one sentence — no semicolons or periods splitting it into two.",
  "keywords": ["6-10 short SEO keywords/phrases specific to what THIS video actually covers — real country names, technologies, or themes mentioned, not generic filler"]
}
Each segment.text should be ONE short sentence. Aim for 6-9 segments total (do not include a separate welcome/intro sentence — the first segment IS the hook). Every segment about a specific country MUST name that country in both "location" and "visualQuery".`
    : `Write a short documentary-style narration script (about 60-90 seconds spoken, roughly 150-220 words) on this topic: "${topic}".

${guidance}

${BEAT_STRUCTURE}
(For a long-form script, spread EXPLAIN across several segments/examples rather than just one or two — this format has room for it.)

Style: authoritative, cinematic, "NEXTSCENE - THE FUTURE UNCOVERED" tone — the kind of voice-over used in a short discovery documentary, not a generic facts-list channel. Short punchy sentences. No intro pleasantries.

Accuracy: only state facts, figures and rankings you're genuinely confident are well-established and broadly reported — round or approximate a number rather than invent a precise-sounding one you're not sure of. This audience is quick to call out channels in the comments for numbers that seem made up or unsourced, so a vague-but-true claim beats a specific-but-shaky one.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "a scroll-stopping YouTube title, under 70 characters. Avoid plain, generic ranking phrasing like 'Top 10 Richest Countries in Africa' — lead with a curiosity gap, a surprising claim, or a superlative that makes someone need to know the answer, e.g. in the spirit of (write NEW titles, never reuse these) 'The Ranking That Will Surprise You', 'These Countries Are About To Change Everything', 'Why Nobody Saw This Coming'. Stay accurate to the real content — a stronger hook on the same facts, not clickbait that misleads.",
  "segments": [
    {
      "text": "one narration sentence",
      "location": "the specific country or city this sentence is about, e.g. 'Kenya' or 'Shanghai, China' — empty string \\"\\" if the sentence doesn't name a specific place",
      "visualQuery": "2-5 word stock footage search phrase for this sentence, e.g. 'Shanghai skyline night' — if a place is named, the phrase MUST include that place's name",
      "rank": "if this topic is a numbered ranking (Top 10, etc.) and this sentence is the one revealing one specific entry, the number for that entry as it's spoken in the narration (e.g. 10, 9, ... 1, or 1, 2, ... 10 — whichever direction you're counting in) — use null for every segment if this topic isn't a numbered ranking, and null for segments (like the hook or a wrap-up line) that aren't revealing a specific ranked entry",
      "countryCode": "ISO 3166-1 alpha-2 two-letter country code in lowercase matching location, e.g. 'ke' for Kenya, 'cn' for China — empty string \\"\\" if location is empty"
    }
  ],
  "commentary": "ONE extra sentence giving a genuine analytical take or 'here's why this matters' perspective tying the ranking together — not just another fact, an actual point of view a human analyst would add. Vary how you open this from video to video (don't default to the same phrase like 'What this reveals is' every time) so the channel doesn't read as templated. Must be exactly one sentence — no semicolons or periods splitting it into two.",
  "keywords": ["6-10 short SEO keywords/phrases specific to what THIS video actually covers — real country names, technologies, or themes mentioned, not generic filler"]
}
Each segment.text should be ONE sentence. Aim for 10-16 segments total. Every segment about a specific country MUST name that country in both "location" and "visualQuery" — never leave the visual generic when a real place is being discussed, since the footage needs to visibly match the country being talked about.`;

  const models = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

  // Sept 10 2026: real production runs showed every model in one pass
  // failing back-to-back with transient "503 overloaded" responses (or,
  // occasionally, one model handing back truncated/malformed JSON) — a
  // one-off blip on Gemini's free tier, not a real outage, but with only a
  // single pass through the model list that blip wasted an entire
  // scheduled upload slot. Retrying the WHOLE list up to 3 times with a
  // short, increasing delay between passes rides out that kind of transient
  // failure almost every time, for the cost of at most ~15s of extra
  // runtime on the rare pass that needs it.
  const MAX_PASSES = 3;
  let lastErr;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
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
        console.warn(`[script] ${model} failed (pass ${pass}/${MAX_PASSES}): ${err.message}, trying next model...`);
      }
    }
    if (pass < MAX_PASSES) {
      const delayMs = 5000 * pass; // 5s, then 10s
      console.warn(`[script] all models failed on pass ${pass}/${MAX_PASSES} — waiting ${delayMs / 1000}s before retrying the full list...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`all Gemini models failed after ${MAX_PASSES} passes: ${lastErr?.message}`);
}

/** Generates a "Guess the Country" challenge script: a few cryptic clues
 * that never name the country, a countdown, then a reveal. Used by
 * generate-short.mjs for its recurring "Guess the Country" series — a
 * structurally different Short (clue segments shown over a generic mystery
 * card instead of real footage, so no stock photo can accidentally give the
 * answer away, then a 3-2-1 countdown, then the real flag/footage reveal)
 * rather than just a different topic on the usual single-fact format.
 *
 * The caller (generate-short.mjs) turns the returned {title, clues, reveal,
 * commentary, keywords} into the same {title, segments, commentary,
 * keywords} shape generateScript() returns, so every step downstream of
 * script generation (TTS, captions, ffmpeg build, upload) needs no
 * guess-format-specific handling beyond how each segment's *visual* gets
 * built.
 *
 * @param {string} country - the answer, e.g. "Madagascar" (never leaked into
 *   the prompt's OWN generated title/clues — only used so Gemini knows what
 *   to actually write clues about and what the reveal line must name).
 */
export async function generateGuessScript(country) {
  const prompt = `You are writing a "Guess the Country" YouTube Shorts challenge. The answer is: ${country}. Do not reveal this anywhere except the "reveal" field below.

Write:
- 3 short spoken clue sentences about ${country}, ordered from vague to specific, each one ONE sentence. Rules for the clues: NEVER state the country's name, its capital city's name, or describe its flag. Use only well-known, broadly accurate facts (geography, economy, culture, history) confident enough that nobody will call them out as wrong in the comments — round or approximate rather than invent a precise-sounding number you're not sure of.
- One short, punchy title for the challenge itself, under 60 characters, that creates curiosity but does NOT name ${country} and does not make the answer obvious from the title alone (e.g. in the spirit of "Can You Guess This Mystery Nation?", "Only 1% Can Guess This Country", "3 Clues. 1 Country. Can You Get It?" — write a NEW one, never reuse these).
- One short, punchy spoken reveal sentence that DOES explicitly name ${country}, e.g. "It's ${country}!" or a slightly more natural variant.
- One extra sentence (spoken after the reveal) giving one more genuinely interesting fact about ${country} — not a repeat of the clues.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "the challenge title, never naming ${country}",
  "clues": ["clue 1", "clue 2", "clue 3"],
  "reveal": "the spoken reveal sentence, must name ${country}",
  "commentary": "one extra spoken fact about ${country} after the reveal",
  "keywords": ["6-10 short SEO keywords/phrases specific to ${country} and this challenge"]
}`;

  const models = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  const MAX_PASSES = 3;
  let lastErr;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
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
        if (!parsed.clues?.length || !parsed.reveal) throw new Error("missing clues or reveal");
        // Safety net: if the model slipped and named the country inside a
        // clue or the title anyway, this run's clue-writing failed at its
        // one job — fail loudly rather than upload a "guess" video that
        // gives the answer away in clue 1.
        const lowerCountry = country.toLowerCase();
        const leaked = [parsed.title, ...parsed.clues].some((s) => s.toLowerCase().includes(lowerCountry));
        if (leaked) throw new Error(`clue or title leaked the answer ("${country}")`);
        return parsed;
      } catch (err) {
        lastErr = err;
        console.warn(`[script] guess-format ${model} failed (pass ${pass}/${MAX_PASSES}): ${err.message}, trying next model...`);
      }
    }
    if (pass < MAX_PASSES) {
      const delayMs = 5000 * pass;
      console.warn(`[script] all models failed on pass ${pass}/${MAX_PASSES} — waiting ${delayMs / 1000}s before retrying the full list...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`all Gemini models failed to write a clean guess-format script after ${MAX_PASSES} passes: ${lastErr?.message}`);
}

/** Generates a "Map Challenge" script: clues written to accompany a real map
 * graphic that zooms progressively closer on the answer country (see
 * lib/map-challenge.mjs), rather than "Guess the Country"'s flat mystery
 * card. Structurally similar to generateGuessScript (same leak-safety
 * check, same {title, clues, reveal, commentary, keywords} shape) but the
 * framing is different: the video's hook IS the zooming map, so the title
 * references watching the map/globe rather than pure trivia, and clues can
 * lean on geography (terrain, neighbors, size, climate) since the visual
 * itself is already a geography puzzle — mixing in an economy/culture fact
 * is fine too, just never anything that would also make sense as a caption
 * under the actual highlighted shape (e.g. never describe the country's
 * outline/shape itself, since the map is already showing it).
 *
 * @param {string} country - the answer, e.g. "Mongolia" (never leaked into
 *   the prompt's own generated title/clues — only used so Gemini knows what
 *   to write clues about and what the reveal line must name).
 */
export async function generateMapClueScript(country) {
  const prompt = `You are writing a "Map Challenge" YouTube Shorts video. A real, accurate zoomed-in world map is the main visual — it starts showing a wide region and zooms progressively closer on one highlighted (but unlabeled) country across the video, and the viewer has to name it before the final full reveal. The answer is: ${country}. Do not reveal this anywhere except the "reveal" field below.

Write:
- 3 short spoken clue sentences about ${country}, ordered from vague to specific, each one ONE sentence. Rules for the clues: NEVER state the country's name, its capital city's name, describe its flag, or describe the shape/outline of its borders (the map is already showing the shape — don't narrate it). Lean on genuinely well-known geography (region, neighboring countries or seas, terrain, climate, size comparisons) mixed with a little economy/culture/history if useful — confident, broadly-reported facts only, round or approximate rather than invent a precise-sounding number you're not sure of.
- One short, punchy title for the challenge itself, under 60 characters, that references watching the map/globe zoom in and creates curiosity but does NOT name ${country} and does not make the answer obvious from the title alone (e.g. in the spirit of "Can You Name This Country Before The Map Zooms In?", "Guess The Country On The Map", "The Globe Is Zooming In — Do You Know Where?" — write a NEW one, never reuse these).
- One short, punchy spoken reveal sentence that DOES explicitly name ${country}, e.g. "It's ${country}!" or a slightly more natural variant.
- One extra sentence (spoken after the reveal) giving one more genuinely interesting fact about ${country} — not a repeat of the clues.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "the challenge title, never naming ${country}",
  "clues": ["clue 1", "clue 2", "clue 3"],
  "reveal": "the spoken reveal sentence, must name ${country}",
  "commentary": "one extra spoken fact about ${country} after the reveal",
  "keywords": ["6-10 short SEO keywords/phrases specific to ${country} and this challenge"]
}`;

  const models = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
  const MAX_PASSES = 3;
  let lastErr;
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
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
        if (!parsed.clues?.length || !parsed.reveal) throw new Error("missing clues or reveal");
        // Same safety net as generateGuessScript: fail loudly rather than
        // upload a "map challenge" video whose own clue text gives away the
        // answer the map is trying to make you guess.
        const lowerCountry = country.toLowerCase();
        const leaked = [parsed.title, ...parsed.clues].some((s) => s.toLowerCase().includes(lowerCountry));
        if (leaked) throw new Error(`clue or title leaked the answer ("${country}")`);
        return parsed;
      } catch (err) {
        lastErr = err;
        console.warn(`[script] map-challenge ${model} failed (pass ${pass}/${MAX_PASSES}): ${err.message}, trying next model...`);
      }
    }
    if (pass < MAX_PASSES) {
      const delayMs = 5000 * pass;
      console.warn(`[script] all models failed on pass ${pass}/${MAX_PASSES} — waiting ${delayMs / 1000}s before retrying the full list...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`all Gemini models failed to write a clean map-challenge script after ${MAX_PASSES} passes: ${lastErr?.message}`);
}

// Topic selection now lives in lib/topic-history.mjs (pickAndRecordTopic) —
// a persistent least-recently-used picker that survives across separate
// GitHub Actions runs, rather than the clock-hour rotation this file used
// to do. The hour-based approach worked for evenly-spaced schedules but had
// a real gap: two runs landing in the same UTC hour (e.g. a manual test run
// alongside a scheduled one) would compute the same bucket and pick the
// exact same topic. See topic-history.mjs for the replacement.

// Sept 16 2026: the channel-upgrade brief calls for fact-checking every
// claim before publish. There's no human review gate on scheduled runs (by
// design — see the README), so this can't be a blocking "stop and wait for
// a person" gate. Instead it's a second, cheap Gemini pass that re-reads the
// ALREADY-WRITTEN narration sentences and only rewrites the ones it isn't
// confident are broadly well-established, softening them (e.g. a precise
// unverified number -> "some of the highest in the region") rather than
// deleting them outright. Best-effort like everything else that touches an
// external API in this codebase: any failure here (network, bad JSON, a
// model outage) just returns the ORIGINAL sentences unchanged and logs a
// warning — a run should never fail because the fact-check pass itself
// broke, that would make accuracy tooling less reliable than having none.
const FACT_CHECK_MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];

/**
 * Re-reads a script's narration sentences and returns a possibly-revised
 * copy, softening any sentence the model isn't confident is broadly
 * well-established (rather than inventing corrections it can't verify
 * either — this is a confidence/hedging pass, not a live web fact-checker).
 *
 * @param {string[]} sentences - the narration text of each segment, in order
 * @param {string} topic - the video's topic, for context only
 * @returns {Promise<{sentences: string[], flaggedIndices: number[]}>} same
 *   length/order as the input; flaggedIndices lists which ones were changed
 *   (empty array if the model found nothing to soften, OR if the pass
 *   failed and the input was returned unchanged — check the warning log to
 *   tell those two cases apart).
 */
export async function reviewScriptClaims(sentences, topic) {
  if (!sentences?.length) return { sentences: sentences ?? [], flaggedIndices: [] };

  const numbered = sentences.map((s, i) => `${i}: ${s}`).join("\n");
  const prompt = `You are fact-checking narration sentences for a short YouTube documentary about: "${topic}".

Here are the sentences, one per line, each prefixed with its index number:
${numbered}

For each sentence, decide if it states a specific fact, figure, ranking or claim you are NOT confident is broadly well-established and widely reported (a vague or rounded claim is fine — the concern is anything oddly precise, obscure, or that could be wrong). If a sentence is fine as-is, leave it out of your response entirely.

For any sentence you flag, rewrite it to be something you ARE confident is accurate — usually by rounding a number, softening a superlative ("one of the..." instead of "the..."), or removing the specific unverifiable detail while keeping the sentence's point and roughly its length and tone. Never invent a different specific fact to replace it with.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "revisions": [
    { "index": 0, "revisedText": "the corrected sentence", "reason": "short reason, e.g. 'unverifiable precise figure'" }
  ]
}
Return an empty "revisions" array if every sentence is already fine.`;

  for (const model of FACT_CHECK_MODELS) {
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
      const revisions = Array.isArray(parsed.revisions) ? parsed.revisions : [];

      const revised = [...sentences];
      const flaggedIndices = [];
      for (const rev of revisions) {
        const idx = rev?.index;
        if (typeof idx === "number" && idx >= 0 && idx < revised.length && typeof rev.revisedText === "string" && rev.revisedText.trim()) {
          console.log(`[fact-check] softened segment ${idx} (${rev.reason || "no reason given"}): "${sentences[idx]}" -> "${rev.revisedText.trim()}"`);
          revised[idx] = rev.revisedText.trim();
          flaggedIndices.push(idx);
        }
      }
      if (!flaggedIndices.length) console.log("[fact-check] no claims flagged");
      return { sentences: revised, flaggedIndices };
    } catch (err) {
      console.warn(`[fact-check] ${model} failed: ${err.message}, trying next model...`);
    }
  }
  console.warn("[fact-check] all models failed — publishing the original, unreviewed script text");
  return { sentences, flaggedIndices: [] };
}

// Sept 16 2026: a single, deterministic (never model-generated) closing
// beat appended to every video by the callers below, per the channel brief's
// "choose one primary brand ending" instruction — a real spoken/on-screen
// line the model never has to remember to write, so it's guaranteed
// consistent from video to video the way a recognizable outro needs to be.
// The Gemini prompts above are explicitly told NOT to write their own
// sign-off for this reason (see BEAT_STRUCTURE's PAYOFF note).
export const NEXTSCENE_BRAND_LINE = "The world is stranger than you think.";
export const NEXTSCENE_BRAND_SUBLINE = "NEXTSCENE — follow for more.";
