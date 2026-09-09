// AI-generated, Canva-style bold YouTube thumbnails — a fresh custom design
// for every video instead of a plain frame grabbed out of the finished video
// (which is what extractThumbnail in ffmpeg-build.mjs does, and stays here
// as the fallback if this ever fails).
//
// Why this isn't a live Canva API integration: Robert asked for Canva
// specifically, but Canva's Connect API needs a registered developer app
// plus a one-time OAuth browser consent and ongoing refresh-token management
// — that's a manual setup step only Robert can do in Canva's own dashboard,
// and it doesn't fit an unattended GitHub Actions run the way a plain API
// key does. This gets the same real result (a bold, high-contrast, unique
// thumbnail per video, no reused template) a different way: Gemini (the
// same GEMINI_API_KEY already used for script generation — no new secret
// needed) generates a cinematic, text-free background image matching the
// video's topic, then ffmpeg (already installed in this pipeline) burns in
// the bold branded headline + wordmark, the same way the video's own title
// cards are built in ffmpeg-build.mjs.
//
// Always outputs 1280x720 — YouTube's fixed custom-thumbnail size,
// regardless of whether the video itself is landscape or portrait.

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const THUMB_WIDTH = 1280;
const THUMB_HEIGHT = 720;

// A few plausible current Gemini image-generation model IDs, tried in order
// — the same defensive multi-model fallback pattern already used in
// script-gen.mjs (see its note on the Aug 2026 gemini-2.0/1.5 deprecation).
// Keeps this working even if Google renames or retires any one of these.
const IMAGE_MODELS = ["gemini-2.5-flash-image", "gemini-3-pro-image", "gemini-3.1-flash-image"];

async function ffmpeg(args) {
  try {
    return await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

// Same textfile= approach as ffmpeg-build.mjs — verified there to be the
// only reliable way to get drawtext to render text containing apostrophes/
// quotes with this ffmpeg build (inline quoted filtergraph text silently
// produced blank output on a real title with an apostrophe).
function escapeFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
async function writeDrawtextFile(text, filePath) {
  await fs.writeFile(filePath, text, "utf-8");
  return filePath;
}

/** Average glyph width for DejaVu Sans Bold uppercase text, measured by
 * actually rendering sample strings at several sizes with this exact font/
 * weight and pixel-measuring the result (this font's bold caps run much
 * wider than a generic 0.5-0.6x-fontsize guess — real measurement came out
 * to ~0.71-0.72x; 0.76 keeps a small safety margin so wrapping never lets a
 * line run off either edge). */
function estimateCharWidth(fontSize) {
  return fontSize * 0.76;
}

function wrapText(text, maxCharsPerLine) {
  const words = text.trim().split(/\s+/).filter(Boolean);
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
  return lines;
}

/** Picks the largest font size (from a descending list) that wraps the
 * headline into at most 3 lines within the usable width, so a short title
 * reads big and a long one still fits without running off the frame edge —
 * ffmpeg's drawtext does not auto-wrap or auto-shrink text on its own. */
function fitHeadline(title, usableWidth) {
  const sizes = [80, 68, 58, 48, 40];
  for (const fontSize of sizes) {
    const maxChars = Math.max(1, Math.floor(usableWidth / estimateCharWidth(fontSize)));
    const lines = wrapText(title, maxChars);
    if (lines.length <= 3) return { fontSize, lines };
  }
  const fontSize = sizes[sizes.length - 1];
  const maxChars = Math.max(1, Math.floor(usableWidth / estimateCharWidth(fontSize)));
  return { fontSize, lines: wrapText(title, maxChars) };
}

/** Asks Gemini for a cinematic, TEXT-FREE background image matching the
 * video's topic. Explicitly told to render no words/logos — image models
 * render text unreliably (misspellings, garbled letters), and a bad word
 * baked into the pixels can't be fixed afterward, so all real text is added
 * separately below with ffmpeg drawtext instead. */
async function generateBackgroundImage(prompt, outPath) {
  let lastErr;
  for (const model of IMAGE_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ["IMAGE"] },
          }),
        }
      );
      if (!res.ok) throw new Error(`${model} responded ${res.status}: ${await res.text().catch(() => "")}`);
      const data = await res.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const imgPart = parts.find((p) => p.inlineData?.data);
      if (!imgPart) throw new Error("no image data in response");
      await fs.writeFile(outPath, Buffer.from(imgPart.inlineData.data, "base64"));
      return outPath;
    } catch (err) {
      lastErr = err;
      console.warn(`[thumbnail] ${model} failed: ${err.message}, trying next model...`);
    }
  }
  throw new Error(`all Gemini image models failed: ${lastErr?.message}`);
}

/**
 * Generates a bold, Canva-style YouTube thumbnail: an AI background image
 * relevant to the video's topic, dimmed behind a bottom band for legibility,
 * a large bold outlined headline, a colored accent bar, and the channel's
 * wordmark badge top-left — matching the high-contrast look of the hand-made
 * thumbnails Robert used as reference. Non-fatal: returns null (never
 * throws) on any failure so a broken/rate-limited image call can never break
 * the upload — the caller falls back to extractThumbnail's video frame grab.
 *
 * @param {{title: string, topic: string, outDir: string, theme?: {wordmarkBg: string, accent: string}}} opts
 * @returns {Promise<string|null>} path to the finished JPG, or null
 */
export async function generateAiThumbnail({ title, topic, outDir, theme }) {
  if (!GEMINI_API_KEY) {
    console.warn("[thumbnail] GEMINI_API_KEY not set, skipping AI thumbnail");
    return null;
  }
  try {
    await fs.mkdir(outDir, { recursive: true });
    const bgPath = path.join(outDir, "thumb_bg.png");
    const imagePrompt =
      `A dramatic, cinematic, photo-realistic editorial wide shot illustrating this topic: "${topic}". ` +
      `Style: bold high-contrast color grading, epic scale, the kind of striking image used on major news/documentary YouTube channel thumbnails. ` +
      `Absolutely NO text, words, letters, numbers, captions, logos, or watermarks anywhere in the image — a clean photographic background only.`;
    await generateBackgroundImage(imagePrompt, bgPath);

    const t = theme || { wordmarkBg: "0xE21C21", accent: "0xFFD700" };
    const headline = (title || "").toUpperCase();
    const usableWidth = THUMB_WIDTH - 120; // 60px margin each side
    const { fontSize, lines } = fitHeadline(headline, usableWidth);

    const headlineFile = await writeDrawtextFile(lines.join("\n"), path.join(outDir, "thumb_headline.txt"));
    const wordmarkFile = await writeDrawtextFile("NEXTSCENE TV", path.join(outDir, "thumb_wordmark.txt"));

    const bandTop = Math.round(THUMB_HEIGHT * 0.52);
    const bandHeight = THUMB_HEIGHT - bandTop;

    const filter = [
      `[0:v]scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=increase,crop=${THUMB_WIDTH}:${THUMB_HEIGHT}[bg]`,
      // dark gradient-style band behind the headline so it stays legible over a busy photo
      `[bg]drawbox=x=0:y=${bandTop}:w=${THUMB_WIDTH}:h=${bandHeight}:color=black@0.55:t=fill[dimmed]`,
      // thin colored accent bar along the very bottom edge, matching the channel's card-theme accent
      `[dimmed]drawbox=x=0:y=${THUMB_HEIGHT - 14}:w=${THUMB_WIDTH}:h=14:color=${t.accent}:t=fill[banded]`,
      `[banded]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(headlineFile)}:fontcolor=white:fontsize=${fontSize}:line_spacing=8:bordercolor=${t.accent}:borderw=7:x=(w-text_w)/2:y=h-text_h-34[b1]`,
      `[b1]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(wordmarkFile)}:fontcolor=white:fontsize=30:box=1:boxcolor=${t.wordmarkBg}:boxborderw=14:x=40:y=40[b2]`,
    ].join(";");

    const outPath = path.join(outDir, "thumb_ai.jpg");
    await ffmpeg(["-i", bgPath, "-filter_complex", filter, "-map", "[b2]", "-frames:v", "1", "-q:v", "2", outPath]);

    return outPath;
  } catch (err) {
    console.warn(`[thumbnail] AI thumbnail generation failed, will fall back to a video frame grab: ${err.message}`);
    return null;
  }
}
