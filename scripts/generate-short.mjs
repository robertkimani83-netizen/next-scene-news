// YouTube Shorts pipeline — the fast, vertical companion to
// generate-documentary.mjs. Same overall shape (Gemini script -> msedge-tts
// narration with exact per-sentence timing -> real Pexels/Unsplash clips ->
// ffmpeg assembly -> upload to NEXTSCENE TV), but: portrait 1080x1920
// canvas, a much shorter/punchier single-topic script (~25-40s) instead of
// a full Top-10 countdown, and no mid-roll subscribe splice or separate
// outro card — every second counts on a Short, so it opens with the title
// card + spoken hook and just ends on the script's own "follow for more"
// line over normal footage.
//
// Required environment variables — same secrets as generate-documentary.mjs
// (GEMINI_API_KEY, PEXELS_API_KEY, GOOGLE_CLIENT_ID/SECRET, YOUTUBE_REFRESH_TOKEN).
//
// Run locally to test without uploading:
//   node scripts/generate-short.mjs --no-upload

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeNarration } from "./lib/tts.mjs";
import { fetchVisualForSegment, fetchFlag } from "./lib/visuals.mjs";
import { buildDocumentary, PORTRAIT_DIMS, CARD_THEMES, extractThumbnail } from "./lib/ffmpeg-build.mjs";
import { generateAiThumbnail } from "./lib/thumbnail-gen.mjs";
import { generateScript, generateGuessScript, generateMapClueScript } from "./lib/script-gen.mjs";
import { renderMapChallengeCards } from "./lib/map-challenge.mjs";
import { pickAndRecordTopic } from "./lib/topic-history.mjs";
import { uploadToYouTube, getOrCreatePlaylist, addVideoToPlaylist, setThumbnail } from "./lib/youtube.mjs";
import { buildHashtags, buildTags } from "./lib/seo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_UPLOAD = process.argv.includes("--no-upload");

// state/topic-history-short.json is committed back to the repo after a real
// run (see the "Save topic history" step in generate-short.yml) so the
// least-recently-used picker (lib/topic-history.mjs) has real memory across
// separate Actions runs.
const TOPIC_HISTORY_PATH = path.join(__dirname, "..", "state", "topic-history-short.json");

// Separate LRU history for the "Guess the Country" series (below) — kept in
// its own file/pool rather than sharing TOPIC_HISTORY_PATH so a country
// used as a guess-challenge answer and the same country appearing in the
// normal SHORT_TOPIC_POOL (e.g. as a location) never interfere with each
// other's rotation.
const TOPIC_HISTORY_GUESS_PATH = path.join(__dirname, "..", "state", "topic-history-short-guess.json");

// Same idea, separate file again, for the "Map Challenge" series below —
// its own answer pool/rotation, independent of both the normal topic pool
// and the "Guess the Country" pool.
const TOPIC_HISTORY_MAP_PATH = path.join(__dirname, "..", "state", "topic-history-short-map.json");

// Punchy single-fact/single-country topics — deliberately NOT full Top-10
// lists (those need the full ~60-90s runtime to land). Extend freely, the
// picker adapts automatically.
//
// Sept 10 2026: added a second wave leaning into trending geopolitics —
// alliances, resource competition, cyber/AI conflict, currency politics —
// alongside the original "richest tiny country" angle, so the channel
// isn't just cycling the same handful of wealth-superlative stories. 52
// topics total at 3 Shorts/day means the pool now cycles roughly every 17
// days before any topic repeats.
// Sept 10 2026 (later same day): same reversal/curiosity-gap wave as the
// long-form pool, added for the same reason (these angles measurably
// outperform plain wealth-ranking topics on this channel).
// Sept 11 2026: added a rivalry/conflict wave — real, ongoing standoffs,
// border disputes and head-to-head power struggles between two named
// countries (China vs India, Iran vs Israel, the chip war, etc.) instead of
// a single country's stat. Tension and stakes between two named sides tends
// to out-hook a flat "this country is rich/secretly powerful" fact, and it's
// a genuinely different angle from every wave above rather than a reskin of
// the same wealth/power-superlative format.
const SHORT_TOPIC_POOL = [
  "The country that looks poor but is secretly one of the richest on Earth",
  "Why Monaco has no income tax and how its economy actually works",
  "The country everyone hates and the real reason why",
  "Why NATO's newest members are reshaping Europe's defense map",
  "The tiny country secretly more powerful than nations 100 times its size",
  "The country with the highest number of billionaires per capita",
  "The country banned from something you'd never expect",
  "The country secretly stockpiling the world's rare earth minerals",
  "Why this country looks broke but is actually loaded",
  "Why Singapore became one of the richest countries in the world",
  "The country hiding one of the world's best-kept economic secrets",
  "Why BRICS is trying to build an alternative to the US dollar",
  "Why everyone gets this country's wealth completely wrong",
  "The smallest country in the world with the strongest economy",
  "The country nobody talks about that secretly controls global trade",
  "The nation quietly building military bases across three continents",
  "Why this 'friendly' country is secretly a rival superpower",
  "Why Norway's oil fund is the largest sovereign wealth fund on Earth",
  "The country where the official numbers don't add up",
  "Why the Arctic is becoming the world's next resource battleground",
  "The most underestimated country in the world right now",
  "The country that prints more money than any other in the world",
  "Why this tiny nation is secretly richer than its neighbors",
  "The country with the most spies per capita in the world",
  "The country the world assumes is dangerous but really isn't",
  "Why Switzerland stays neutral and still gets incredibly rich",
  "The country the world assumes is safe but really isn't",
  "Why Taiwan makes the world hold its breath every year",
  "The surprising secret behind this country's sudden wealth",
  "The African country with the fastest growing economy right now",
  "The nation that controls the world's most important shipping chokepoint",
  "Why Dubai built one of the richest cities out of a desert",
  "Why critical minerals are the new oil in global politics",
  "The country with the most gold reserves per citizen",
  "The country using AI to reshape its entire military",
  "Why Iceland has almost zero crime and one of the happiest populations",
  "Why water is becoming more valuable than oil in some countries",
  "The country spending the most on artificial intelligence right now",
  "The smallest country with the biggest cyber warfare capability",
  "Why Qatar became one of the wealthiest nations per capita",
  "Why de-dollarization is quietly gaining momentum worldwide",
  "The country with the world's most powerful passport",
  "The nation building the world's most advanced hypersonic missiles",
  "Why Estonia is called the most digital country on Earth",
  "Why Africa is becoming the world's next geopolitical battleground",
  "The country building the world's tallest and most futuristic skyline",
  "The country stockpiling weapons faster than any other right now",
  "Why Luxembourg has the highest GDP per capita in the world",
  "Why the Red Sea has become one of the world's most dangerous waterways",
  "The country where robots outnumber factory workers",
  "The nation with the most foreign military bases on Earth",
  "Why New Zealand keeps topping the world's safest countries list",
  "Why semiconductor factories are now a matter of national security",
  "The tiny country that controls a huge share of the world's shipping",
  "The country betting its future on becoming an AI superpower",
  "Why Ireland became a tax haven for the world's biggest tech companies",
  "Why Latin America's politics are swinging in a new direction",
  "The country with more sheep than people",
  "The tiny alliance quietly building nuclear-powered submarines",
  "Why Taiwan makes almost all the world's advanced computer chips",
  "The country spending the most per person on renewable energy",
  "Why Finland is ranked the happiest country on Earth",
  "The smallest economy that punches way above its weight",
  "Why South Korea became a global entertainment and tech powerhouse",
  "The country with the world's largest sovereign gold reserve per capita",
  "Why Rwanda is called Africa's cleanest and safest country",
  "The nation betting its entire future on artificial intelligence",
  "Why China and India can't stop fighting over this border",
  "The islands both China and Japan refuse to give up",
  "Why Iran and Israel are edging closer to a bigger war",
  "The silent chip war between the US and China nobody can win outright",
  "Why Venezuela and Guyana are fighting over an oil-rich territory",
  "The river dam turning Egypt and Ethiopia into rivals",
  "Why Armenia and Azerbaijan keep going back to war",
  "The two nations racing each other to control the world's lithium",
  "Why Turkey and Greece can't stop clashing over the same sea",
  "The standoff over who really controls the South China Sea",
  "Why North and South Korea are still technically at war",
  "The two rivals secretly stockpiling weapons against each other",
  "Why Pakistan and India still can't agree on this river",
  "The rivalry between Saudi Arabia and Iran reshaping the Middle East",
  "Why the Philippines and China keep clashing at sea",
  "The flashpoint that could turn Taiwan into a global crisis overnight",
  "Why Morocco and Algeria cut ties and what it could trigger next",
  "The two superpowers racing to weaponize AI before the other one does",
  "Why Serbia and Kosovo tensions keep boiling over",
  "The Arctic standoff nobody's watching between Russia and the West",
  "Why Poland and Russia's relationship keeps getting more dangerous",
  "The two countries fighting over the last untapped oil reserves",
  "Why Sudan and Egypt still can't agree on their shared border",
  "The rivalry between two nations both racing to build the strongest military AI",
  // Sept 11 2026 (later same day): a broader wave moving past countries
  // entirely — cities, AI/future, mystery/strange-places and a few
  // explicit hook-format experiments (What If / Did You Know / Versus /
  // Before-vs-After) baked directly into the topic text itself, since
  // generateScript() just writes toward whatever the topic string already
  // frames. Paired with SHORT_TOPIC_SERIES below so these (plus the rivalry
  // wave above) file into recognizable recurring series/playlists instead
  // of only the single catch-all Shorts playlist.
  "Did you know some countries have no army at all?",
  "The smallest countries in the world you've probably never heard of",
  "The countries that don't have a single major river running through them",
  "The countries that could disappear within our lifetime",
  "The countries almost no tourists ever visit",
  "The countries that own islands thousands of miles from their own borders",
  "The cheapest countries in the world to actually live in",
  "The most expensive cities on Earth right now",
  "The countries that could become the richest in the world by 2050",
  "The countries where salaries are rising faster than anywhere else",
  "What $100 is actually worth in different countries around the world",
  "The countries sitting on the largest untapped natural resources on Earth",
  "The jobs AI could wipe out within the next decade",
  "The jobs AI probably can never replace",
  "What the world could actually look like by 2050",
  "The technologies that could completely change your daily life within years",
  "What happens if AI ever becomes smarter than humans",
  "The brand new cities being built entirely from scratch",
  "The cities with more skyscrapers than anywhere else on Earth",
  "The cities that are almost completely empty",
  "The underground cities most people don't know exist",
  "The cities that could be underwater within decades",
  "The most futuristic cities being built right now",
  "The places on Earth humans are not allowed to visit",
  "The mysterious places scientists still can't fully explain",
  "The strangest laws that actually exist around the world",
  "Things that legally exist in only one country on Earth",
  "The abandoned cities that look frozen in time",
  "The places on Earth that look like another planet",
  "Secrets hidden underneath some of the world's most famous cities",
  "Facts about Africa most people have never heard",
  "How artificial intelligence could transform Africa's economy",
  "What if Africa became a single unified country?",
  "Africa vs Europe: which continent actually has more natural resources?",
  "USA vs China vs India: which superpower actually comes out on top?",
  "Dubai in 1990 versus Dubai today",
];

// Maps a subset of SHORT_TOPIC_POOL topics to a named recurring series.
// Purely a branding/discovery layer on top of the existing single-topic
// pipeline — the topic itself still drives the script — but a video whose
// topic has an entry here also gets filed into that series' own YouTube
// playlist (created on first use) and gets one extra line in its
// description naming the series, on top of the usual catch-all "NEXTSCENE
// Shorts" playlist every upload already joins. Not every topic needs a
// series; an untagged topic just skips this and behaves exactly as before.
const SHORT_TOPIC_SERIES = Object.fromEntries([
  ...[
    "Why China and India can't stop fighting over this border",
    "The islands both China and Japan refuse to give up",
    "Why Iran and Israel are edging closer to a bigger war",
    "The silent chip war between the US and China nobody can win outright",
    "Why Venezuela and Guyana are fighting over an oil-rich territory",
    "The river dam turning Egypt and Ethiopia into rivals",
    "Why Armenia and Azerbaijan keep going back to war",
    "The two nations racing each other to control the world's lithium",
    "Why Turkey and Greece can't stop clashing over the same sea",
    "The standoff over who really controls the South China Sea",
    "Why North and South Korea are still technically at war",
    "The two rivals secretly stockpiling weapons against each other",
    "Why Pakistan and India still can't agree on this river",
    "The rivalry between Saudi Arabia and Iran reshaping the Middle East",
    "Why the Philippines and China keep clashing at sea",
    "The flashpoint that could turn Taiwan into a global crisis overnight",
    "Why Morocco and Algeria cut ties and what it could trigger next",
    "The two superpowers racing to weaponize AI before the other one does",
    "Why Serbia and Kosovo tensions keep boiling over",
    "The Arctic standoff nobody's watching between Russia and the West",
    "Why Poland and Russia's relationship keeps getting more dangerous",
    "The two countries fighting over the last untapped oil reserves",
    "Why Sudan and Egypt still can't agree on their shared border",
    "The rivalry between two nations both racing to build the strongest military AI",
    "Africa vs Europe: which continent actually has more natural resources?",
    "USA vs China vs India: which superpower actually comes out on top?",
  ].map((t) => [t, "Country Battles"]),
  ...[
    "The jobs AI could wipe out within the next decade",
    "The jobs AI probably can never replace",
    "What the world could actually look like by 2050",
    "The technologies that could completely change your daily life within years",
    "What happens if AI ever becomes smarter than humans",
    "The countries that could become the richest in the world by 2050",
    "The countries that could disappear within our lifetime",
    "The cities that could be underwater within decades",
  ].map((t) => [t, "Future Earth"]),
  ...[
    "Facts about Africa most people have never heard",
    "How artificial intelligence could transform Africa's economy",
    "What if Africa became a single unified country?",
    "The African country with the fastest growing economy right now",
    "Why Rwanda is called Africa's cleanest and safest country",
    "Why Africa is becoming the world's next geopolitical battleground",
  ].map((t) => [t, "Africa Rising"]),
  ...[
    "The brand new cities being built entirely from scratch",
    "The cities with more skyscrapers than anywhere else on Earth",
    "The cities that are almost completely empty",
    "The underground cities most people don't know exist",
    "The most futuristic cities being built right now",
    "The places on Earth humans are not allowed to visit",
    "The mysterious places scientists still can't fully explain",
    "The abandoned cities that look frozen in time",
    "The places on Earth that look like another planet",
    "Secrets hidden underneath some of the world's most famous cities",
    "The countries almost no tourists ever visit",
  ].map((t) => [t, "Impossible Places"]),
  ...[
    "Did you know some countries have no army at all?",
    "The smallest countries in the world you've probably never heard of",
    "The countries that don't have a single major river running through them",
    "The countries that own islands thousands of miles from their own borders",
    "The cheapest countries in the world to actually live in",
    "The most expensive cities on Earth right now",
    "The countries where salaries are rising faster than anywhere else",
    "What $100 is actually worth in different countries around the world",
    "The strangest laws that actually exist around the world",
    "Things that legally exist in only one country on Earth",
    "Dubai in 1990 versus Dubai today",
    "The countries sitting on the largest untapped natural resources on Earth",
  ].map((t) => [t, "World in 30 Seconds"]),
]);

const SERIES_DESCRIPTIONS = {
  "Country Battles": "Head-to-head rivalries, standoffs and power struggles between two nations — NEXTSCENE TV.",
  "Future Earth": "What the world, AI and the global economy could look like in the decades ahead — NEXTSCENE TV.",
  "Africa Rising": "The economies, stories and future of Africa the headlines miss — NEXTSCENE TV.",
  "Impossible Places": "Cities, ruins and places on Earth that barely look real — NEXTSCENE TV.",
  "World in 30 Seconds": "One fast, surprising world fact at a time — NEXTSCENE TV.",
  "Guess the Country": "3 clues, one mystery country, 3-2-1 reveal — can you get it before the countdown? NEXTSCENE TV.",
  "Map Challenge": "Watch the map zoom in on a mystery country — can you name it before the reveal? NEXTSCENE TV.",
};

// Answer pool for the "Guess the Country" series (see generateGuessScript in
// lib/script-gen.mjs and the segment-building branch in main() below) —
// deliberately lesser-known-but-guessable countries spread across
// continents, not the handful of countries every viewer names instantly
// (USA, China, France, ...), since an unwinnable-obvious or
// unwinnable-impossible answer is equally bad for a guessing game.
const SHORT_GUESS_POOL = [
  { name: "Madagascar", countryCode: "mg" },
  { name: "Mongolia", countryCode: "mn" },
  { name: "Bhutan", countryCode: "bt" },
  { name: "Suriname", countryCode: "sr" },
  { name: "Oman", countryCode: "om" },
  { name: "Estonia", countryCode: "ee" },
  { name: "Uruguay", countryCode: "uy" },
  { name: "Laos", countryCode: "la" },
  { name: "Eritrea", countryCode: "er" },
  { name: "Brunei", countryCode: "bn" },
  { name: "Kyrgyzstan", countryCode: "kg" },
  { name: "Paraguay", countryCode: "py" },
  { name: "Namibia", countryCode: "na" },
  { name: "Bahrain", countryCode: "bh" },
  { name: "Slovenia", countryCode: "si" },
  { name: "Botswana", countryCode: "bw" },
  { name: "Azerbaijan", countryCode: "az" },
  { name: "Fiji", countryCode: "fj" },
  { name: "Jordan", countryCode: "jo" },
  { name: "Armenia", countryCode: "am" },
];

// Roughly 1 in 4 Shorts is a "Guess the Country" challenge instead of the
// usual single-fact format — a genuinely different structure (clue segments
// on a mystery card, a 3-2-1 countdown, then a flag/footage reveal), not
// just a different topic, so it needs to stay a minority of uploads rather
// than replace the existing format outright.
const GUESS_FORMAT_PROBABILITY = 0.25;

// Answer pool for the "Map Challenge" series (see generateMapClueScript in
// lib/script-gen.mjs and lib/map-challenge.mjs) — same countries as
// SHORT_GUESS_POOL (kept as a separate list rather than a shared reference
// so the two series' answer rotations can never accidentally interfere),
// every one of them verified to match a country name in world-atlas's
// countries-50m boundary dataset (map-challenge.mjs throws loudly at render
// time if a name ever stops matching, e.g. after a dependency bump).
const MAP_CHALLENGE_POOL = [
  { name: "Madagascar", countryCode: "mg" },
  { name: "Mongolia", countryCode: "mn" },
  { name: "Bhutan", countryCode: "bt" },
  { name: "Suriname", countryCode: "sr" },
  { name: "Oman", countryCode: "om" },
  { name: "Estonia", countryCode: "ee" },
  { name: "Uruguay", countryCode: "uy" },
  { name: "Laos", countryCode: "la" },
  { name: "Eritrea", countryCode: "er" },
  { name: "Brunei", countryCode: "bn" },
  { name: "Kyrgyzstan", countryCode: "kg" },
  { name: "Paraguay", countryCode: "py" },
  { name: "Namibia", countryCode: "na" },
  { name: "Bahrain", countryCode: "bh" },
  { name: "Slovenia", countryCode: "si" },
  { name: "Botswana", countryCode: "bw" },
  { name: "Azerbaijan", countryCode: "az" },
  { name: "Fiji", countryCode: "fj" },
  { name: "Jordan", countryCode: "jo" },
  { name: "Armenia", countryCode: "am" },
];

// A genuinely different structure again from both other formats: no mystery
// card, no countdown — a real, accurate map graphic zooms progressively
// closer on the (unlabeled) answer country across 3 clue segments, then a
// full-zoom reveal. Kept a minority of uploads, same reasoning as
// GUESS_FORMAT_PROBABILITY. The two probabilities are drawn from the same
// roll (see isGuessFormat/isMapFormat in main()) so they never overlap —
// GUESS_FORMAT_PROBABILITY + MAP_FORMAT_PROBABILITY must stay <= 1.
const MAP_FORMAT_PROBABILITY = 0.2;

// Background photo behind the intro card — same idea as the long-form
// pipeline's INTRO_BG_QUERY; non-fatal if nothing is found, renderTitleCard
// falls back to a flat card automatically.
const INTRO_BG_QUERY = "futuristic city skyline night aerial";

// Every Short gets filed into this playlist (created once, reused after) —
// same reasoning as the long-form pipeline's PLAYLIST_TITLE.
const PLAYLIST_TITLE = "NEXTSCENE Shorts";
const PLAYLIST_DESCRIPTION = "Quick country/economy facts and future predictions from NEXTSCENE TV — the future uncovered.";

async function main() {
  const runDir = path.join(__dirname, "..", "tmp", `short_${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });

  // Picked once, up front, so lib/map-challenge.mjs can use it (its
  // highlight color rotates with the theme, same as everything else) — used
  // again later for the title cards/badges via buildDocumentary, unchanged
  // from before other than now being computed earlier.
  const theme = CARD_THEMES[Math.floor(Math.random() * CARD_THEMES.length)];
  console.log(`[theme] using "${theme.name}" card theme`);

  const formatRand = Math.random();
  const isGuessFormat = formatRand < GUESS_FORMAT_PROBABILITY;
  const isMapFormat = !isGuessFormat && formatRand < GUESS_FORMAT_PROBABILITY + MAP_FORMAT_PROBABILITY;
  let topic, script;

  if (isGuessFormat) {
    const country = await pickAndRecordTopic(SHORT_GUESS_POOL.map((c) => c.name), TOPIC_HISTORY_GUESS_PATH);
    const countryInfo = SHORT_GUESS_POOL.find((c) => c.name === country);
    topic = `[Guess the Country] ${country}`;
    console.log(`[topic] ${topic}`);

    console.log("[script] generating with Gemini (guess-the-country form)...");
    const guess = await generateGuessScript(country);
    console.log(`[script] title: ${guess.title} (${guess.clues.length} clues + countdown + reveal)`);

    // Turn the guess-script shape into the same {title, segments, keywords}
    // shape generateScript() returns, so everything downstream (intro
    // unshift, TTS, captions, ffmpeg build, upload, playlists) needs no
    // guess-format-specific handling beyond how each segment's *visual*
    // gets built (see visualKind below). Clue segments carry
    // visualKind:"mystery" (a generic branded card — deliberately NOT real
    // footage, which could accidentally give the answer away); the
    // countdown segments carry visualKind:"countdown"; the reveal segment
    // is a normal location/countryCode segment and reuses the existing
    // real-footage + flag-badge path untouched.
    //
    // Deliberately NOT using the shared script.commentary field here: the
    // shared splice below always inserts commentary right before the LAST
    // segment, which for every other format is a generic closing line but
    // here would be the reveal itself — that would shove the extra fact
    // between the countdown and the reveal (killing the 3-2-1 payoff) and,
    // worse, risks the commentary naming the country before the reveal
    // segment ever fires. So the commentary segment (if any) is appended
    // AFTER the reveal instead, built directly into the segments array, and
    // script.commentary is left unset so the shared splice below is a no-op
    // for this run.
    const guessSegments = [
      ...guess.clues.map((text, i) => ({
        text,
        location: "",
        visualQuery: "",
        visualKind: "mystery",
        clueNumber: i + 1,
      })),
      { text: "Three.", location: "", visualQuery: "", visualKind: "countdown", countdownNumber: 3 },
      { text: "Two.", location: "", visualQuery: "", visualKind: "countdown", countdownNumber: 2 },
      { text: "One.", location: "", visualQuery: "", visualKind: "countdown", countdownNumber: 1 },
      {
        text: guess.reveal,
        location: country,
        visualQuery: `${country} landscape aerial`,
        countryCode: countryInfo.countryCode,
        rank: null,
      },
    ];
    if (guess.commentary) {
      guessSegments.push({
        text: guess.commentary,
        location: country,
        visualQuery: `${country} global analysis`,
        countryCode: countryInfo.countryCode,
        rank: null,
        isCommentary: true,
      });
    }
    script = { title: guess.title, keywords: guess.keywords, segments: guessSegments };
  } else if (isMapFormat) {
    const country = await pickAndRecordTopic(MAP_CHALLENGE_POOL.map((c) => c.name), TOPIC_HISTORY_MAP_PATH);
    const countryInfo = MAP_CHALLENGE_POOL.find((c) => c.name === country);
    topic = `[Map Challenge] ${country}`;
    console.log(`[topic] ${topic}`);

    console.log("[script] generating with Gemini (map-challenge form)...");
    const mapScript = await generateMapClueScript(country);
    console.log(`[script] title: ${mapScript.title} (${mapScript.clues.length} clues + map zoom + reveal)`);

    console.log("[map] rendering zoom-stage map graphics...");
    const mapCards = await renderMapChallengeCards(country, runDir, theme);

    // Same reasoning as the guess-format branch above for keeping the
    // reveal/commentary ordering explicit rather than relying on the shared
    // script.commentary splice (which always inserts before the LAST
    // segment — here that would land the extra fact between the last clue
    // and the reveal, killing the zoom-in payoff). Clue segments carry
    // visualKind:"map" with their own pre-rendered zoom-stage PNG; the
    // reveal segment carries visualKind:"map-reveal" and behaves like any
    // other countryCode segment for the flag badge.
    const mapSegments = [
      ...mapScript.clues.map((text, i) => ({
        text,
        location: "",
        visualQuery: "",
        visualKind: "map",
        mapImagePath: [mapCards.stage1, mapCards.stage2, mapCards.stage3][i],
      })),
      {
        text: mapScript.reveal,
        location: country,
        visualQuery: "",
        visualKind: "map-reveal",
        mapImagePath: mapCards.reveal,
        countryCode: countryInfo.countryCode,
        rank: null,
      },
    ];
    if (mapScript.commentary) {
      // Unlike the clue/reveal segments, the commentary line plays AFTER
      // the reveal, so there's no spoiler risk left — reuses the normal
      // real-footage visual path (fetchVisualForSegment) same as the guess
      // format's own commentary segment, for a bit of visual variety
      // instead of five map screens in a row.
      mapSegments.push({
        text: mapScript.commentary,
        location: country,
        visualQuery: `${country} global analysis`,
        countryCode: countryInfo.countryCode,
        rank: null,
        isCommentary: true,
      });
    }
    script = { title: mapScript.title, keywords: mapScript.keywords, segments: mapSegments };
  } else {
    topic = await pickAndRecordTopic(SHORT_TOPIC_POOL, TOPIC_HISTORY_PATH);
    console.log(`[topic] ${topic}`);

    console.log("[script] generating with Gemini (short form)...");
    script = await generateScript(topic, { short: true });
  }
  console.log(`[script] title: ${script.title} (${script.segments.length} segments)`);

  // Intro is ONE spoken segment (just the title) — unlike the long-form
  // pipeline's title+welcome split, there's no second sentence here, so no
  // risk of desyncing msedge-tts's one-timing-per-sentence output.
  const introCardLines = [script.title.toUpperCase(), "NEXTSCENE TV — THE FUTURE UNCOVERED"];
  script.segments.unshift({ text: `${script.title}.`, location: "", visualQuery: "", isIntro: true });

  // Splice a one-sentence analytical/opinion beat (script.commentary) in
  // right before the closing line, same idea as the long-form pipeline —
  // a genuine editorial take instead of just another fact, and it also
  // varies in phrasing video to video (see the prompt in script-gen.mjs).
  if (script.commentary && script.segments.length > 1) {
    const commentaryQuery = script.keywords?.length
      ? `${script.keywords[0]} global analysis`
      : "world map global analysis data";
    script.segments.splice(script.segments.length - 1, 0, {
      text: script.commentary,
      location: "",
      visualQuery: commentaryQuery,
      isCommentary: true,
    });
  }

  const fullNarration = script.segments.map((s) => s.text).join(" ");
  console.log("[tts] synthesizing narration (en-KE-AsiliaNeural, Kenyan English, female)...");
  const { audioPath, sentences } = await synthesizeNarration(fullNarration, runDir, "en-KE-AsiliaNeural");

  if (sentences.length !== script.segments.length) {
    console.warn(
      `[tts] warning: got ${sentences.length} sentence boundaries but ${script.segments.length} script segments — ` +
      `TTS sentence splitting doesn't always match 1:1. Falling back to even time distribution.`
    );
  }

  console.log("[visuals] fetching real clips/photos per segment (portrait)...");
  const segmentsForBuild = [];
  let introDurationSec = 0; // real TTS timing for the intro card, used to pick a safe thumbnail-frame timestamp
  for (let i = 0; i < script.segments.length; i++) {
    const timing = sentences[i] ?? {
      durationSec: (sentences.at(-1)?.startSec + sentences.at(-1)?.durationSec || 30) / script.segments.length,
    };
    let visual;
    if (script.segments[i].isIntro) {
      const bgVisual = await fetchVisualForSegment({ query: INTRO_BG_QUERY }, runDir, i).catch(() => null);
      visual = { type: "title-card", lines: introCardLines, fontsize: 58, bgVisual };
      introDurationSec += timing.durationSec;
      console.log(`  segment ${i}: intro card — "${script.segments[i].text}" (${timing.durationSec.toFixed(1)}s)${bgVisual ? "" : " [no bg photo found, using flat card]"}`);
    } else if (script.segments[i].visualKind === "mystery") {
      // "Guess the Country" clue segment — deliberately a plain branded card,
      // NOT a real stock photo/clip. Real footage matched to the clue text
      // risks accidentally showing something recognizable as the answer
      // (e.g. a clue about a specific mountain range pulling back an actual
      // photo of it) before the reveal segment is supposed to. bg is a flat
      // dark navy (no bgVisual passed) so renderTitleCard falls back to a
      // solid color card automatically — no photo fetch at all for this
      // segment, so nothing to accidentally give the game away with.
      visual = {
        type: "title-card",
        lines: [`CLUE ${script.segments[i].clueNumber}`, "GUESS THE COUNTRY"],
        fontsize: 64,
        subFontsize: 30,
        bg: "0x0B0F1A",
      };
      console.log(`  segment ${i}: mystery clue card (clue ${script.segments[i].clueNumber}) — "${script.segments[i].text}" (${timing.durationSec.toFixed(1)}s)`);
    } else if (script.segments[i].visualKind === "countdown") {
      // Big centered number, no sub-line — same title-card renderer, just a
      // huge digit standing in for "lines[0]".
      visual = {
        type: "title-card",
        lines: [String(script.segments[i].countdownNumber)],
        fontsize: 220,
        bg: "0x0B0F1A",
      };
      console.log(`  segment ${i}: countdown card "${script.segments[i].countdownNumber}" (${timing.durationSec.toFixed(1)}s)`);
    } else if (script.segments[i].visualKind === "map" || script.segments[i].visualKind === "map-reveal") {
      // "Map Challenge" clue/reveal segment — a pre-rendered real map
      // graphic (lib/map-challenge.mjs), wired in as a plain
      // visual.type:"image" so it gets the exact same Ken Burns pan/zoom as
      // any fetched photo, with zero changes needed in ffmpeg-build.mjs.
      // The reveal segment additionally gets the normal flag/country-name
      // badge, same as any other countryCode segment below.
      visual = { type: "image", path: script.segments[i].mapImagePath };
      if (script.segments[i].visualKind === "map-reveal" && script.segments[i].countryCode) {
        const flagPath = await fetchFlag(script.segments[i].countryCode, runDir).catch(() => null);
        if (flagPath) {
          visual.badge = { rank: null, countryName: script.segments[i].location || "", flagPath };
          console.log(`    + badge: flag ${script.segments[i].countryCode}`);
        } else {
          console.warn(`    flag fetch failed for "${script.segments[i].countryCode}" — no badge for this segment`);
        }
      }
      console.log(`  segment ${i}: map-challenge ${script.segments[i].visualKind === "map-reveal" ? "reveal" : "clue"} card — "${script.segments[i].text}" (${timing.durationSec.toFixed(1)}s)`);
    } else {
      visual = await fetchVisualForSegment(
        { query: script.segments[i].visualQuery, location: script.segments[i].location },
        runDir,
        i
      ).catch((err) => {
        console.warn(`[visuals] segment ${i} ("${script.segments[i].visualQuery}") failed: ${err.message}`);
        return null;
      });
      const matched = visual?.matchedTerm ? ` matched "${visual.matchedTerm}"` : "";
      console.log(`  segment ${i}: ${visual ? visual.type : "NO VISUAL FOUND"}${matched} — wanted "${script.segments[i].visualQuery}" (${timing.durationSec.toFixed(1)}s)`);

      if (visual && script.segments[i].countryCode) {
        const flagPath = await fetchFlag(script.segments[i].countryCode, runDir).catch(() => null);
        if (flagPath) {
          visual.badge = {
            rank: script.segments[i].rank ?? null,
            countryName: script.segments[i].location || "",
            flagPath,
          };
          console.log(`    + badge: rank ${visual.badge.rank ?? "—"}, flag ${script.segments[i].countryCode}`);
        } else {
          console.warn(`    flag fetch failed for "${script.segments[i].countryCode}" — no badge for this segment`);
        }
      }
    }
    segmentsForBuild.push({ visual, durationSec: timing.durationSec, text: script.segments[i].text });
  }

  const outputPath = path.join(runDir, "final_short.mp4");
  console.log("[ffmpeg] assembling synced portrait video...");
  await buildDocumentary(segmentsForBuild, audioPath, path.join(runDir, "work"), outputPath, null, {
    dims: PORTRAIT_DIMS,
    theme,
  });

  const totalSec = segmentsForBuild.reduce((sum, s) => sum + Math.max(s.durationSec, 0.6), 0);
  console.log(`[done] short ready: ${outputPath} (~${totalSec.toFixed(1)}s)`);
  if (totalSec > 60) {
    console.warn(`[warn] this short is ${totalSec.toFixed(1)}s — over 60s risks YouTube not treating it as a Short.`);
  }

  // Custom thumbnail: try a real AI-generated, Canva-style bold design first
  // (fresh background image + branded headline per video — see
  // lib/thumbnail-gen.mjs for why this isn't a live Canva API call), and
  // only fall back to grabbing a still frame from the branded intro card if
  // that fails for any reason. Either way this beats leaving it to YouTube's
  // own auto-pick (which was landing on random mid-video caption frames).
  const thumbnailPath = path.join(runDir, "thumbnail.jpg");
  let thumbnailReady = false;
  console.log("[thumbnail] generating AI thumbnail...");
  const aiThumbPath = await generateAiThumbnail({ title: script.title, topic, outDir: runDir, theme });
  if (aiThumbPath) {
    await fs.copyFile(aiThumbPath, thumbnailPath);
    thumbnailReady = true;
    console.log("[thumbnail] AI-generated thumbnail ready");
  } else {
    try {
      const atSec = Math.max(0.3, Math.min(1.5, introDurationSec * 0.5));
      await extractThumbnail(outputPath, thumbnailPath, atSec);
      thumbnailReady = true;
      console.log(`[thumbnail] extracted frame at ${atSec.toFixed(2)}s (AI thumbnail unavailable)`);
    } catch (err) {
      console.warn(`[thumbnail] extraction failed too (upload will keep YouTube's auto-picked frame): ${err.message}`);
    }
  }

  if (NO_UPLOAD) {
    console.log("[upload] skipped (--no-upload)");
    return;
  }

  console.log("[upload] pushing to NEXTSCENE TV...");
  // "#Shorts" in the title/description is the well-known belt-and-suspenders
  // signal (alongside the portrait aspect ratio + short duration YouTube
  // already detects automatically) that reliably routes a video into the
  // Shorts shelf instead of regular uploads.
  const title = `${script.title} #Shorts`;
  const coveredPlaces = [...new Set(script.segments.map((s) => s.location).filter(Boolean))];
  const series = isGuessFormat ? "Guess the Country" : isMapFormat ? "Map Challenge" : (SHORT_TOPIC_SERIES[topic] ?? null);
  // Both "mystery" formats (trivia clues on a mystery card, or clues over a
  // zooming map) need the same spoiler-avoidance treatment below — neither
  // should leak the answer in the description or hashtags before anyone
  // watches — so they share one flag even though their series names differ.
  const isMysteryFormat = isGuessFormat || isMapFormat;
  // Hashtags render as visible chips right under the title — unlike `tags`
  // (search metadata only, never shown to viewers), so for a mystery-format
  // video any keyword matching the answer itself has to be stripped before
  // it becomes a hashtag, or the spoiler sits right at the top before
  // anyone watches.
  const hashtagKeywords = isMysteryFormat
    ? (script.keywords || []).filter((k) => !k.toLowerCase().includes(coveredPlaces[0]?.toLowerCase() ?? "\0"))
    : script.keywords;
  const hashtags = buildHashtags(
    hashtagKeywords,
    isGuessFormat
      ? ["#Shorts", "#guessthecountry", "#geoquiz"]
      : isMapFormat
        ? ["#Shorts", "#mapchallenge", "#geoquiz"]
        : ["#Shorts", "#geopolitics", "#futurepredictions"]
  );
  // Tags are invisible search metadata (never shown to viewers), so the
  // answer country is fine to include here even for a mystery-format video —
  // it's exactly the kind of thing someone might search after watching.
  const tags = buildTags(script.keywords, coveredPlaces, ["shorts", "geopolitics", "top10", "future predictions"]);
  const description = [
    script.title,
    "",
    // The normal format's "About: <place>" line would spoil a mystery
    // video's answer right under the title before anyone watches, so it's
    // skipped here — the reveal stays inside the video.
    !isMysteryFormat && coveredPlaces.length ? `About: ${coveredPlaces.join(", ")}.` : "",
    isGuessFormat ? "Did you get it before the countdown hit zero? Drop your guess before you watch!" : "",
    isMapFormat ? "Did you name it before the map finished zooming in? Drop your guess before you watch!" : "",
    series ? `Part of our "${series}" series — see the rest in that playlist on this channel.` : "",
    "Want the full breakdown? Check the \"Top 10 & Documentaries\" playlist on this channel.",
    "",
    hashtags.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
  const uploaded = await uploadToYouTube(outputPath, title, description, { tags });
  console.log(`[upload] done: https://youtube.com/watch?v=${uploaded.id}`);

  if (thumbnailReady) {
    try {
      await setThumbnail(uploaded.id, thumbnailPath);
      console.log("[thumbnail] custom thumbnail set");
    } catch (err) {
      console.warn(`[thumbnail] upload failed (video still uploaded fine, keeping YouTube's auto-picked frame): ${err.message}`);
    }
  }

  try {
    const playlistId = await getOrCreatePlaylist(PLAYLIST_TITLE, PLAYLIST_DESCRIPTION);
    await addVideoToPlaylist(playlistId, uploaded.id);
    console.log(`[playlist] added to "${PLAYLIST_TITLE}"`);
  } catch (err) {
    console.warn(`[playlist] failed (video still uploaded fine): ${err.message}`);
  }

  // Also file into this topic's named series playlist, if it has one (see
  // SHORT_TOPIC_SERIES above) — created on first use, same as the catch-all
  // playlist. Purely a discovery/branding extra, so failure here is never
  // fatal to an otherwise-successful upload.
  if (series) {
    try {
      const seriesPlaylistId = await getOrCreatePlaylist(series, SERIES_DESCRIPTIONS[series] ?? `${series} — NEXTSCENE TV.`);
      await addVideoToPlaylist(seriesPlaylistId, uploaded.id);
      console.log(`[playlist] added to "${series}"`);
    } catch (err) {
      console.warn(`[playlist] failed to add to series "${series}" (video still uploaded fine): ${err.message}`);
    }
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
