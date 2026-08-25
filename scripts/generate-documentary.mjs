// Main pipeline: topic -> documentary script (Gemini) -> human-sounding
// narration with exact timing (msedge-tts) -> real video clips/photos per
// segment (Pexels/Unsplash) -> assembled synced video (ffmpeg) -> uploaded
// to the NEXTSCENE TV YouTube channel (reusing the OAuth refresh token
// already set up for the VOX254 pipeline, since it's the same channel).
//
// This is the LONG-FORM pipeline (~60-90s, landscape 1920x1080). See
// generate-short.mjs for the companion Shorts pipeline (~25-40s, portrait
// 1080x1920) — they share script generation (lib/script-gen.mjs), TTS
// (lib/tts.mjs), visuals (lib/visuals.mjs), video assembly
// (lib/ffmpeg-build.mjs), and upload (lib/youtube.mjs).
//
// Required environment variables (all already exist as secrets in the
// next-scene-news repo):
//   GEMINI_API_KEY
//   PEXELS_API_KEY            (UNSPLASH_API_KEY optional fallback)
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
//
// Run locally to test without uploading:
//   node scripts/generate-documentary.mjs --no-upload

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { synthesizeNarration } from "./lib/tts.mjs";
import { fetchVisualForSegment, fetchFlag } from "./lib/visuals.mjs";
import { buildDocumentary, CARD_THEMES } from "./lib/ffmpeg-build.mjs";
import { generateScript } from "./lib/script-gen.mjs";
import { pickAndRecordTopic } from "./lib/topic-history.mjs";
import { uploadToYouTube, getOrCreatePlaylist, addVideoToPlaylist } from "./lib/youtube.mjs";
import { buildHashtags, buildTags } from "./lib/seo.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_UPLOAD = process.argv.includes("--no-upload");

// state/topic-history-long.json is committed back to the repo after a real
// run (see the "Save topic history" step in generate-documentary.yml) so
// the least-recently-used picker (lib/topic-history.mjs) has real memory
// across separate Actions runs, not just a clock-derived guess.
const TOPIC_HISTORY_PATH = path.join(__dirname, "..", "state", "topic-history-long.json");

// NextScene TV's existing lane: Top 10 rankings, country/power comparisons,
// "what's coming next" style predictions. 35 topics at 4 videos/week (the
// current schedule) means the full pool cycles roughly every 8-9 weeks
// before any topic repeats — extend freely, the picker adapts automatically.
const TOPIC_POOL = [
  "Top 10 countries with the most powerful militaries in the world right now",
  "Top 10 fastest growing economies in the world and why they're rising",
  "Top 10 richest countries in Africa by GDP",
  "The countries most likely to become superpowers by 2050",
  "Top 10 cities in the world investing the most in future technology",
  "Top 10 countries with the largest oil and gas reserves",
  "The most powerful passports in the world and what they reveal about global power",
  "Top 10 countries leading the world in artificial intelligence development",
  "Top 10 countries with the strongest currencies in the world",
  "Top 10 countries most prepared for the next global pandemic",
  "Top 10 countries with the fastest internet and digital infrastructure",
  "Top 10 nations building the world's most advanced space programs",
  "Top 10 countries with the largest gold reserves",
  "The world's most influential trade alliances and what they mean for the future",
  "Top 10 countries with the biggest defense budgets",
  "Top 10 countries leading the global renewable energy race",
  "The nations racing to control the world's rare earth minerals",
  "Top 10 countries with the most billionaires and why they cluster there",
  "Top 10 countries with the most advanced healthcare systems in the world",
  "Top 10 countries producing the most electric vehicles",
  "Top 10 countries with the highest quality of life right now",
  "The nations most at risk of running out of fresh water",
  "Top 10 countries dominating global semiconductor production",
  "Top 10 countries with the largest and most modern navies",
  "The world's fastest-growing tech hubs outside Silicon Valley",
  "Top 10 countries with the most nuclear power plants",
  "Top 10 countries leading the global shift to electric transportation",
  "The nations quietly building the world's next financial centers",
  "Top 10 countries with the most advanced cybersecurity capabilities",
  "Top 10 countries with the youngest and fastest-growing populations",
  "The countries positioned to dominate the global chip war",
  "Top 10 countries with the strongest manufacturing sectors",
  "Top 10 countries investing the most in space exploration",
  "The nations racing to build the first commercial fusion reactors",
  "Top 10 countries with the most powerful economic sanctions leverage",
];

// Spoken mid-roll reminder — inserted into the narration itself so it's
// voiced and captioned exactly like every other sentence. It gets a normal
// fetched visual like any other segment (no special card) — voice-over only.
const SUBSCRIBE_LINE = "If you're finding this useful, hit subscribe — it really helps this channel grow.";
const SUBSCRIBE_VISUAL_QUERY = "smartphone social media scrolling";

// Intro/outro are also real spoken lines (not silent cards) — they get
// exact TTS timing and a branded title-card visual instead of stock footage.
// The intro is split into TWO spoken sentences (title, then welcome) rather
// than one line with a period in the middle — msedge-tts hands back one
// timing entry per SENTENCE it detects (see tts.mjs), and this pipeline
// assumes one script segment == one TTS sentence throughout; cramming two
// sentences into a single segment would silently shift every segment after
// it out of sync with its narration. Both segments share the same intro
// title-card visual, so on screen it just reads as one continuous intro.
const INTRO_WELCOME_LINE = "Welcome to NextScene TV — the future uncovered.";
const OUTRO_LINE = "Thanks for watching. Subscribe to NextScene TV for more videos like this one.";
const OUTRO_CARD_LINES = ["SUBSCRIBE FOR MORE", "NEXTSCENE TV — THE FUTURE UNCOVERED"];

// Background photo behind the intro/outro cards (thumbnail-style — a real
// skyline, not a flat color) — non-fatal if no clip/photo is found for
// either query, renderTitleCard just falls back to a plain card.
const INTRO_BG_QUERY = "futuristic city skyline night aerial";
const OUTRO_BG_QUERY = "city skyline night lights aerial";

// Every upload gets filed into this playlist (created once, reused after) —
// grouping related videos helps session watch time, which the algorithm
// rewards, and gives new viewers an easy "watch more of these" path.
const PLAYLIST_TITLE = "Top 10 & Documentaries — NEXTSCENE TV";
const PLAYLIST_DESCRIPTION =
  "Full-length Top 10 rankings, power comparisons, and future-prediction documentaries from NEXTSCENE TV — the future uncovered.";

async function main() {
  const runDir = path.join(__dirname, "..", "tmp", `run_${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });

  const topic = await pickAndRecordTopic(TOPIC_POOL, TOPIC_HISTORY_PATH);
  console.log(`[topic] ${topic}`);

  console.log("[script] generating with Gemini...");
  const script = await generateScript(topic);
  console.log(`[script] title: ${script.title} (${script.segments.length} segments)`);

  // splice the subscribe reminder into the middle of the script so it's
  // narrated in sequence, not just appended at the end
  const midIndex = Math.max(1, Math.floor(script.segments.length / 2));
  script.segments.splice(midIndex, 0, {
    text: SUBSCRIBE_LINE,
    location: "",
    visualQuery: SUBSCRIBE_VISUAL_QUERY,
    isSubscribeCTA: true,
  });

  // add a spoken intro and outro so they're part of the same one continuous
  // narration pass — exact TTS timing, no separate silence-padding needed.
  // The intro card shows the real episode title (thumbnail-style headline)
  // above the channel tagline; the spoken line stays a generic welcome.
  const introCardLines = [script.title.toUpperCase(), "NEXTSCENE TV — THE FUTURE UNCOVERED"];
  script.segments.unshift(
    { text: `${script.title}.`, location: "", visualQuery: "", isIntro: true },
    { text: INTRO_WELCOME_LINE, location: "", visualQuery: "", isIntro: true }
  );

  // A one-sentence analytical/opinion line from Gemini (script.commentary) —
  // a genuine editorial take rather than another plain fact, spliced in
  // right before the outro. This is a real human-editorial-style beat, not
  // just narrated facts back to back — see the note on YouTube's
  // "inauthentic content" policy in the channel's memory/history for why
  // that distinction matters. Falls back to skipping it gracefully if
  // Gemini didn't return one (older responses, or an off-schema reply).
  if (script.commentary) {
    const commentaryQuery = script.keywords?.length
      ? `${script.keywords[0]} global analysis`
      : "world map global analysis data";
    script.segments.push({
      text: script.commentary,
      location: "",
      visualQuery: commentaryQuery,
      isCommentary: true,
    });
  }

  script.segments.push({ text: OUTRO_LINE, location: "", visualQuery: "", isOutro: true });

  const fullNarration = script.segments.map((s) => s.text).join(" ");
  console.log("[tts] synthesizing narration (en-US-ChristopherNeural)...");
  const { audioPath, sentences } = await synthesizeNarration(fullNarration, runDir);

  if (sentences.length !== script.segments.length) {
    console.warn(
      `[tts] warning: got ${sentences.length} sentence boundaries but ${script.segments.length} script segments — ` +
      `TTS sentence splitting doesn't always match 1:1. Falling back to even time distribution.`
    );
  }

  console.log("[visuals] fetching real clips/photos per segment...");
  const segmentsForBuild = [];
  let introBgVisual; // fetched once, shared by both intro segments (title line + welcome line)
  for (let i = 0; i < script.segments.length; i++) {
    const timing = sentences[i] ?? {
      // fallback: split total narration duration evenly if boundaries misaligned
      durationSec: (sentences.at(-1)?.startSec + sentences.at(-1)?.durationSec || 60) / script.segments.length,
    };
    let visual;
    if (script.segments[i].isIntro) {
      if (introBgVisual === undefined) {
        introBgVisual = await fetchVisualForSegment({ query: INTRO_BG_QUERY }, runDir, i).catch(() => null);
      }
      visual = { type: "title-card", lines: introCardLines, fontsize: 58, bgVisual: introBgVisual };
      console.log(`  segment ${i}: intro card — "${script.segments[i].text}" (${timing.durationSec.toFixed(1)}s)${introBgVisual ? "" : " [no bg photo found, using flat card]"}`);
    } else if (script.segments[i].isOutro) {
      const bgVisual = await fetchVisualForSegment({ query: OUTRO_BG_QUERY }, runDir, i).catch(() => null);
      visual = { type: "title-card", lines: OUTRO_CARD_LINES, bgVisual };
      console.log(`  segment ${i}: outro card (${timing.durationSec.toFixed(1)}s)${bgVisual ? "" : " [no bg photo found, using flat card]"}`);
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

      // Top-10 style rank badge: number + flag + country name, bottom-left,
      // only when this segment has a country code Gemini gave us — silently
      // skipped (no badge) if the flag download fails for any reason.
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

  const outputPath = path.join(runDir, "final.mp4");
  console.log("[ffmpeg] assembling synced video (with voiced intro/outro)...");
  await buildDocumentary(segmentsForBuild, audioPath, path.join(runDir, "work"), outputPath, null, { theme });
  console.log(`[done] video ready: ${outputPath}`);

  if (NO_UPLOAD) {
    console.log("[upload] skipped (--no-upload)");
    return;
  }

  console.log("[upload] pushing to NEXTSCENE TV...");
  const coveredPlaces = [...new Set(script.segments.map((s) => s.location).filter(Boolean))];
  const hashtags = buildHashtags(script.keywords, ["#geopolitics", "#top10", "#futurepredictions"]);
  const tags = buildTags(script.keywords, coveredPlaces, ["top10", "geopolitics", "future predictions", "documentary"]);
  const description = [
    script.title,
    "",
    script.commentary || "Auto-narrated documentary breakdown for NEXTSCENE TV — the future uncovered.",
    coveredPlaces.length ? `Covering: ${coveredPlaces.join(", ")}.` : "",
    "",
    "Subscribe for more Top 10 rankings, power comparisons, and future predictions.",
    "",
    hashtags.join(" "),
  ]
    .filter(Boolean)
    .join("\n");
  const uploaded = await uploadToYouTube(outputPath, script.title, description, { tags });
  console.log(`[upload] done: https://youtube.com/watch?v=${uploaded.id}`);

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
