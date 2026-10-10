// Kenyan-voice voiceover maker (Oct 10 2026).
//
// Turns any narration script into an MP3 read by Microsoft's Kenyan English
// neural voice, plus sentence timings for captions. Built for the long
// NEXTSCENE TV videos made in chat, where the only offline voice sounds
// American and mispronounced Kenyan names.
//
// Run from GitHub: Actions -> "Make Kenyan Voiceover" -> Run workflow,
// paste the script. Download the "voiceover" artifact when it finishes:
//   voiceover.mp3     the narration
//   sentences.json    [{text, startSec, durationSec}] per sentence
//   voiceover.srt     the same timings as subtitles
//
// Env: SCRIPT_TEXT (required), VOICE (default en-KE-ChilembaNeural),
//      RATE (e.g. "+0%", "+5%", "-5%").

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { synthesizeNarration } from "./lib/tts.mjs";
import { forSpeech } from "./lib/pronounce.mjs";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "tmp", "voiceover");
const MAX_CHUNK_CHARS = 1500;

export function splitSentences(text) {
  return (
    text
      .replace(/\s+/g, " ")
      .trim()
      .match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g) || []
  )
    .map((s) => s.trim())
    .filter(Boolean);
}

export function chunkSentences(sentences, maxChars = MAX_CHUNK_CHARS) {
  const chunks = [];
  let cur = [];
  let len = 0;
  for (const s of sentences) {
    if (cur.length && len + s.length + 1 > maxChars) {
      chunks.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(s);
    len += s.length + 1;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3, "0")}`;
}

async function durationOf(file) {
  const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(stdout.trim());
}

async function main() {
  const text = (process.env.SCRIPT_TEXT || "").trim();
  if (!text) throw new Error("SCRIPT_TEXT is empty: paste the narration into the workflow's 'script' box");
  const voice = (process.env.VOICE || "en-KE-ChilembaNeural").trim();
  const rate = (process.env.RATE || "+0%").trim();

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const sentences = splitSentences(text);
  const chunks = chunkSentences(sentences);
  console.log(`[voiceover] ${sentences.length} sentences in ${chunks.length} chunk(s), voice ${voice}, rate ${rate}`);

  const timeline = [];
  const parts = [];
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    const dir = path.join(OUT_DIR, `chunk${i}`);
    const original = chunks[i];
    const spoken = original.map((s) => forSpeech(s, { voice })).join(" ");
    const { audioPath, sentences: timed } = await synthesizeNarration(spoken, dir, voice, { rate });
    const dur = await durationOf(audioPath);
    const sameCount = timed.length === original.length;
    timed.forEach((t, j) => {
      timeline.push({ text: sameCount ? original[j] : t.text, startSec: +(offset + t.startSec).toFixed(3), durationSec: +t.durationSec.toFixed(3) });
    });
    parts.push(audioPath);
    offset += dur;
    console.log(`[voiceover] chunk ${i + 1}/${chunks.length}: ${dur.toFixed(1)}s`);
  }

  const list = path.join(OUT_DIR, "parts.txt");
  await fs.writeFile(list, parts.map((p) => `file '${p}'`).join("\n"));
  const mp3 = path.join(OUT_DIR, "voiceover.mp3");
  await run("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-ar", "44100", "-ac", "1", "-b:a", "128k", mp3]);

  await fs.writeFile(path.join(OUT_DIR, "sentences.json"), JSON.stringify(timeline, null, 2));
  const srt = timeline
    .map((t, i) => `${i + 1}\n${srtTime(t.startSec)} --> ${srtTime(t.startSec + t.durationSec)}\n${t.text}\n`)
    .join("\n");
  await fs.writeFile(path.join(OUT_DIR, "voiceover.srt"), srt);

  for (let i = 0; i < chunks.length; i++) await fs.rm(path.join(OUT_DIR, `chunk${i}`), { recursive: true, force: true });
  await fs.rm(list, { force: true });
  console.log(`[done] voiceover.mp3 (${(await durationOf(mp3)).toFixed(1)}s), ${timeline.length} timed sentences`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}
