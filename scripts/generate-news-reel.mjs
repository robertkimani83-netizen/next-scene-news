// VOX254 News Reels — turns the next trending Kenya/world article (same
// article pool the RSS/rewrite pipeline in app/api/cron already fills with
// real, current news) into a short vertical video and publishes it as a
// Facebook Reel on the VOX254 Page.
//
// Deliberately simple and self-contained: unlike the NEXTSCENE TV pipeline
// (scripts/generate-short.mjs, scripts/lib/ffmpeg-build.mjs), this does NOT
// reuse that pipeline's title-card renderer, because it hardcodes the
// NEXTSCENE TV wordmark + logo (scripts/lib/ffmpeg-build.mjs's
// renderTitleCard) — this script builds its own VOX254-branded frame
// (VOX254 logo + real article photo + headline) instead of touching that
// shared, differently-branded code.
//
// The visual is the article's OWN real, vision-verified news photo (from
// app/api/social/next-reel-article) — not stock b-roll — so every Reel is
// an actual current Kenya/world story with an eye-catching real photo, not
// a generic template.
//
// Required environment variables: SITE_URL, FACEBOOK_PAGE_ID,
// FACEBOOK_PAGE_ACCESS_TOKEN.
//
// Run locally to build without publishing:
//   node scripts/generate-news-reel.mjs --no-upload

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { synthesizeNarration } from "./lib/tts.mjs";
import { postFacebookReel } from "./lib/facebook-reel.mjs";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_UPLOAD = process.argv.includes("--no-upload");

const SITE_URL = process.env.SITE_URL;
const LOGO_PATH = path.join(__dirname, "..", "public", "vox254_logo.png");
const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const DIMS = { width: 1080, height: 1920 };

async function ffmpeg(args) {
  try {
    return await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

// Same reasoning as scripts/lib/ffmpeg-build.mjs: pointing drawtext at a
// plain text file (rather than an inline text='...' filtergraph value)
// sidesteps ffmpeg's filtergraph quoting entirely — verified elsewhere in
// this repo to be the only reliable way to render apostrophes/colons/
// commas in headlines without silently producing a blank frame.
async function writeDrawtextFile(text, filePath) {
  await fs.writeFile(filePath, text, "utf-8");
  return filePath;
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// Greedy word-wrap for the headline so it fits the portrait canvas width
// instead of running off-screen — drawtext has no built-in wrapping, but
// does render literal newlines in a textfile as separate lines.
function wrapText(text, maxCharsPerLine) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

async function getArticle() {
  const res = await fetch(`${SITE_URL}/api/social/next-reel-article`);
  if (!res.ok) return null;
  return res.json();
}

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return destPath;
}

async function main() {
  const runDir = path.join(__dirname, "..", "tmp", `newsreel_${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });

  console.log("[article] fetching next trending Kenya/world story...");
  const article = await getArticle();
  if (!article) {
    console.log("No unposted articles with a usable photo available. Stopping.");
    return;
  }
  console.log(`[article] "${article.title}"`);

  console.log("[photo] downloading real article photo...");
  const photoPath = await downloadTo(article.imageUrl, path.join(runDir, "photo.jpg"));

  const narrationText = `${article.title}. ${article.teaser || ""}`.trim();
  console.log("[tts] synthesizing narration (en-US-ChristopherNeural)...");
  const { audioPath, sentences } = await synthesizeNarration(narrationText, runDir);
  const totalSec = Math.max(
    (sentences.at(-1)?.startSec ?? 0) + (sentences.at(-1)?.durationSec ?? 0),
    6
  ) + 0.6; // small tail pad so the last word isn't cut off

  console.log(`[video] assembling ${totalSec.toFixed(1)}s portrait reel...`);
  const headlineFile = await writeDrawtextFile(
    wrapText(article.title, 21),
    path.join(runDir, "headline.txt")
  );
  const noteFile = await writeDrawtextFile(
    "Full story in comments",
    path.join(runDir, "note.txt")
  );

  const frames = Math.round(totalSec * 30);
  const outputPath = path.join(runDir, "final_reel.mp4");

  const filterComplex = [
    // Slow Ken Burns zoom on the real photo, filling the portrait canvas —
    // same proven filter parameters used elsewhere in this repo
    // (scripts/lib/ffmpeg-build.mjs) for photo segments.
    `[0:v]scale=${Math.round(DIMS.width * 1.3)}:${Math.round(DIMS.height * 1.3)}:force_original_aspect_ratio=increase,` +
      `zoompan=z='min(zoom+0.0006,1.15)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${DIMS.width}x${DIMS.height}:fps=30[bg]`,
    // Dark gradient-style band behind the headline so white text stays
    // legible over a busy news photo.
    `[bg]drawbox=x=0:y=1280:w=${DIMS.width}:h=${DIMS.height - 1280}:color=black@0.55:t=fill[b0]`,
    // vox254_logo.png has a plain white background baked in (no alpha
    // channel) - colorkey strips that white out so the logo sits directly
    // on the photo instead of inside a stark white box.
    `[1:v]colorkey=0xFFFFFF:0.15:0.05,scale=-1:130[logo]`,
    `[b0][logo]overlay=x=40:y=50[b1]`,
    `[b1]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(headlineFile)}:fontcolor=white:fontsize=58:line_spacing=10:x=50:y=1340[b2]`,
    `[b2]drawtext=fontfile=${FONT_REGULAR}:textfile=${escapeFilterPath(noteFile)}:fontcolor=#F2C94C:fontsize=32:x=50:y=h-90[b3]`,
  ].join(";");

  await ffmpeg([
    "-loop", "1", "-i", photoPath,
    "-loop", "1", "-i", LOGO_PATH,
    "-i", audioPath,
    "-filter_complex", filterComplex,
    "-map", "[b3]",
    "-map", "2:a",
    "-t", totalSec.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    outputPath,
  ]);

  console.log(`[done] reel ready: ${outputPath} (~${totalSec.toFixed(1)}s)`);

  if (NO_UPLOAD) {
    console.log("[upload] skipped (--no-upload)");
    return;
  }

  console.log("[upload] publishing to VOX254 Facebook Page as a Reel...");
  const caption = [article.title, "", "#Kenya #KenyaNews #VOX254"].join("\n");
  const reel = await postFacebookReel(outputPath, caption, article.articleUrl);
  console.log(`[upload] Facebook Reel published: id ${reel.reelId}`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
