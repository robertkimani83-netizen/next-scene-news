// Main pipeline: topic -> documentary script (Gemini) -> human-sounding
// narration with exact timing (msedge-tts) -> real video clips/photos per
// segment (Pexels/Unsplash) -> assembled synced video (ffmpeg) -> uploaded
// to the NEXTSCENE TV YouTube channel (reusing the OAuth refresh token
// already set up for the VOX254 pipeline, since it's the same channel).
//
// Required environment variables (all already exist as secrets in the
// next-scene-news repo except TOPIC_LIST, which is optional):
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
import { fetchVisualForSegment } from "./lib/visuals.mjs";
import { buildDocumentary } from "./lib/ffmpeg-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const NO_UPLOAD = process.argv.includes("--no-upload");

// NextScene TV's existing lane: Top 10 rankings, country/power comparisons,
// "what's coming next" style predictions. Rotate through these so the topic
// picker doesn't repeat itself; extend this list freely.
const TOPIC_POOL = [
  "Top 10 countries with the most powerful militaries in the world right now",
  "Top 10 fastest growing economies in the world and why they're rising",
  "Top 10 richest countries in Africa by GDP",
  "The countries most likely to become superpowers by 2050",
  "Top 10 cities in the world investing the most in future technology",
  "Top 10 countries with the largest oil and gas reserves",
  "The most powerful passports in the world and what they reveal about global power",
];

function pickTopic() {
  return TOPIC_POOL[Math.floor(Math.random() * TOPIC_POOL.length)];
}

/** Ask Gemini for a documentary script broken into narratable sentences,
 * each paired with a short visual search phrase. Falls back across a few
 * free Gemini models the same way the VOX254 pipeline does. */
async function generateScript(topic) {
  const prompt = `Write a short documentary-style narration script (about 60-90 seconds spoken, roughly 150-220 words) on this topic: "${topic}".

Style: authoritative, cinematic, "NEXTSCENE TV - THE FUTURE UNCOVERED" tone — the kind of voice-over used in geopolitics/future-predictions YouTube videos. Short punchy sentences. No intro pleasantries, start directly with a hook.

Return ONLY valid JSON, no markdown fences, in this exact shape:
{
  "title": "a short punchy YouTube title, under 70 characters",
  "segments": [
    { "text": "one narration sentence", "visualQuery": "2-5 word stock footage search phrase for this sentence, e.g. 'Shanghai skyline night'" }
  ]
}
Each segment.text should be ONE sentence. Aim for 10-16 segments total.`;

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

async function uploadToYouTube(videoPath, title, description) {
  const { google } = await import("googleapis");
  const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: process.env.YOUTUBE_REFRESH_TOKEN });
  const youtube = google.youtube({ version: "v3", auth: oauth2Client });

  const res = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title,
        description,
        tags: ["geopolitics", "top10", "future predictions", "world power ranking"],
        categoryId: "25", // News & Politics
      },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    },
    media: { body: (await import("node:fs")).createReadStream(videoPath) },
  });
  return res.data;
}

async function main() {
  const runDir = path.join(__dirname, "..", "tmp", `run_${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });

  const topic = pickTopic();
  console.log(`[topic] ${topic}`);

  console.log("[script] generating with Gemini...");
  const script = await generateScript(topic);
  console.log(`[script] title: ${script.title} (${script.segments.length} segments)`);

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
  for (let i = 0; i < script.segments.length; i++) {
    const timing = sentences[i] ?? {
      // fallback: split total narration duration evenly if boundaries misaligned
      durationSec: (sentences.at(-1)?.startSec + sentences.at(-1)?.durationSec || 60) / script.segments.length,
    };
    const visual = await fetchVisualForSegment(script.segments[i].visualQuery, runDir, i).catch((err) => {
      console.warn(`[visuals] segment ${i} ("${script.segments[i].visualQuery}") failed: ${err.message}`);
      return null;
    });
    console.log(`  segment ${i}: ${visual ? visual.type : "NO VISUAL FOUND"} — "${script.segments[i].visualQuery}" (${timing.durationSec.toFixed(1)}s)`);
    segmentsForBuild.push({ visual, durationSec: timing.durationSec });
  }

  const outputPath = path.join(runDir, "final.mp4");
  console.log("[ffmpeg] assembling synced video...");
  await buildDocumentary(segmentsForBuild, audioPath, path.join(runDir, "work"), outputPath);
  console.log(`[done] video ready: ${outputPath}`);

  if (NO_UPLOAD) {
    console.log("[upload] skipped (--no-upload)");
    return;
  }

  console.log("[upload] pushing to NEXTSCENE TV...");
  const description = `${script.title}\n\nAuto-narrated documentary breakdown. Subscribe for more.\n\n#geopolitics #top10 #futurepredictions`;
  const uploaded = await uploadToYouTube(outputPath, script.title, description);
  console.log(`[upload] done: https://youtube.com/watch?v=${uploaded.id}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
