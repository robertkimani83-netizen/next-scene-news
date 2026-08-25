// Builds the final documentary-style video: each narration segment gets its
// real video clip or photo (from visuals.mjs) shown for exactly as long as
// that sentence takes to narrate (from tts.mjs's timing), then everything is
// concatenated and the narration track is laid on top. Photos get a subtle
// Ken Burns pan/zoom so a still image doesn't look static next to real clips.
//
// Supports two canvas shapes via the `dims` option: landscape 1920x1080
// (long-form videos) and portrait 1080x1920 (YouTube Shorts) — every overlay
// position/size below is computed from `dims` rather than hardcoded, so the
// same rendering code produces both formats. Positions that depend on
// available horizontal room (font sizes, logo/badge scale, left margins)
// scale with width; vertical placement (y-offsets) scales with height —
// see scaleX/scaleY. Landscape values match the original hand-tuned pixel
// numbers exactly (scale factor 1.0), so long-form output is unchanged.
//
// Assumes `ffmpeg` is on PATH (installed via `apt-get install -y ffmpeg` in
// the GitHub Actions workflow — the same approach already working for the
// VOX254 news-video pipeline, avoiding the ffmpeg-static ENOENT issues hit
// on Vercel).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);

// Landscape (long-form) is the reference canvas every hand-tuned pixel value
// below was designed against — scaleX/scaleY convert those numbers to
// whatever `dims` the caller actually wants (see LANDSCAPE_DIMS/PORTRAIT_DIMS).
const REFERENCE_WIDTH = 1920;
const REFERENCE_HEIGHT = 1080;

export const LANDSCAPE_DIMS = { width: 1920, height: 1080 };
export const PORTRAIT_DIMS = { width: 1080, height: 1920 };

function scaleX(px, dims) {
  return Math.round(px * (dims.width / REFERENCE_WIDTH));
}
function scaleY(px, dims) {
  return Math.round(px * (dims.height / REFERENCE_HEIGHT));
}

// Branded assets/colors for the title-card redesign (matches the channel's
// existing thumbnail style: real background photo, logo badge top-left,
// wordmark top-right, gold accent tagline).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "logo.png");

// A small rotation of accent-color themes for the title cards and badges.
// Picking a different one per video (see generate-documentary.mjs/
// generate-short.mjs) keeps the channel from looking like one identical
// template stamped out every time — both a small algorithm/visibility win
// (more visually distinct thumbnails/cards) and a hedge against YouTube's
// "inauthentic content" policy, which specifically flags videos that are
// "made with a template with little to no variation". The layout/structure
// stays identical (still on-brand, still recognizable as NEXTSCENE TV) —
// only the accent colors shift. `signature` matches the original fixed
// red/gold look exactly, so index 0 is a no-op if a caller doesn't rotate.
export const CARD_THEMES = [
  { name: "signature", wordmarkBg: "0xE21C21", accent: "0xFFD700" },
  { name: "electric-blue", wordmarkBg: "0x1C3FE2", accent: "0x4FD8FF" },
  { name: "emerald", wordmarkBg: "0x0E7A4B", accent: "0x7CFFB2" },
];

async function ffmpeg(args) {
  try {
    return await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

const FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

/** Escapes a filesystem path for safe use inside an ffmpeg filtergraph string. */
function escapeFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

// All drawtext calls below use `textfile=` rather than `text='...'`. The
// filtergraph "quoting" method for embedding an apostrophe in a quoted value
// — close the quote, insert an escaped quote, reopen: 'Crime d'\''Amour',
// straight from ffmpeg's own docs — was tried and verified NOT to render at
// all in this ffmpeg build (blank output, no error) the moment the text
// contains a quote character (e.g. "Côte d'Ivoire", which broke a real run).
// Pointing drawtext at a plain text file sidesteps filtergraph escaping
// entirely — verified working with apostrophes, colons, commas, brackets.
async function writeDrawtextFile(text, filePath) {
  await fs.writeFile(filePath, text, "utf-8");
  return filePath;
}

/** Renders a branded text card (channel name + tagline, or a subscribe
 * reminder) as a fixed-duration clip — used for the intro and outro. These
 * are voiced like any other segment (real narration plays over them), so
 * the duration passed in is the actual TTS timing for that line, not a
 * fixed guess.
 *
 * Styled to match the channel's existing YouTube thumbnails: a real
 * background photo (Ken Burns pan/zoom, same as any image segment) dimmed
 * for legibility, the channel's logo badge top-left, a "NEXT SCENE TV"
 * wordmark top-right, the big white headline centered, and the tagline/
 * sub-line in gold underneath. `opts.bgVisual` (a {type,path} visual, e.g.
 * from fetchVisualForSegment) supplies that background photo; when it's
 * missing (no visual found, or none requested) this falls back to a flat
 * `opts.bg` color card so the video never breaks for lack of a photo. */
async function renderTitleCard(lines, durationSec, outPath, opts = {}) {
  const {
    bg = "black",
    fontsize = 72,
    subFontsize = 32,
    bgVisual = null,
    dims = LANDSCAPE_DIMS,
    theme = CARD_THEMES[0],
  } = opts;
  const dur = Math.max(durationSec, 1).toFixed(2);
  const [main, sub] = lines;

  const bgClipPath = `${outPath}.bg.mp4`;
  if (bgVisual) {
    await renderBaseClip(bgVisual, dur, bgClipPath, dims);
  } else {
    await ffmpeg([
      "-f", "lavfi", "-i", `color=c=${bg}:s=${dims.width}x${dims.height}:d=${dur}:r=30`,
      "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
      bgClipPath,
    ]);
  }

  const mainFile = await writeDrawtextFile(main, `${outPath}.main.txt`);
  const wordmarkFile = await writeDrawtextFile("NEXT SCENE TV", `${outPath}.wordmark.txt`);

  const titleFontsize = scaleX(fontsize, dims);
  const subFs = scaleX(subFontsize, dims);
  const logoH = scaleX(130, dims);
  const margin = scaleX(50, dims);
  const marginTop = scaleY(40, dims);
  const wordmarkY = scaleY(55, dims);
  const wordmarkFontsize = scaleX(30, dims);
  const wordmarkBoxBorder = scaleX(14, dims);
  const subGap = scaleY(40, dims);

  const parts = [
    // dim the photo so white/gold text stays readable over busy backgrounds
    `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=black@0.45:t=fill[dimmed]`,
    `[1:v]scale=-1:${logoH}[logo]`,
    `[dimmed][logo]overlay=x=${margin}:y=${marginTop}[b0]`,
    `[b0]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(wordmarkFile)}:fontcolor=white:fontsize=${wordmarkFontsize}:box=1:boxcolor=${theme.wordmarkBg}:boxborderw=${wordmarkBoxBorder}:x=w-text_w-${margin}:y=${wordmarkY}[b1]`,
    `[b1]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(mainFile)}:fontcolor=white:fontsize=${titleFontsize}:bordercolor=black:borderw=3:x=(w-text_w)/2:y=(h-text_h)/2${sub ? `-${scaleY(36, dims)}` : ""}[b2]`,
  ];
  let last = "b2";
  if (sub) {
    const subFile = await writeDrawtextFile(sub, `${outPath}.sub.txt`);
    parts.push(
      `[${last}]drawtext=fontfile=${FONT_REGULAR}:textfile=${escapeFilterPath(subFile)}:fontcolor=${theme.accent}:fontsize=${subFs}:bordercolor=black:borderw=2:x=(w-text_w)/2:y=(h-text_h)/2+${subGap}[b3]`
    );
    last = "b3";
  }

  await ffmpeg([
    "-i", bgClipPath,
    "-loop", "1", "-i", LOGO_PATH,
    "-filter_complex", parts.join(";"),
    "-map", `[${last}]`,
    "-t", dur,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/** Renders the base clip for one segment's visual (no badge). */
async function renderBaseClip(visual, dur, outPath, dims = LANDSCAPE_DIMS, theme = CARD_THEMES[0]) {
  if (visual.type === "title-card") {
    await renderTitleCard(visual.lines, parseFloat(dur), outPath, {
      bg: visual.bg ?? "black",
      fontsize: visual.fontsize,
      subFontsize: visual.subFontsize,
      bgVisual: visual.bgVisual ?? null,
      dims,
      theme,
    });
    return;
  }

  const { width, height } = dims;

  if (visual.type === "video") {
    await ffmpeg([
      "-stream_loop", "-1", // loop the source clip if it's shorter than needed
      "-i", visual.path,
      "-t", dur,
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30`,
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
      `scale=${Math.round(width * 1.3)}:${Math.round(height * 1.3)}:force_original_aspect_ratio=increase,` +
      `zoompan=z='min(zoom+0.0008,1.15)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${width}x${height}:fps=30`,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/** Overlays a Top-10 style rank badge (number + flag + country name) in the
 * lower portion of the frame, stacked above the caption area — matching the
 * channel's thumbnail style (numbered flag cards). Only called when a real
 * flag image was successfully fetched; skipped entirely otherwise. */
async function overlayCountryBadge(inputPath, badge, dur, outPath, dims = LANDSCAPE_DIMS, theme = CARD_THEMES[0]) {
  const rankText = badge.rank != null ? String(badge.rank) : "";
  const nameText = badge.countryName || "";

  // Vertical badge position is NOT a simple height-ratio scale of the
  // landscape numbers: a portrait canvas is much narrower (1080 vs 1920),
  // so the same caption wraps onto roughly twice as many lines and needs
  // much more reserved space at the bottom — a naive proportional scale
  // pushes the badge low enough that a wrapped caption collides with it
  // (caught while testing the Shorts path). So portrait gets its own,
  // higher-up tuned position instead, leaving a generous caption zone below.
  const isPortrait = dims.height > dims.width;
  const { flagY, rankY, nameY } = isPortrait
    ? { flagY: 520, rankY: 430, nameY: 660 }
    : { flagY: scaleY(650, dims), rankY: scaleY(550, dims), nameY: scaleY(815, dims) };

  const flagH = scaleX(150, dims);
  const margin = scaleX(60, dims);
  const rankFontsize = scaleX(60, dims);
  const rankBoxBorder = scaleX(16, dims);
  const nameFontsize = scaleX(38, dims);
  const nameBoxBorder = scaleX(12, dims);

  const parts = [`[1:v]scale=-1:${flagH}[flag]`, `[0:v][flag]overlay=x=${margin}:y=${flagY}[b0]`];
  let last = "b0";
  if (rankText) {
    const rankFile = await writeDrawtextFile(rankText, `${outPath}.rank.txt`);
    parts.push(
      `[${last}]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(rankFile)}:fontcolor=black:fontsize=${rankFontsize}:box=1:boxcolor=${theme.accent}:boxborderw=${rankBoxBorder}:x=${margin}:y=${rankY}[b1]`
    );
    last = "b1";
  }
  if (nameText) {
    const nameFile = await writeDrawtextFile(nameText, `${outPath}.name.txt`);
    parts.push(
      `[${last}]drawtext=fontfile=${FONT_BOLD}:textfile=${escapeFilterPath(nameFile)}:fontcolor=white:fontsize=${nameFontsize}:box=1:boxcolor=black@0.6:boxborderw=${nameBoxBorder}:x=${margin}:y=${nameY}[b2]`
    );
    last = "b2";
  }

  await ffmpeg([
    "-i", inputPath,
    "-loop", "1", "-i", badge.flagPath,
    "-filter_complex", parts.join(";"),
    "-map", `[${last}]`,
    "-t", dur,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    outPath,
  ]);
}

/** Turns one segment's visual into a silent, fixed-duration clip, with an
 * optional Top-10 rank/flag/country-name badge (visual.badge). */
async function renderSegmentClip(visual, durationSec, outPath, dims = LANDSCAPE_DIMS, theme = CARD_THEMES[0]) {
  const dur = Math.max(durationSec, 0.6).toFixed(2); // floor so ultra-short sentences still show something

  if (!visual.badge) {
    await renderBaseClip(visual, dur, outPath, dims, theme);
    return;
  }

  const basePath = outPath.replace(/\.mp4$/, "_base.mp4");
  await renderBaseClip(visual, dur, basePath, dims, theme);
  await overlayCountryBadge(basePath, visual.badge, dur, outPath, dims, theme);
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

/** Burns captions into the video (requires ffmpeg built with libass, and a
 * font available via fontconfig — install `fonts-dejavu-core` in CI).
 * BorderStyle=1 is an outline only — no filled background box behind the
 * text; Alignment=2 pins it bottom-center regardless of player/theme defaults.
 *
 * IMPORTANT: `fontSize`/`marginV` are ASS style units, not literal output
 * pixels — libass renders against a fixed default script resolution (its
 * PlayResY, ~288, when the stream doesn't declare one, which a plain SRT
 * never does) and then scales that render up to fill the real frame. That
 * scale-up is proportional to frame height, so the SAME nominal fontSize
 * already ends up occupying the same *fraction* of the frame regardless of
 * whether the frame is 1080 or 1920 tall — measured and confirmed: 18/45
 * produces a visually equivalent caption on both the landscape and portrait
 * canvas. Do NOT scale these by dims — that double-counts libass's own
 * scaling and produces oversized, overlapping captions (verified — this was
 * an actual bug caught while testing the Shorts/portrait path). Bump
 * fontSize a little for deliberately larger mobile captions if wanted, but
 * treat it as a flat override, not a dims-derived multiplier. */
async function burnSubtitles(inputPath, srtPath, outPath, dims = LANDSCAPE_DIMS, opts = {}) {
  const { fontSize = 18, marginV = 45 } = opts;
  const style =
    `FontName=DejaVu Sans,FontSize=${fontSize},Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=${marginV}`;
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
 *   `visual.type` can be "video", "image", or "title-card" ({lines, bg?, fontsize?, subFontsize?, bgVisual?}) —
 *   the latter is how a spoken intro/outro line gets a branded card instead of stock footage while
 *   still using the same real TTS-derived duration and getting captioned like any other segment.
 * @param {string} narrationAudioPath - one continuous narration track covering every segment in order
 *   (intro/outro/subscribe-reminder lines included) — since it's all one TTS pass, video and audio
 *   stay in sync automatically with no separate padding step needed.
 * @param {string} workDir - scratch directory for intermediate files
 * @param {string} outputPath - final MP4 path
 * @param {string|null} placeholderImage - branded fallback image path used when a segment has no visual
 * @param {{subtitles?: boolean, dims?: {width:number,height:number}, captionFontSize?: number, captionMarginV?: number, theme?: object}} options -
 *   `dims` picks the output canvas — LANDSCAPE_DIMS (1920x1080, default, long-form) or PORTRAIT_DIMS
 *   (1080x1920, Shorts); every overlay position scales automatically to match. Set subtitles:false to
 *   skip burning in captions. `theme` (one of CARD_THEMES, default CARD_THEMES[0]) picks the accent-color
 *   variant for title cards/badges — pass a different one per video to avoid an identical look every time.
 */
export async function buildDocumentary(
  segments,
  narrationAudioPath,
  workDir,
  outputPath,
  placeholderImage = null,
  options = {}
) {
  const { subtitles = true, dims = LANDSCAPE_DIMS, captionFontSize, captionMarginV, theme = CARD_THEMES[0] } = options;
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
    await renderSegmentClip(visual, dur, clipPath, dims, theme);
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
    await burnSubtitles(visualsOnly, srtPath, subtitledPath, dims, {
      fontSize: captionFontSize,
      marginV: captionMarginV,
    });
    videoForMux = subtitledPath;
  }

  // lay the one continuous narration track on top; -shortest guards against tiny drift
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
