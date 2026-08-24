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

function srtTimestamp(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const msRem = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(msRem, 3)}`;
}

/** Writes an SRT file whose timings match the actual on-screen segment
 * timeline built below (not the raw TTS boundaries), so captions always
 * land exactly on the clip they belong to even if a visual was skipped. */
async function writeSrt(capSegments, srtPath) {
  const blocks = capSegments.map(
    (seg, i) =>
      `${i + 1}\n${srtTimestamp(seg.startSec)} --> ${srtTimestamp(seg.startSec + seg.durationSec)}\n${seg.text}\n`
  );
  await fs.writeFile(srtPath, blocks.join("\n"), "utf-8");
}

/** Escapes a filesystem path for safe use inside an ffmpeg filtergraph string. */
function escapeFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/** Burns captions into the video (requires ffmpeg built with libass, and a
 * font available via fontconfig — install `fonts-dejavu-core` in CI). */
async function burnSubtitles(inputPath, srtPath, outPath) {
  const style =
    "FontName=DejaVu Sans,FontSize=22,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=60";
  await ffmpeg([
    "-i", inputPath,
    "-vf", `subtitles=${escapeFilterPath(srtPath)}:force_style='${style}'`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-an",
    outPath,
  ]);
}

/**
 * @param {Array<{visual: {type:string,path:string}|null, durationSec: number, text?: string}>} segments
 * @param {string} narrationAudioPath
 * @param {string} workDir - scratch directory for intermediate files
 * @param {string} outputPath - final MP4 path
 * @param {string|null} placeholderImage - branded fallback image path used when a segment has no visual
 * @param {{subtitles?: boolean}} options - set subtitles:false to skip burning in captions
 */
export async function buildDocumentary(
  segments,
  narrationAudioPath,
  workDir,
  outputPath,
  placeholderImage = null,
  options = {}
) {
  const { subtitles = true } = options;
  await fs.mkdir(workDir, { recursive: true });

  const clipPaths = [];
  const capSegments = [];
  let cumulativeSec = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const visual = seg.visual ?? (placeholderImage ? { type: "image", path: placeholderImage } : null);
    if (!visual) continue; // no visual and no placeholder configured — skip rather than break the video

    const dur = Math.max(seg.durationSec, 0.6); // matches the floor renderSegmentClip applies
    const clipPath = path.join(workDir, `segment_${i}.mp4`);
    await renderSegmentClip(visual, dur, clipPath);
    clipPaths.push(clipPath);

    if (seg.text) {
      capSegments.push({ text: seg.text, startSec: cumulativeSec, durationSec: dur });
    }
    cumulativeSec += dur;
  }

  if (clipPaths.length === 0) {
    throw new Error("no visuals were found for any segment — nothing to build");
  }

  // concat all segment clips (concat demuxer requires a list file)
  const listFile = path.join(workDir, "concat_list.txt");
  await fs.writeFile(listFile, clipPaths.map((p) => `file '${path.resolve(p)}'`).join("\n"));

  const visualsOnly = path.join(workDir, "visuals_concat.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", visualsOnly]);

  let videoForMux = visualsOnly;
  if (subtitles && capSegments.length > 0) {
    const srtPath = path.join(workDir, "captions.srt");
    await writeSrt(capSegments, srtPath);
    const subtitledPath = path.join(workDir, "visuals_subtitled.mp4");
    await burnSubtitles(visualsOnly, srtPath, subtitledPath);
    videoForMux = subtitledPath;
  }

  // lay the narration track on top; -shortest guards against tiny drift
  await ffmpeg([
    "-i", videoForMux,
    "-i", narrationAudioPath,
    "-c:v", "copy",
    "-c:a", "aac", "-b:a", "160k",
    "-shortest",
    outputPath,
  ]);

  return outputPath;
}
