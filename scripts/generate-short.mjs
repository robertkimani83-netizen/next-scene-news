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
import { buildDocumentary, PORTRAIT_DIMS } from "./lib/ffmpeg-build.mjs";
import { generateScript } from "./lib/script-gen.mjs";
import { pickAndRecordTopic } from "./lib/topic-history.mjs";
import { uploadToYouTube } from "./lib/youtube.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_UPLOAD = process.argv.includes("--no-upload");

// state/topic-history-short.json is committed back to the repo after a real
// run (see the "Save topic history" step in generate-short.yml) so the
// least-recently-used picker (lib/topic-history.mjs) has real memory across
// separate Actions runs.
const TOPIC_HISTORY_PATH = path.join(__dirname, "..", "state", "topic-history-short.json");

// Punchy single-fact/single-country topics — deliberately NOT full Top-10
// lists (those need the full ~60-90s runtime to land). 30 topics at 3
// Shorts/day means the pool cycles roughly every 10 days before any topic
// repeats — extend freely, the picker adapts automatically.
const SHORT_TOPIC_POOL = [
  "Why Monaco has no income tax and how its economy actually works",
  "The country with the highest number of billionaires per capita",
  "Why Singapore became one of the richest countries in the world",
  "The smallest country in the world with the strongest economy",
  "Why Norway's oil fund is the largest sovereign wealth fund on Earth",
  "The country that prints more money than any other in the world",
  "Why Switzerland stays neutral and still gets incredibly rich",
  "The African country with the fastest growing economy right now",
  "Why Dubai built one of the richest cities out of a desert",
  "The country with the most gold reserves per citizen",
  "Why Iceland has almost zero crime and one of the happiest populations",
  "The country spending the most on artificial intelligence right now",
  "Why Qatar became one of the wealthiest nations per capita",
  "The country with the world's most powerful passport",
  "Why Estonia is called the most digital country on Earth",
  "The country building the world's tallest and most futuristic skyline",
  "Why Luxembourg has the highest GDP per capita in the world",
  "The country where robots outnumber factory workers",
  "Why New Zealand keeps topping the world's safest countries list",
  "The tiny country that controls a huge share of the world's shipping",
  "Why Ireland became a tax haven for the world's biggest tech companies",
  "The country with more sheep than people",
  "Why Taiwan makes almost all the world's advanced computer chips",
  "The country spending the most per person on renewable energy",
  "Why Finland is ranked the happiest country on Earth",
  "The smallest economy that punches way above its weight",
  "Why South Korea became a global entertainment and tech powerhouse",
  "The country with the world's largest sovereign gold reserve per capita",
  "Why Rwanda is called Africa's cleanest and safest country",
  "The nation betting its entire future on artificial intelligence",
];

// Background photo behind the intro card — same idea as the long-form
// pipeline's INTRO_BG_QUERY; non-fatal if nothing is found, renderTitleCard
// falls back to a flat card automatically.
const INTRO_BG_QUERY = "futuristic city skyline night aerial";

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

  const fullNarration = script.segments.map((s) => s.text).join(" ");
  console.log("[tts] synthesizing narration (en-US-ChristopherNeural)...");
  const { audioPath, sentences } = await synthesizeNarration(fullNarration, runDir);

  if (sentences.length !== script.segments.length) {
    console.warn(
      `[tts] warning: got ${sentences.length} sentence boundaries but ${script.segments.length} script segments — ` +
      `TTS sentence splitting doesn't always match 1:1. Falling back to even time distribution.`
    );
  }

  console.log("[visuals] fetching real clips/photos per segment (portrait)...");
  const segmentsForBuild = [];
  for (let i = 0; i < script.segments.length; i++) {
    const timing = sentences[i] ?? {
      durationSec: (sentences.at(-1)?.startSec + sentences.at(-1)?.durationSec || 30) / script.segments.length,
    };
    let visual;
    if (script.segments[i].isIntro) {
      const bgVisual = await fetchVisualForSegment({ query: INTRO_BG_QUERY }, runDir, i).catch(() => null);
      visual = { type: "title-card", lines: introCardLines, fontsize: 58, bgVisual };
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

  const outputPath = path.join(runDir, "final_short.mp4");
  console.log("[ffmpeg] assembling synced portrait video...");
  await buildDocumentary(segmentsForBuild, audioPath, path.join(runDir, "work"), outputPath, null, {
    dims: PORTRAIT_DIMS,
  });

  const totalSec = segmentsForBuild.reduce((sum, s) => sum + Math.max(s.durationSec, 0.6), 0);
  console.log(`[done] short ready: ${outputPath} (~${totalSec.toFixed(1)}s)`);
  if (totalSec > 60) {
    console.warn(`[warn] this short is ${totalSec.toFixed(1)}s — over 60s risks YouTube not treating it as a Short.`);
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
  const description = `${script.title}\n\n#Shorts #geopolitics #futurepredictions`;
  const uploaded = await uploadToYouTube(outputPath, title, description, {
    tags: ["shorts", "geopolitics", "top10", "future predictions"],
  });
  console.log(`[upload] done: https://youtube.com/watch?v=${uploaded.id}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
