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

Accuracy: only state facts, figures and rankings you're genuinely confident are well-established and broadly reported — round or approximate a number rather than invent a precise-sounding one you're not sure of. This audience is quick to call out channels in the comments for numbers that seem made up, so a vague-but-true claim beats a specific-but-shaky one.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "a scroll-stopping YouTube title, under 60 characters. Avoid plain, generic ranking phrasing like 'Top 10 Richest Countries in Asia' — lead with a curiosity gap or a surprising claim that makes someone need to know the answer, e.g. in the spirit of (write NEW titles, never reuse these) 'The Country Nobody Saw Coming', 'Why This Nation Is Secretly Taking Over', 'The One Fact That Explains Everything'. Stay accurate to the real content — a stronger hook on the same facts, not clickbait that misleads.",
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

Style: authoritative, cinematic, "NEXTSCENE TV - THE FUTURE UNCOVERED" tone — the kind of voice-over used in geopolitics/future-predictions YouTube videos. Short punchy sentences. No intro pleasantries, start directly with a hook.

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
