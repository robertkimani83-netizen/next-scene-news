// AI-generated, bold documentary/news-style YouTube thumbnails — a fresh
// custom design for every video instead of a plain frame grabbed out of the
// finished video (extractThumbnail in ffmpeg-build.mjs stays as the
// non-fatal fallback if this ever fails).
//
// The real compositing work lives in thumbnail_compositor.py (Python +
// Pillow) — this file is a thin wrapper that shells out to it and keeps the
// exact same exported signature (generateAiThumbnail({title, topic, outDir,
// theme}) -> path | null) the video pipelines already call, so
// generate-documentary.mjs and generate-short.mjs need no changes at all.
//
// Pipeline (see thumbnail_compositor.py for the real implementation):
//   title -> Gemini analyzes it (image prompt + per-word color plan)
//         -> FLUX.1-schnell (Hugging Face Inference Providers) paints the
//            background, told explicitly to render NO text/logos
//         -> Pillow burns in the real bold headline, outlines/glow, a
//            category tag, and the channel's own assets/logo.png
//
// Env vars used by the Python script (must be in the caller's environment —
// GitHub Actions secrets, already the case for GEMINI_API_KEY; HF_TOKEN is
// new, see the workflow files): GEMINI_API_KEY, HF_TOKEN.

import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COMPOSITOR_PATH = path.join(__dirname, "thumbnail_compositor.py");

/**
 * Generates ONE AI thumbnail for a video and returns its path, or null on
 * any failure (never throws) — the caller (generate-documentary.mjs /
 * generate-short.mjs) falls back to extractThumbnail's video-frame grab.
 *
 * @param {{title: string, topic?: string, outDir: string, theme?: object}} opts
 *   `topic` and `theme` are accepted for backward compatibility with the
 *   existing call sites but aren't required by the new pipeline — the title
 *   alone drives Gemini's analysis and the FLUX prompt.
 * @returns {Promise<string|null>}
 */
export async function generateAiThumbnail({ title, outDir }) {
  if (!title || !outDir) return null;
  try {
    await fs.mkdir(outDir, { recursive: true });
    const { stdout, stderr } = await run(
      "python3",
      [COMPOSITOR_PATH, "--title", title, "--variations", "1", "--out-dir", outDir],
      { env: process.env, maxBuffer: 1024 * 1024 * 16 }
    );
    if (stderr) {
      // the python script logs its own [thumbnail] progress/error lines to
      // stderr (never secrets) — surface them in the Actions log as-is
      console.log(stderr.trim());
    }
    const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
    if (!lastLine) return null;
    const summary = JSON.parse(lastLine);
    return summary.generated?.[0] || null;
  } catch (err) {
    console.warn(`[thumbnail] AI thumbnail generation failed, will fall back to a video frame grab: ${err.message}`);
    return null;
  }
}

/**
 * Generates multiple thumbnail variations for a given title — used by the
 * standalone generate-thumbnail.yml workflow (on-demand, by title, not part
 * of the video pipelines). Returns the list of generated file paths
 * (possibly fewer than requested if some variations failed — the python
 * script continues past a single failed variation rather than aborting).
 *
 * @param {{title: string, outDir: string, variations?: number, style?: string}} opts
 * @returns {Promise<string[]>}
 */
export async function generateAiThumbnailVariations({ title, outDir, variations = 3, style }) {
  await fs.mkdir(outDir, { recursive: true });
  const args = [COMPOSITOR_PATH, "--title", title, "--variations", String(variations), "--out-dir", outDir];
  if (style) args.push("--style", style);
  const { stdout, stderr } = await run("python3", args, { env: process.env, maxBuffer: 1024 * 1024 * 16 });
  if (stderr) console.log(stderr.trim());
  const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
  if (!lastLine) return [];
  const summary = JSON.parse(lastLine);
  return summary.generated || [];
}
