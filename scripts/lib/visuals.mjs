// Finds a REAL video clip (preferred) or photo (fallback) for each narration
// segment, using the same free Pexels/Unsplash keys already set up for the
// VOX254 pipeline (PEXELS_API_KEY, UNSPLASH_API_KEY). No new accounts needed.

import fs from "node:fs/promises";
import path from "node:path";

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_API_KEY;

async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  return destPath;
}

/** Search Pexels' free stock VIDEO library for a real clip matching the query. */
async function findPexelsVideo(query) {
  if (!PEXELS_KEY) return null;
  const res = await fetch(
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&per_page=5&orientation=landscape`,
    { headers: { Authorization: PEXELS_KEY } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const video = data.videos?.[0];
  if (!video) return null;

  // pick the best HD-ish file (prefer ~1920 width, mp4)
  const files = (video.video_files || [])
    .filter((f) => f.file_type === "video/mp4" && f.width)
    .sort((a, b) => Math.abs(a.width - 1920) - Math.abs(b.width - 1920));
  const file = files[0];
  if (!file) return null;

  return { url: file.link, type: "video", durationSec: video.duration };
}

/** Fallback: a real photo from Pexels, then Unsplash if Pexels has nothing. */
async function findPhoto(query) {
  if (PEXELS_KEY) {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: PEXELS_KEY } }
    );
    if (res.ok) {
      const data = await res.json();
      const photo = data.photos?.[0];
      if (photo) return { url: photo.src.large2x || photo.src.large, type: "image" };
    }
  }
  if (UNSPLASH_KEY) {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } }
    );
    if (res.ok) {
      const data = await res.json();
      const photo = data.results?.[0];
      if (photo) return { url: photo.urls.regular, type: "image" };
    }
  }
  return null;
}

/** Builds an ordered list of search phrases to try, most-specific first.
 * A named country/city ("location") is tried before the generic scene
 * description, since stock libraries reliably have skyline/aerial footage
 * for real places but often don't have anything for an abstract phrase
 * like "growing economy" — which is what was causing videos to show the
 * wrong country. */
function buildSearchTerms(query, location) {
  const terms = [];
  if (location) {
    terms.push(`${location} skyline`);
    terms.push(`${location} city aerial`);
    terms.push(location);
  }
  if (query) terms.push(query);
  return [...new Set(terms.filter(Boolean))];
}

/**
 * Gets a real visual (video clip or photo) for one narration segment and
 * saves it to disk, ready for the ffmpeg assembly step. Tries every search
 * term across all real video results first (so a named place always wins
 * over a generic clip), then falls back to photos with the same terms.
 *
 * @param {{query: string, location?: string}} search - `query` is a short
 *   visual search phrase (e.g. "container ship port"); `location` is the
 *   specific country/city this segment is about, if any (e.g. "Nairobi, Kenya").
 * @param {string} outDir
 * @param {number} index - segment index, used for the output filename
 */
export async function fetchVisualForSegment({ query, location } = {}, outDir, index) {
  await fs.mkdir(outDir, { recursive: true });
  const terms = buildSearchTerms(query, location);

  for (const term of terms) {
    const video = await findPexelsVideo(term).catch(() => null);
    if (video) {
      const dest = path.join(outDir, `segment_${index}_raw.mp4`);
      await downloadTo(video.url, dest);
      return { type: "video", path: dest, matchedTerm: term };
    }
  }

  for (const term of terms) {
    const photo = await findPhoto(term).catch(() => null);
    if (photo) {
      const ext = photo.url.includes(".png") ? "png" : "jpg";
      const dest = path.join(outDir, `segment_${index}_raw.${ext}`);
      await downloadTo(photo.url, dest);
      return { type: "image", path: dest, matchedTerm: term };
    }
  }

  // last-resort: no visual found for any search term — caller should fall
  // back to a branded placeholder/title card rather than leaving a gap.
  return null;
}
