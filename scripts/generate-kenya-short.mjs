// NEXTSCENE TV daily "Trending in Kenya" Short (Oct 10 2026).
//
// Replaces the old "money & power" Shorts (scripts/generate-short.mjs),
// which got no views once the channel moved to Kenya / KOT stories.
//
// Each run:
//  1. Reads Kenya's live X trends from trends24.in (public page, no login,
//     no paid X API).
//  2. Recent Kenyan headlines for the top trends come from Google News RSS;
//     Gemini picks ONE trend that is a real
//     story people want explained (not an ad, not a promo hashtag), finds
//     out from those headlines why it is trending, and writes a 35-50 second
//     Kenyan-English script. Serious tone for serious news, light KOT
//     humour only for light stories. Facts must come from its sources.
//  3. Real photos of the people/places involved come from Wikimedia
//     Commons (free licences, credited on screen). Never stock footage.
//     If no photo fits, the Short uses the trends card only.
//  4. Narrates with a Kenyan English voice, builds a 1080x1920 video and
//     uploads it to YouTube (YOUTUBE_PRIVACY, private by default so the
//     owner reviews it first).
//
// Env: GEMINI_API_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
//      YOUTUBE_REFRESH_TOKEN, YOUTUBE_PRIVACY.
//
//   node scripts/generate-kenya-short.mjs --no-upload

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NO_UPLOAD = process.argv.includes("--no-upload");

const W = 1080;
const H = 1920;
const FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
const FONT_REGULAR = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
const VOICE = "en-KE-ChilembaNeural";
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"];
const TRENDS_URL = "https://trends24.in/kenya/";
const HISTORY_PATH = path.join(__dirname, "..", "state", "kenya-short-history.json");
const USER_AGENT = "NEXTSCENE-TV-shorts/1.0 (https://github.com/robertkimani83-netizen/next-scene-news)";
const OUTRO_TEXT = "Follow NEXTSCENE TV for more Kenya stories";
const OUTRO_SEC = 2.2;
const CARD_SEC = 4;

// ---------- small helpers ----------

export function wrapText(text, maxChars) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cand.length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = cand;
  }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

function escapeFilterPath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

async function ffmpeg(args) {
  try {
    return await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], {
      maxBuffer: 1024 * 1024 * 64,
    });
  } catch (err) {
    throw new Error(`ffmpeg failed: ${err.stderr || err.message}`);
  }
}

async function loadHistory() {
  try {
    return JSON.parse(await fs.readFile(HISTORY_PATH, "utf-8"));
  } catch {
    return [];
  }
}

async function saveHistory(history) {
  await fs.mkdir(path.dirname(HISTORY_PATH), { recursive: true });
  await fs.writeFile(HISTORY_PATH, JSON.stringify(history.slice(-40), null, 2) + "\n");
}

// ---------- 1. trends ----------

/** Parses trends24's hourly lists. Returns trends ranked by how many of the
 * recent hourly lists they appear in (staying power), then by best rank. */
export function parseTrends(html, hoursToUse = 6) {
  // trends24 serves slightly different markup to servers than to browsers
  // (quoting/attribute order), so match loosely.
  const LINK = String.raw`<a\b[^>]*class=["']?[^"'>]*\btrend-link\b[^>]*>([^<]+)<\/a>`;
  let blocks = html.split(/<div[^>]*class=["']?[^"'>]*\blist-container\b[^>]*>/).slice(1, hoursToUse + 1);
  if (!blocks.some((b) => new RegExp(LINK).test(b))) blocks = [html];
  const stats = new Map();
  blocks.forEach((block, hourIdx) => {
    const names = [...block.matchAll(new RegExp(LINK, "g"))].map((m) => decodeEntities(m[1]).trim()).filter(Boolean);
    names.slice(0, 30).forEach((name, rankIdx) => {
      const s = stats.get(name) || { name, hours: 0, bestRank: 99, latest: false };
      s.hours += 1;
      s.bestRank = Math.min(s.bestRank, rankIdx + 1);
      if (hourIdx === 0) s.latest = true;
      stats.set(name, s);
    });
  });
  return [...stats.values()].sort((a, b) => b.hours - a.hours || a.bestRank - b.bestRank);
}

async function getTrends() {
  const res = await fetch(TRENDS_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`trends24 responded ${res.status}`);
  const html = await res.text();
  const trends = parseTrends(html);
  if (!trends.length) {
    const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || "?";
    const sample = (html.match(/.{0,120}trend.{0,200}/i) || [""])[0];
    throw new Error(`could not read any trends from trends24 (len ${html.length}, title "${title}", sample: ${sample})`);
  }
  return trends;
}

// ---------- 2. research + script ----------

export function validateScript(s) {
  if (!s || typeof s !== "object") throw new Error("not an object");
  if (s.skip) return s;
  for (const k of ["trend", "title", "hook"]) {
    if (typeof s[k] !== "string" || !s[k].trim()) throw new Error(`missing ${k}`);
  }
  if (!Array.isArray(s.narration) || s.narration.length < 4) throw new Error("narration too short");
  const words = s.narration.join(" ").split(/\s+/).length;
  if (words < 60 || words > 150) throw new Error(`narration has ${words} words`);
  if (!Array.isArray(s.photo_queries)) s.photo_queries = [];
  if (!Array.isArray(s.tags)) s.tags = [];
  if (typeof s.description !== "string") s.description = "";
  return s;
}

function extractJson(text) {
  const cleaned = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Recent Kenyan news coverage of one trend from Google News RSS (free, no
 * key). Returns up to `max` items from the last 3 days. */
export async function fetchNews(query, max = 4) {
  const q = encodeURIComponent(`${query.replace(/^#/, "")} when:3d`);
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-KE&gl=KE&ceid=KE:en`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) return [];
    const xml = await res.text();
    return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, max).map((m) => {
      const item = m[1];
      const get = (tag) => stripHtml(decodeEntities((item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1] || "").replace(/<!\[CDATA\[|\]\]>/g, ""));
      const source = get("source");
      let title = get("title");
      if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
      return { title, source, date: get("pubDate"), snippet: get("description").slice(0, 300) };
    });
  } catch {
    return [];
  }
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  let lastErr;
  for (let pass = 1; pass <= 3; pass++) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
          },
        );
        if (!res.ok) throw new Error(`${model} responded ${res.status}`);
        const data = await res.json();
        const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
        return validateScript(extractJson(text));
      } catch (err) {
        lastErr = err;
        console.warn(`[script] ${model} failed (pass ${pass}/3): ${err.message}`);
      }
    }
    if (pass < 3) await new Promise((r) => setTimeout(r, 8000 * pass));
  }
  throw new Error(`all Gemini models failed: ${lastErr?.message}`);
}

async function researchAndWrite(trends, recentTrends) {
  const candidates = trends.slice(0, 15);
  const coverage = await Promise.all(candidates.map((t) => fetchNews(`${t.name} Kenya`)));
  const blocks = candidates
    .map((t, i) => {
      const news = coverage[i];
      const lines = news.length
        ? news.map((n) => `   - "${n.title}" (${n.source}, ${n.date}) ${n.snippet}`).join("\n")
        : "   - (no news coverage found)";
      return `${i + 1}. ${t.name} (in ${t.hours} of the last 6 hourly lists, best rank #${t.bestRank})\n${lines}`;
    })
    .join("\n");
  const avoid = recentTrends.length ? recentTrends.join(", ") : "none";

  const prompt = `You make daily YouTube Shorts for NEXTSCENE TV, a Kenyan channel known for Kenya stories and KOT (Kenyans on X) culture.

These are Kenya's trending topics on X right now, each with the recent news headlines found for it:
${blocks}

Already covered recently (do NOT pick these or the same story): ${avoid}

STEP 1: Pick ONE trend that is a real story Kenyans want explained AND has clear news coverage above: politics, public figures, viral moments, online wars, big national news, celebrities. Prefer trends that stayed in the lists for many hours.
Do NOT pick: brand campaigns or promoted hashtags (company product hashtags), betting, church/prayer hashtags, routine football fixtures or match results, stories about private individuals, anything involving children, sexual content, or a person's death unless it is major national news. Do not pick a trend whose headlines are about something unrelated.

STEP 2: Use ONLY facts from the headlines and snippets for that trend. If something is alleged or claimed, say who claims it. Never invent numbers, quotes, names or details that are not in them. If the coverage is too thin to explain the story, choose another trend.

STEP 3: Write the Short. Kenyan English, conversational, like telling a friend. Serious and respectful for deaths, crime, disasters or illness (no jokes). For light stories you may add one clever KOT-style line.

Reply with ONLY this JSON (no other text):
{
  "trend": "the trend name exactly as listed",
  "why": "one sentence: why it is trending",
  "tone": "serious" or "light",
  "title": "YouTube title, max 85 characters, curiosity hook, the trend name or main person in it, max one emoji, no hashtags",
  "hook": "on-screen hook, 3-6 words, ALL CAPS",
  "narration": ["6 to 9 short sentences, 85-120 words total. Sentence 1 is a hook. Mention it is trending in Kenya. Last sentence asks viewers a question to answer in the comments."],
  "description": "2-3 sentence YouTube description",
  "tags": ["8-12 search tags"],
  "photo_queries": ["1-3 Wikimedia Commons searches for REAL photos of the main public figures, places or institutions, e.g. 'William Ruto', 'Parliament of Kenya'. Empty list if there are none."],
  "sources": ["names of the news outlets you used, from the list above"]
}

If none of the trends is suitable, reply with {"skip": true, "reason": "..."}.`;

  const script = await callGemini(prompt);
  if (!script.skip) {
    const idx = candidates.findIndex((t) => t.name.toLowerCase() === String(script.trend).toLowerCase());
    if (idx < 0 || !coverage[idx].length) throw new Error(`Gemini picked "${script.trend}", which has no news coverage in the list`);
    const outlets = coverage[idx].map((n) => n.source).filter(Boolean);
    script.sources = [...new Set((Array.isArray(script.sources) ? script.sources : []).filter((s) => outlets.includes(s)).concat(outlets))].slice(0, 4);
  }
  return script;
}

// ---------- 3. real photos (Wikimedia Commons) ----------

function stripHtml(s) {
  return decodeEntities(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

async function findCommonsPhoto(query) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6" +
    `&gsrlimit=10&gsrsearch=${encodeURIComponent(`filetype:bitmap ${query}`)}` +
    "&prop=imageinfo&iiprop=url|size|mime|extmetadata&iiurlwidth=1600";
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) return null;
  const data = await res.json();
  const pages = Object.values(data.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    if (!ii || ii.mime !== "image/jpeg" || (ii.width || 0) < 800) continue;
    const title = (p.title || "").toLowerCase();
    if (/logo|map|flag|coat of arms|seal|diagram|chart|signature/.test(title)) continue;
    if (!words.some((w) => title.includes(w))) continue;
    const meta = ii.extmetadata || {};
    const artist = stripHtml(meta.Artist?.value) || "Unknown";
    const licence = stripHtml(meta.LicenseShortName?.value) || "see Commons";
    return {
      url: ii.thumburl || ii.url,
      credit: `${artist} / Wikimedia Commons (${licence})`.slice(0, 90),
      page: ii.descriptionurl,
    };
  }
  return null;
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`download ${res.status}`);
  await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

// ---------- 4. video ----------

/** Renders the opening "TRENDING IN KENYA" card listing the top trends with
 * the chosen one highlighted. Real data, not a stock visual. */
export async function renderTrendCard(trends, chosen, outPath, workDir) {
  const top = trends.slice(0, 6).map((t) => t.name);
  if (!top.includes(chosen)) top[5] = chosen;
  const filters = [
    `drawbox=x=0:y=0:w=${W}:h=${H}:color=0x0B0F14:t=fill`,
    `drawbox=x=0:y=0:w=${W}:h=14:color=0xBB0000:t=fill`,
    `drawbox=x=0:y=${H - 14}:w=${W}:h=14:color=0x006600:t=fill`,
  ];
  const tf = async (name, text) => {
    const p = path.join(workDir, name);
    await fs.writeFile(p, text, "utf-8");
    return escapeFilterPath(p);
  };
  filters.push(`drawtext=fontfile=${FONT_BOLD}:textfile='${await tf("card_t1.txt", "TRENDING IN KENYA")}':fontcolor=white:fontsize=78:x=(w-text_w)/2:y=330`);
  filters.push(`drawtext=fontfile=${FONT_REGULAR}:textfile='${await tf("card_t2.txt", "on X right now")}':fontcolor=0xBBBBBB:fontsize=44:x=(w-text_w)/2:y=430`);
  let y = 560;
  for (let i = 0; i < top.length; i++) {
    const isChosen = top[i] === chosen;
    if (isChosen) filters.push(`drawbox=x=70:y=${y - 22}:w=${W - 140}:h=112:color=0xFFD400:t=fill`);
    const label = top[i].length > 19 ? `${top[i].slice(0, 18)}…` : top[i];
    const f = await tf(`card_r${i}.txt`, `${i + 1}.  ${label}`);
    filters.push(
      `drawtext=fontfile=${FONT_BOLD}:textfile='${f}':fontcolor=${isChosen ? "black" : "white"}:fontsize=58:x=110:y=${y}`,
    );
    y += 135;
  }
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:d=1`,
    "-vf", filters.join(","),
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
}

/** One visual segment: blurred background + fitted photo with a slow push-in. */
async function renderPhotoSegment(imgPath, dur, outPath, isCard) {
  const d = dur.toFixed(2);
  const vf = isCard
    ? `scale=${W}:${H},setsar=1,fps=30`
    : [
        `split[a][b]`,
        `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.22,setsar=1[bg]`,
        `[b]scale=1040:860:force_original_aspect_ratio=decrease,setsar=1[fg0]`,
        `[fg0]scale=w='trunc(iw*(1+0.06*t/${d})/2)*2':h=-2:eval=frame[fg]`,
        `[bg][fg]overlay=x=(W-w)/2:y=530+(860-h)/2,fps=30`,
      ].join(";");
  await ffmpeg([
    "-loop", "1", "-framerate", "30", "-t", d, "-i", imgPath,
    ...(isCard ? ["-vf", vf] : ["-filter_complex", vf]),
    "-t", d, "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    outPath,
  ]);
  return outPath;
}

/** Splits the timeline: the trends card first, then the photos evenly. */
export function planVisuals(totalSec, photoCount) {
  if (!photoCount) return [{ kind: "card", dur: totalSec }];
  const card = Math.min(CARD_SEC, totalSec / 3);
  const each = (totalSec - card) / photoCount;
  return [{ kind: "card", dur: card }, ...Array.from({ length: photoCount }, (_, i) => ({ kind: "photo", index: i, dur: each }))];
}

/**
 * @param {{cardPath:string, photos:{path:string,credit:string}[], audioPath:string, hook:string,
 *   captions:{text:string,start:number,end:number}[], totalSec:number, outPath:string, workDir:string}} o
 */
export async function buildVideo(o) {
  const plan = planVisuals(o.totalSec, o.photos.length);
  const segs = [];
  const creditWindows = [];
  let t = 0;
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i];
    const seg = path.join(o.workDir, `seg${i}.mp4`);
    if (p.kind === "card") await renderPhotoSegment(o.cardPath, p.dur, seg, true);
    else {
      await renderPhotoSegment(o.photos[p.index].path, p.dur, seg, false);
      creditWindows.push({ credit: o.photos[p.index].credit, start: t, end: t + p.dur });
    }
    segs.push(seg);
    t += p.dur;
  }
  const listPath = path.join(o.workDir, "segs.txt");
  await fs.writeFile(listPath, segs.map((s) => `file '${s}'`).join("\n"));
  const track = path.join(o.workDir, "track.mp4");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", track]);

  const tf = async (name, text) => {
    const p = path.join(o.workDir, name);
    await fs.writeFile(p, text, "utf-8");
    return escapeFilterPath(p);
  };
  const cardEnd = plan[0].kind === "card" && o.photos.length ? plan[0].dur : 0;
  const chain = [
    // Hook + brand only over the photo part (the card has its own title).
    `[0:v]drawbox=x=0:y=150:w=${W}:h=330:color=black@0.6:t=fill:enable='gte(t,${cardEnd.toFixed(2)})'[v1]`,
    `[v1]drawtext=fontfile=${FONT_BOLD}:textfile='${await tf("hook.txt", wrapText(o.hook.toUpperCase(), 16))}':fontcolor=#FFD400:fontsize=84:line_spacing=12:x=(w-text_w)/2:y=190:borderw=4:bordercolor=black:enable='gte(t,${cardEnd.toFixed(2)})'[v2]`,
    `[v2]drawtext=fontfile=${FONT_BOLD}:textfile='${await tf("brand.txt", "NEXTSCENE TV")}':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=80:borderw=3:bordercolor=black[v3]`,
  ];
  let last = "v3";
  let n = 0;
  for (const c of creditWindows) {
    const next = `cr${n}`;
    chain.push(
      `[${last}]drawtext=fontfile=${FONT_REGULAR}:textfile='${await tf(`credit${n}.txt`, `Photo: ${c.credit}`)}':fontcolor=white@0.85:fontsize=24:x=(w-text_w)/2:y=h-70:borderw=2:bordercolor=black:enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[${next}]`,
    );
    last = next;
    n++;
  }
  n = 0;
  for (const c of o.captions) {
    const next = `c${n}`;
    chain.push(
      `[${last}]drawtext=fontfile=${FONT_BOLD}:textfile='${await tf(`cap${n}.txt`, wrapText(c.text, 24))}':fontcolor=white:fontsize=58:line_spacing=10:` +
        `x=(w-text_w)/2:y=1450:box=1:boxcolor=black@0.55:boxborderw=22:borderw=3:bordercolor=black:` +
        `enable='between(t,${c.start.toFixed(2)},${c.end.toFixed(2)})'[${next}]`,
    );
    last = next;
    n++;
  }
  const outroStart = (o.totalSec - OUTRO_SEC).toFixed(2);
  chain.push(
    `[${last}]drawtext=fontfile=${FONT_BOLD}:textfile='${await tf("outro.txt", wrapText(OUTRO_TEXT, 22))}':fontcolor=#FFD400:fontsize=62:line_spacing=10:` +
      `x=(w-text_w)/2:y=1450:box=1:boxcolor=black@0.7:boxborderw=24:enable='gte(t,${outroStart})'[vout]`,
  );

  await ffmpeg([
    "-i", track,
    "-i", o.audioPath,
    "-filter_complex", chain.join(";"),
    "-map", "[vout]", "-map", "1:a",
    "-t", o.totalSec.toFixed(2),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k", "-af", "apad",
    o.outPath,
  ]);
  return o.outPath;
}

/** Turns narration sentence timings into caption windows, splitting long
 * sentences in two so each caption stays short on screen. */
export function captionsFromSentences(sentences) {
  const caps = [];
  for (const s of sentences) {
    const start = s.startSec;
    const end = s.startSec + s.durationSec;
    const words = s.text.trim().split(/\s+/);
    if (words.length > 12) {
      const mid = Math.ceil(words.length / 2);
      const t = start + (end - start) * (mid / words.length);
      caps.push({ text: words.slice(0, mid).join(" "), start, end: t });
      caps.push({ text: words.slice(mid).join(" "), start: t, end });
    } else caps.push({ text: words.join(" "), start, end });
  }
  return caps;
}

// ---------- main ----------

async function main() {
  const runDir = path.join(__dirname, "..", "tmp", `kenyashort_${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });

  console.log("[trends] reading Kenya's X trends from trends24...");
  const trends = await getTrends();
  console.log(`[trends] top: ${trends.slice(0, 8).map((t) => t.name).join(" | ")}`);

  const history = await loadHistory();
  const recent = history.slice(-14).map((h) => h.trend);

  console.log("[script] picking a trend and researching it (Google News + Gemini)...");
  const script = await researchAndWrite(trends, recent);
  if (script.skip) {
    console.log(`No suitable trend today: ${script.reason || "no reason given"}. Skipping.`);
    return;
  }
  console.log(`[script] trend: ${script.trend} | why: ${script.why}`);
  console.log(`[script] title: ${script.title}`);
  console.log(`[script] sources: ${script.sources.join(", ")}`);

  const photos = [];
  for (const q of script.photo_queries.slice(0, 3)) {
    try {
      const hit = await findCommonsPhoto(q);
      if (!hit || photos.some((p) => p.url === hit.url)) continue;
      const file = path.join(runDir, `photo${photos.length}.jpg`);
      await download(hit.url, file);
      photos.push({ ...hit, path: file, query: q });
      console.log(`[photo] "${q}" -> ${hit.page}`);
    } catch (err) {
      console.warn(`[photo] "${q}" failed: ${err.message}`);
    }
  }
  if (!photos.length) console.log("[photo] no matching real photo found; using the trends card only");

  const cardPath = await renderTrendCard(trends, script.trend, path.join(runDir, "card.png"), runDir);

  const { synthesizeNarration } = await import("./lib/tts.mjs");
  const { forSpeech } = await import("./lib/pronounce.mjs");
  const spoken = script.narration.map((line) => forSpeech(line, { voice: VOICE }));
  const tts = await synthesizeNarration(spoken.join(" "), runDir, VOICE, { rate: "+4%" });
  const audioPath = tts.audioPath;
  // Captions show the original wording, not the pronunciation respellings.
  const sentences =
    tts.sentences.length === script.narration.length
      ? tts.sentences.map((s, i) => ({ ...s, text: script.narration[i] }))
      : tts.sentences;
  const speechEnd = (sentences.at(-1)?.startSec ?? 0) + (sentences.at(-1)?.durationSec ?? 0);
  const totalSec = Math.min(Math.max(speechEnd + 0.4, 20) + OUTRO_SEC, 59);

  const outPath = path.join(runDir, "final_short.mp4");
  await buildVideo({
    cardPath,
    photos,
    audioPath,
    hook: script.hook,
    captions: captionsFromSentences(sentences),
    totalSec,
    outPath,
    workDir: runDir,
  });
  console.log(`[done] ${outPath} (${totalSec.toFixed(1)}s)`);

  if (NO_UPLOAD) {
    console.log("[upload] skipped (--no-upload)");
    return;
  }

  const { uploadToYouTube, getOrCreatePlaylist, addVideoToPlaylist } = await import("./lib/youtube.mjs");
  const title = `${script.title.replace(/#\w+/g, "").trim()} #Shorts`.slice(0, 100);
  const description = [
    script.description,
    "",
    `Trending in Kenya on X: ${script.trend}`,
    script.sources.length ? `Sources: ${script.sources.join(", ")}` : "",
    ...photos.map((p) => `Photo: ${p.credit} ${p.page}`),
    "",
    "Follow NEXTSCENE TV for more Kenya stories 🇰🇪",
    "",
    "#Kenya #KenyaNews #KOT #Trending #Shorts",
  ]
    .filter((l, i, arr) => l !== "" || arr[i - 1] !== "")
    .join("\n");
  const tags = [...new Set([...(script.tags || []), script.trend.replace(/^#/, ""), "kenya", "kot", "trending kenya", "nextscene tv"])].slice(0, 15);

  const result = await uploadToYouTube(outPath, title, description, { tags, categoryId: "25" });
  console.log(`[upload] uploaded: https://youtu.be/${result.id} (${result.status?.privacyStatus})`);

  history.push({ date: new Date().toISOString().slice(0, 10), trend: script.trend, videoId: result.id });
  await saveHistory(history);

  try {
    const pl = await getOrCreatePlaylist("Trending in Kenya — NEXTSCENE TV", "What Kenya is talking about on X, explained in under a minute.");
    await addVideoToPlaylist(pl, result.id);
  } catch (err) {
    console.warn(`[playlist] skipped: ${err.message}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exit(1);
  });
}
