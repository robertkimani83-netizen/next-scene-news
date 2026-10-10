// NEXTSCENE TV daily "Kenya story" Short (Oct 10 2026).
//
// Replaces the old "money & power" Shorts (scripts/generate-short.mjs),
// which got no views once the channel moved to Kenya / KOT stories.
//
// Each run:
//  1. Asks the VOX254 site for today's top unused Kenya story that has a
//     REAL news photo (app/api/social/next-yt-short-article). No story =
//     no Short that day. It never falls back to stock footage.
//  2. Has Gemini write a 35-50 second Kenyan-English narration that sticks
//     to the facts in the article (serious tone for serious news, light
//     KOT humour only for light stories), plus title, description and tags.
//  3. Narrates it with a Kenyan English voice, builds a 1080x1920 video
//     from the real photo with a hook line and timed captions.
//  4. Uploads it to YouTube (privacy from YOUTUBE_PRIVACY, private by
//     default so the owner reviews it first).
//
// Env: SITE_URL, CRON_SECRET, GEMINI_API_KEY, GOOGLE_CLIENT_ID,
//      GOOGLE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, YOUTUBE_PRIVACY.
//
//   node scripts/generate-kenya-short.mjs --no-upload

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_UPLOAD = process.argv.includes("--no-upload");

const W = 1080;
const H = 1920;
const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const VOICE = "en-KE-ChilembaNeural";
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const OUTRO_TEXT = "Follow NEXTSCENE TV for more Kenya stories";
const OUTRO_SEC = 2.2;

// ---------- helpers ----------

export function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

async function ffmpeg(args) {
  try {
    return await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

async function getArticle() {
  const res = await fetch(`${process.env.SITE_URL}/api/social/next-yt-short-article`, {
    headers: { Authorization: `Bearer ${(process.env.CRON_SECRET || "").trim()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`next-yt-short-article responded ${res.status}: ${await res.text()}`);
  return res.json();
}

async function downloadTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// ---------- script writing ----------

function fallbackScript(article) {
  const sentences = `${article.title}. ${article.teaser} ${article.article || ""}`
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+/g) || [article.title];
  const narration = [];
  let words = 0;
  for (const s of sentences) {
    const t = s.trim();
    if (!t || narration.includes(t)) continue;
    narration.push(t);
    words += t.split(/\s+/).length;
    if (words >= 95) break;
  }
  return {
    title: article.title.slice(0, 88),
    hook: article.title.split(/\s+/).slice(0, 6).join(" ").toUpperCase(),
    narration,
    description: article.teaser,
    tags: ["kenya", "kenya news", "kenyans on x", "kot", "nairobi"],
  };
}

export function validateScript(s) {
  if (!s || typeof s !== "object") throw new Error("not an object");
  if (typeof s.title !== "string" || s.title.length < 10) throw new Error("bad title");
  if (typeof s.hook !== "string" || !s.hook.trim()) throw new Error("bad hook");
  if (!Array.isArray(s.narration) || s.narration.length < 4) throw new Error("narration too short");
  const words = s.narration.join(" ").split(/\s+/).length;
  if (words < 60 || words > 150) throw new Error(`narration has ${words} words`);
  if (typeof s.description !== "string") s.description = "";
  if (!Array.isArray(s.tags)) s.tags = [];
  return s;
}

async function writeScript(article) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallbackScript(article);

  const prompt = `You write YouTube Shorts for NEXTSCENE TV, a Kenyan channel known for Kenya stories and KOT (Kenyans on X) culture.

Write a Short about this news story. Use ONLY facts in the story below. Do not add numbers, names, quotes or claims that are not in it. If something is alleged or claimed, say who claims it.

TONE: Kenyan English, conversational, like telling a friend. If the story involves death, injury, crime, disaster, illness or grief, keep it serious and respectful with no jokes. Only if the story is light (politics drama, celebrities, online wars, viral moments) you may add one light, clever KOT-style line.

Return ONLY JSON:
{
  "title": "YouTube title, max 85 characters, curiosity hook, one emoji at most, no hashtags",
  "hook": "on-screen hook, 3-6 words, ALL CAPS",
  "narration": ["6 to 9 short sentences, 85-120 words total. Sentence 1 is a hook that makes people stay. Last sentence asks viewers a question to answer in the comments."],
  "description": "2-3 sentence YouTube description",
  "tags": ["8-12 search tags"]
}

STORY HEADLINE: ${article.title}
TEASER: ${article.teaser}
FULL STORY:
${(article.article || "").slice(0, 6000)}`;

  for (let pass = 1; pass <= 3; pass++) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          },
        );
        if (!res.ok) throw new Error(`${model} responded ${res.status}`);
        const data = await res.json();
        const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text ?? "")
          .trim()
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "");
        return validateScript(JSON.parse(raw));
      } catch (err) {
        console.warn(`[script] ${model} failed (pass ${pass}/3): ${err.message}`);
      }
    }
    if (pass < 3) await new Promise((r) => setTimeout(r, 5000 * pass));
  }
  console.warn("[script] all Gemini models failed, using the article text directly");
  return fallbackScript(article);
}

// ---------- video ----------

/**
 * Builds the vertical video.
 * @param {{photoPath:string, audioPath:string, hook:string, captions:{text:string,start:number,end:number}[], credit:string, totalSec:number, outPath:string, workDir:string}} o
 */
export async function buildVideo(o) {
  const files = [];
  const tf = async (name, text) => {
    const p = path.join(o.workDir, name);
    await fs.writeFile(p, text, "utf-8");
    files.push(p);
    return escapeFilterPath(p);
  };

  const hookFile = await tf("hook.txt", wrapText(o.hook.toUpperCase(), 16));
  const brandFile = await tf("brand.txt", "NEXTSCENE TV");
  const creditFile = await tf("credit.txt", o.credit ? `Photo: ${o.credit}`.slice(0, 70) : "");
  const outroFile = await tf("outro.txt", wrapText(OUTRO_TEXT, 22));

  const dur = o.totalSec.toFixed(2);
  const chain = [
    `[0:v]split[a][b]`,
    // Blurred, darkened full-screen background from the same photo.
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.22,setsar=1[bg]`,
    // The real photo itself, fitted into the middle with a slow push-in.
    `[b]scale=1040:860:force_original_aspect_ratio=decrease,setsar=1[fg0]`,
    `[fg0]scale=w='trunc(iw*(1+0.06*t/${dur})/2)*2':h=-2:eval=frame[fg]`,
    `[bg][fg]overlay=x=(W-w)/2:y=530+(860-h)/2:shortest=0[v0]`,
    `[v0]drawbox=x=0:y=150:w=${W}:h=330:color=black@0.6:t=fill[v2]`,
    `[v2]drawtext=fontfile=${FONT_BOLD}:textfile='${hookFile}':fontcolor=#FFD400:fontsize=84:line_spacing=12:x=(w-text_w)/2:y=190:borderw=4:bordercolor=black[v3]`,
    `[v3]drawtext=fontfile=${FONT_BOLD}:textfile='${brandFile}':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=80:borderw=3:bordercolor=black[v4]`,
    `[v4]drawtext=fontfile=${FONT_REGULAR}:textfile='${creditFile}':fontcolor=white@0.85:fontsize=26:x=(w-text_w)/2:y=h-70:borderw=2:bordercolor=black[v5]`,
  ];

  let last = "v5";
  let n = 0;
  for (const c of o.captions) {
    const f = await tf(`cap${n}.txt`, wrapText(c.text, 24));
    const next = `c${n}`;
    chain.push(
      `[${last}]drawtext=fontfile=${FONT_BOLD}:textfile='${f}':fontcolor=white:fontsize=58:line_spacing=10:` +
        `x=(w-text_w)/2:y=1450:box=1:boxcolor=black@0.55:boxborderw=22:borderw=3:bordercolor=black:` +
        `enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[${next}]`,
    );
    last = next;
    n++;
  }
  const outroStart = (o.totalSec - OUTRO_SEC).toFixed(2);
  chain.push(
    `[${last}]drawtext=fontfile=${FONT_BOLD}:textfile='${outroFile}':fontcolor=#FFD400:fontsize=62:line_spacing=10:` +
      `x=(w-text_w)/2:y=1450:box=1:boxcolor=black@0.7:boxborderw=24:enable='gte(t,${outroStart})'[vout]`,
  );

  await ffmpeg([
    "-loop", "1", "-framerate", "30", "-i", o.photoPath,
    "-i", o.audioPath,
    "-filter_complex", chain.join(";"),
    "-map", "[vout]", "-map", "1:a",
    "-t", dur,
    "-r", "30",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-af", "apad",
    o.outPath,
  ]);
  return o.outPath;
}

/** Turns narration sentence timings into caption windows, splitting long
 * sentences into two halves so each caption stays short on screen. */
export function captionsFromSentences(sentences) {
  const caps = [];
  for (const s of sentences) {
    const start = s.startSec;
    const end = s.startSec + s.durationSec;
    const words = s.text.trim().split(/\s+/);
    if (words.length > 12) {
      const mid = Math.ceil(words.length / 2);
      const t = start + (end - start) * (mid / words.length);
      caps.push({ text: words.slice(0, mid).join(" "), start, end: t });
      caps.push({ text: words.slice(mid).join(" "), start: t, end });
    } else caps.push({ text: words.join(" "), start, end });
  }
  return caps;
}

// ---------- main ----------

async function main() {
  const runDir = path.join(__dirname, "..", "tmp", `kenyashort_${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });

  console.log("[article] asking VOX254 for today's top Kenya story with a real photo...");
  const article = await getArticle();
  if (!article) {
    console.log("No suitable Kenya story with a real photo today. Skipping (no stock fallback).");
    return;
  }
  console.log(`[article] "${article.title}" (${article.importance}, ${article.sourceName})`);

  const photoPath = await downloadTo(article.imageUrl, path.join(runDir, "photo.jpg"));

  const script = await writeScript(article);
  console.log(`[script] title: ${script.title}`);

  const { synthesizeNarration } = await import("./lib/tts.mjs");
  const text = script.narration.join(" ");
  const { audioPath, sentences } = await synthesizeNarration(text, runDir, VOICE);
  const speechEnd = (sentences.at(-1)?.startSec ?? 0) + (sentences.at(-1)?.durationSec ?? 0);
  const totalSec = Math.min(Math.max(speechEnd + 0.4, 20) + OUTRO_SEC, 59);

  const outPath = path.join(runDir, "final_short.mp4");
  await buildVideo({
    photoPath,
    audioPath,
    hook: script.hook,
    captions: captionsFromSentences(sentences),
    credit: article.photoCredit || "",
    totalSec,
    outPath,
    workDir: runDir,
  });
  console.log(`[done] ${outPath} (${totalSec.toFixed(1)}s)`);

  if (NO_UPLOAD) {
    console.log("[upload] skipped (--no-upload)");
    return;
  }

  const { uploadToYouTube, getOrCreatePlaylist, addVideoToPlaylist } = await import("./lib/youtube.mjs");
  const title = `${script.title.replace(/#\w+/g, "").trim()} #Shorts`.slice(0, 100);
  const description = [
    script.description,
    "",
    `Full story: ${article.articleUrl}`,
    article.photoCredit ? `Photo: ${article.photoCredit}` : "",
    "",
    "Follow NEXTSCENE TV for more Kenya stories 🇰🇪",
    "",
    "#Kenya #KenyaNews #KOT #Shorts",
  ]
    .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
    .join("\n");
  const tags = [...new Set([...(script.tags || []), "kenya", "kenya news", "kot", "nextscene tv"])].slice(0, 15);

  const result = await uploadToYouTube(outPath, title, description, { tags, categoryId: "25" });
  console.log(`[upload] uploaded: https://youtu.be/${result.id} (${result.status?.privacyStatus})`);

  try {
    const pl = await getOrCreatePlaylist("Kenya Stories — NEXTSCENE TV", "Daily Kenya stories in under a minute.");
    await addVideoToPlaylist(pl, result.id);
  } catch (err) {
    console.warn(`[playlist] skipped: ${err.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}
