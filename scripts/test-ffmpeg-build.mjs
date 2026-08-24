// Local smoke test for the ffmpeg assembly logic only (no network calls) —
// uses synthetic placeholder assets to prove the video/image mixing,
// duration-matching, and audio muxing actually produces a valid MP4 before
// wiring up the real TTS/Pexels/YouTube calls.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocumentary } from "./lib/ffmpeg-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assets = path.join(__dirname, "..", "tmp", "test_assets");

const segments = [
  { visual: { type: "video", path: path.join(assets, "fake_clip.mp4") }, durationSec: 2.5 },
  { visual: { type: "image", path: path.join(assets, "fake_photo.jpg") }, durationSec: 3.0 },
  { visual: { type: "video", path: path.join(assets, "fake_clip.mp4") }, durationSec: 1.8 },
];

const workDir = path.join(__dirname, "..", "tmp", "test_work");
const outputPath = path.join(__dirname, "..", "tmp", "test_output.mp4");

await buildDocumentary(segments, path.join(assets, "fake_narration.mp3"), workDir, outputPath);
console.log("BUILD OK ->", outputPath);
