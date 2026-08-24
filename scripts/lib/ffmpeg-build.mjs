// Builds the final documentary-style video: each narration segment gets its
// real video clip or photo (from visuals.mjs) shown for exactly as long as
// that sentence takes to narrate (from tts.mjs's timing), then everything is
// concatenated and the narration track is laid on top. Photos get a subtle
// Ken Burns pan/zoom so a still image doesn't look static next to real clips.
//
// Assumes `ffmpeg` is on PATH (installed via `apt-get install -y ffmpeg` in
// the GitHub Actions workflow — the same approach already working for the
// VOX254 news-video pipeline, avoiding the ffmpeg-static ENOENT issues hit
// on Vercel).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const WIDTH = 1920;
const HEIGHT = 1080;

async function ffmpeg(args) {
  try {
    return await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

/** Turns one segment's visual into a silent, fixed-duration 1080p clip. */
async function renderSegmentClip(visual, durationSec, outPath) {
  const dur = Math.max(durationSec, 0.6).toFixed(2); // floor so ultra-short sentences still show something

  if (visual.type === "video") {
    await ffmpeg([
      "-stream_loop", "-1", // loop the source clip if it's shorter than needed
      "-i", visual.path,
      "-t", dur,
      "-vf", `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,crop=${WIDTH}:${HEIGHT},fps=30`,
      "-an",
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      outPath,
    ]);
    return;
  }

  // image -> slow Ken Burns zoom/pan over the exact segment duration
  const frames = Math.round(parseFloat(dur) * 30);
  await ffmpeg([
    "-loop", "1",
    "-i", visual.path,
    "-t", dur,
    "-vf",
      `scale=${WIDTH * 1.3}:${HEIGHT * 1.3}:force_original_aspect_ratio=increase,` +
      `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${WIDTH}x${HEIGHT}:fps=30`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/**
 * @param {Array<{visual: {type:string,path:string}|null, durationSec: number}>} segments
 * @param {string} narrationAudioPath
 * @param {string} workDir - scratch directory for intermediate files
 * @param {string} outputPath - final MP4 path
 * @param {string|null} placeholderImage - branded fallback image path used when a segment has no visual
 */
export async function buildDocumentary(segments, narrationAudioPath, workDir, outputPath, placeholderImage = null) {
  await fs.mkdir(workDir, { recursive: true });

  const clipPaths = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const visual = seg.visual ?? (placeholderImage ? { type: "image", path: placeholderImage } : null);
    if (!visual) continue; // no visual and no placeholder configured — skip rather than break the video

    const clipPath = path.join(workDir, `segment_${i}.mp4`);
    await renderSegmentClip(visual, seg.durationSec, clipPath);
    clipPaths.push(clipPath);
  }

  if (clipPaths.length === 0) {
    throw new Error("no visuals were found for any segment — nothing to build");
  }

  // concat all segment clips (concat demuxer requires a list file)
  const listFile = path.join(workDir, "concat_list.txt");
  await fs.writeFile(listFile, clipPaths.map((p) => `file '${path.resolve(p)}'`).join("\n"));

  const visualsOnly = path.join(workDir, "visuals_concat.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", visualsOnly]);

  // lay the narration track on top; -shortest guards against tiny drift
  await ffmpeg([
    "-i", visualsOnly,
    "-i", narrationAudioPath,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest",
    outputPath,
  ]);

  return outputPath;
}
