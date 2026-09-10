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
//   en-KE-ChilembaNeural     - Kenyan English, male (used for VOX254 News Reels
//                              so narration sounds local rather than American)
//   en-KE-AsiliaNeural       - Kenyan English, female
//
// docs: https://www.npmjs.com/package/msedge-tts

import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import fs from "node:fs/promises";
import path from "node:path";

const TICKS_PER_SECOND = 10_000_000; // msedge-tts timings are in 100ns "ticks"

/** Runs one narration attempt: fresh MsEdgeTTS instance, synthesize, read
 * back the sentence-boundary metadata, normalize the output filename. Split
 * out so synthesizeNarration can retry a clean attempt from scratch. */
async function synthesizeOnce(fullText, outDir, voice) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, {
    wordBoundaryEnabled: false,
    sentenceBoundaryEnabled: true,
  });

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

/** Runs `fn` but also treats a same-tick UNCAUGHT exception (not just a
 * normal promise rejection) as a failure this function can catch and
 * return from, instead of letting it crash the whole Node process.
 *
 * Why this exists: msedge-tts has a real bug (seen in production logs —
 * Sept 2026) where, on an internal cleanup race, it throws
 * `ENOENT: ... unlink 'metadata.json'` from inside a stream's 'close'
 * event handler rather than rejecting the promise `toFile()` returned. An
 * exception thrown that way is NOT catchable by a plain
 * `try { await synthesizeOnce(...) } catch {}` — it surfaces as an
 * uncaught exception and kills the process outright (confirmed by the
 * "Node.js v20.20.2" crash dump in the failed Actions run logs, YouTube
 * Short generation runs #48/#49/#57 among them). Scoping a temporary
 * `process.on('uncaughtException', ...)` listener around just this one
 * attempt is the standard workaround for a library bug shaped like this —
 * it's removed again immediately after the attempt settles either way. */
function runWithUncaughtGuard(fn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onUncaught = (err) => {
      if (settled) return;
      settled = true;
      process.off("uncaughtException", onUncaught);
      reject(err);
    };
    process.on("uncaughtException", onUncaught);
    fn()
      .then((result) => {
        if (settled) return;
        settled = true;
        process.off("uncaughtException", onUncaught);
        resolve(result);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        process.off("uncaughtException", onUncaught);
        reject(err);
      });
  });
}

/**
 * Synthesizes narration for a full script and returns per-sentence timing.
 * Retries up to 3 times on failure (including the uncaught-exception-shaped
 * msedge-tts race described above) before giving up — each retry is a
 * completely fresh attempt (new MsEdgeTTS instance).
 *
 * @param {string} fullText - the entire narration, sentences separated by
 *   normal punctuation (one sentence per visual segment is the convention
 *   this pipeline uses — see generate-documentary.mjs).
 * @param {string} outDir - directory to write narration.mp3 into
 * @param {string} voice - e.g. "en-US-ChristopherNeural"
 * @returns {Promise<{audioPath: string, sentences: Array<{text: string, startSec: number, durationSec: number}>}>}
 */
export async function synthesizeNarration(fullText, outDir, voice = "en-US-ChristopherNeural") {
  await fs.mkdir(outDir, { recursive: true });

  const MAX_ATTEMPTS = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runWithUncaughtGuard(() => synthesizeOnce(fullText, outDir, voice));
    } catch (err) {
      lastErr = err;
      console.warn(`[tts] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}${attempt < MAX_ATTEMPTS ? ", retrying..." : ""}`);
    }
  }
  throw lastErr;
}
