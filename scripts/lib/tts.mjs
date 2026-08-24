// Free, human-sounding narration using Microsoft Edge's neural voices
// (the same engine behind Edge's "Read Aloud" feature) via the msedge-tts
// package. No API key, no account, no card — and it returns precise
// sentence-level timing so visuals can be synced exactly to the narration.
//
// Good documentary-style English voices to try:
//   en-US-ChristopherNeural  - deep, authoritative male (great for "future/geopolitics" tone)
//   en-US-GuyNeural          - warm, confident male
//   en-GB-RyanNeural         - British, serious/formal
//   en-US-EricNeural         - calm, measured male
//   en-US-AriaNeural         - clear female, versatile
//
// docs: https://www.npmjs.com/package/msedge-tts

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "node:fs/promises";
import path from "node:path";

const TICKS_PER_SECOND = 10_000_000; // msedge-tts timings are in 100ns "ticks"

/**
 * Synthesizes narration for a full script and returns per-sentence timing.
 *
 * @param {string} fullText - the entire narration, sentences separated by
 *   normal punctuation (one sentence per visual segment is the convention
 *   this pipeline uses — see generate-documentary.mjs).
 * @param {string} outDir - directory to write narration.mp3 into
 * @param {string} voice - e.g. "en-US-ChristopherNeural"
 * @returns {Promise<{audioPath: string, sentences: Array<{text: string, startSec: number, durationSec: number}>}>}
 */
export async function synthesizeNarration(fullText, outDir, voice = "en-US-ChristopherNeural") {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: false,
    sentenceBoundaryEnabled: true,
  });

  await fs.mkdir(outDir, { recursive: true });
  const { audioFilePath, metadataFilePath } = await tts.toFile(outDir, fullText);

  const metaRaw = await fs.readFile(metadataFilePath, "utf-8");
  const meta = JSON.parse(metaRaw);

  const sentences = meta.Metadata
    .filter((m) => m.Type === "SentenceBoundary")
    .map((m) => ({
      text: m.Data.text.Text,
      startSec: m.Data.Offset / TICKS_PER_SECOND,
      durationSec: m.Data.Duration / TICKS_PER_SECOND,
    }));

  // normalize the output filename
  const finalAudioPath = path.join(outDir, "narration.mp3");
  if (audioFilePath !== finalAudioPath) {
    await fs.rename(audioFilePath, finalAudioPath);
  }

  return { audioPath: finalAudioPath, sentences };
}
