// Sound effects + background music for the NEXTSCENE pipeline (see the
// Sept 16 2026 channel-upgrade brief — the pipeline had zero music/SFX
// before this). Both pieces are best-effort and fail SILENTLY (return null,
// never throw): a video with no music bed or no transition SFX is exactly
// today's output, never a broken run.
//
// SFX: Freesound's official APIv2 (freesound.org/docs/api/) — search +
// preview download only need a simple API token (freesound.org/apiv2/apply),
// no OAuth2/human-login step, so it's safe for an unattended scheduled run.
// This deliberately uses the `previews` field from the search response
// (preview-hq-mp3) rather than the /download/ endpoint, since the preview
// URLs are guaranteed accessible with token auth alone. Filtered to
// Creative Commons 0 first (no attribution needed), falling back to
// Attribution-licensed sounds with the attribution text captured for the
// asset manifest.
//
// Music: checked before building anything here — neither Pixabay nor any
// other of this pipeline's stock-media sources has a real Music API
// (verified directly against Pixabay's own docs on Sept 16 2026: only
// Search Images and Search Videos are documented, despite "Music" being a
// browsable category on their site). Free Music Archive used to have one
// but shut it down. Everything else that looks like a free music API
// (Soundraw, Mubert, Soundstripe, musicapi.ai) is a paid subscription or
// AI-generation service. YouTube's Audio Library (the brief's recommended
// source) has no official API at all either.
//
// So there are two tiers here, tried in order:
//   1. assets/music/ — a small folder Robert populates ONCE by hand from
//      YouTube Audio Library (see assets/music/README.md). Best quality/
//      consistency, since it's a curated source, but needs that one manual
//      step. This wins whenever it has anything in it.
//   2. Freesound fallback — same API/key already wired up for the
//      transition SFX above, searched instead for longer ambient/
//      atmospheric tracks (not the short SFX query) and filtered to the
//      same CC0-first-then-Attribution license logic. Fully automatic, but
//      Freesound is a general sound-sharing community rather than a
//      curated music library, so hit quality is more variable than tier 1.
// Neither tier existing yet just means no music bed — never an error.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = path.join(__dirname, "..", "..", "assets", "music");
const FREESOUND_KEY = process.env.FREESOUND_API_KEY;

const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".ogg"]);

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return destPath;
}

/**
 * Freesound text search with the shared CC0-first-then-Attribution
 * fallback logic used by both the SFX lookup and the music-bed fallback
 * below. Returns the raw matched result object (not yet downloaded), or
 * null if nothing matched either license tier.
 *
 * @param {string} query
 * @param {string} durationFilter - a Freesound `duration:[MIN TO MAX]` clause
 * @param {string} fields
 */
async function searchFreesound(query, durationFilter, fields) {
  const tryLicense = async (licenseClause) => {
    const filter = encodeURIComponent(`${durationFilter} ${licenseClause}`);
    const url =
      `https://freesound.org/apiv2/search/text/?query=${encodeURIComponent(query)}` +
      `&filter=${filter}&fields=${fields}&page_size=5&token=${FREESOUND_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0] || null;
  };

  try {
    return (await tryLicense('license:"Creative Commons 0"')) || (await tryLicense('license:"Attribution"'));
  } catch {
    return null;
  }
}

/**
 * Picks a background-music bed: assets/music/ first (see the module header
 * for why that's the preferred tier), then a Freesound search for a longer
 * ambient/atmospheric track as a fully-automatic fallback. Returns null (no
 * error) if neither tier has anything — that's the expected state until
 * Robert populates the folder or sets FREESOUND_API_KEY, and narration-only
 * output is exactly what the pipeline already produces today.
 *
 * @param {string} [outDir] - only needed for the Freesound fallback (where
 *   the downloaded track gets saved); not used when a local track is found.
 * @returns {Promise<{path: string, source: string, license: string, sourceId?: string, pageUrl?: string, attribution?: string} | null>}
 */
export async function pickMusicBed(outDir) {
  let files;
  try {
    files = await fs.readdir(MUSIC_DIR);
  } catch {
    files = [];
  }
  const tracks = files.filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()));
  if (tracks.length > 0) {
    const pick = tracks[Math.floor(Math.random() * tracks.length)];
    return {
      path: path.join(MUSIC_DIR, pick),
      source: "local music library (assets/music/ — see assets/music/README.md)",
      license: "cleared by Robert at download time (e.g. YouTube Audio Library) — not re-verified by the pipeline",
    };
  }

  // tier 2: Freesound fallback — same key as the SFX lookup, different
  // query/duration range (looking for a loop-able ambient bed, not a
  // one-second whoosh)
  if (!FREESOUND_KEY || !outDir) return null;

  const queries = ["ambient background loop", "cinematic atmosphere", "documentary background music"];
  const fields = "id,name,url,license,username,previews,duration";
  const durationFilter = "duration:[15 TO 180]";

  let hit = null;
  for (const q of queries) {
    hit = await searchFreesound(q, durationFilter, fields);
    if (hit) break;
  }
  if (!hit) return null;

  const previewUrl = hit.previews?.["preview-hq-mp3"] || hit.previews?.["preview-lq-mp3"];
  if (!previewUrl) return null;

  await fs.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, "music_bed_freesound.mp3");
  try {
    await downloadTo(previewUrl, dest);
  } catch {
    return null;
  }

  const isCC0 = /creative commons 0|publicdomain\/zero/i.test(hit.license || "");
  return {
    path: dest,
    source: "Freesound (automatic fallback — no track in assets/music/ yet)",
    sourceId: String(hit.id),
    pageUrl: hit.url || `https://freesound.org/s/${hit.id}/`,
    license: hit.license || "unknown",
    attribution: isCC0 ? undefined : `"${hit.name}" by ${hit.username} (freesound.org), ${hit.license}`,
  };
}

/**
 * Finds a short transition/whoosh sound effect from Freesound for use at
 * segment cuts. Returns null if FREESOUND_API_KEY isn't set or nothing
 * suitable is found — never throws.
 *
 * @param {string} outDir
 * @param {string} [query] - defaults to a generic transition-sound search;
 *   callers don't need to (and shouldn't) make this topic-specific — it's a
 *   subtle UI-style cut sound, not a narrated element.
 * @returns {Promise<{path: string, source: string, sourceId: string, pageUrl: string, license: string, attribution?: string} | null>}
 */
export async function findSfxClip(outDir, query = "whoosh transition") {
  if (!FREESOUND_KEY) return null;

  const fields = "id,name,url,license,username,previews,duration";
  const hit = await searchFreesound(query, "duration:[0.1 TO 1.5]", fields);
  if (!hit) return null;

  const previewUrl = hit.previews?.["preview-hq-mp3"] || hit.previews?.["preview-lq-mp3"];
  if (!previewUrl) return null;

  await fs.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, "sfx_transition.mp3");
  try {
    await downloadTo(previewUrl, dest);
  } catch {
    return null;
  }

  const isCC0 = /creative commons 0|publicdomain\/zero/i.test(hit.license || "");
  return {
    path: dest,
    source: "Freesound",
    sourceId: String(hit.id),
    pageUrl: hit.url || `https://freesound.org/s/${hit.id}/`,
    license: hit.license || "unknown",
    attribution: isCC0 ? undefined : `"${hit.name}" by ${hit.username} (freesound.org), ${hit.license}`,
  };
}
