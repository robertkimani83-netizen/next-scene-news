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
import { generateScript } from "./lib/script-gen.mjs";
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
];

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

  const topic = await pickAndRecordTopic(SHORT_TOPIC_POOL, TOPIC_HISTORY_PATH);
  console.log(`[topic] ${topic}`);

  console.log("[script] generating with Gemini (short form)...");
  const script = await generateScript(topic, { short: true });
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

  // Rotate the accent-color theme per video (see CARD_THEMES in
  // ffmpeg-build.mjs) so the channel doesn't look like one identical
  // template stamped out on every upload.
  const theme = CARD_THEMES[Math.floor(Math.random() * CARD_THEMES.length)];
  console.log(`[theme] using "${theme.name}" card theme`);

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
  const hashtags = buildHashtags(script.keywords, ["#Shorts", "#geopolitics", "#futurepredictions"]);
  const tags = buildTags(script.keywords, coveredPlaces, ["shorts", "geopolitics", "top10", "future predictions"]);
  const description = [
    script.title,
    "",
    coveredPlaces.length ? `About: ${coveredPlaces.join(", ")}.` : "",
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
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
