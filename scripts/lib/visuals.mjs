// Finds a REAL video clip (preferred) or photo (fallback) for each narration
// segment.
//
// SOURCING POLICY (see the Sept 16 2026 channel-upgrade brief):
//   video:  Pexels (primary) -> Pixabay (secondary) -> Coverr (additional)
//   photo:  Pexels -> Pixabay -> Unsplash (final fallback)
// Every one of those is a real licensed stock-media API with a documented
// free tier that explicitly permits this kind of commercial/automated use.
// Every successful match also gets logged with its source, source ID/page
// link and license into an asset manifest (see writeAssetManifest below) —
// "store the source URL and license information for every downloaded
// asset," per the brief.
//
// Mixkit is deliberately NOT wired in here, even though it was requested as
// an additional source: Mixkit's own Terms of Service (clause 9(10), see
// https://mixkit.co/terms/) explicitly prohibits "scripts or bots to mass
// download Items," and they have no official API — the only way to pull
// from Mixkit programmatically would be scraping against that express
// prohibition. Robert can still hand-pick specific Mixkit clips for a
// specific video (drop the file straight into a segment's visual path),
// but this pipeline will not automate it.
//
// This pipeline also never pulls footage from YouTube, TikTok, Instagram,
// Facebook or news broadcasts — publicly visible is not the same as free to
// reuse, and none of those give a redistribution license the way the
// sources above do.
//
// Keys used (all optional — a source is silently skipped if its key isn't
// set, same pattern as the rest of this pipeline):
//   PEXELS_API_KEY, UNSPLASH_API_KEY (existing)
//   PIXABAY_API_KEY, COVERR_API_KEY (new)

import fs from "node:fs/promises";
import path from "node:path";

const PEXELS_KEY = process.env.PEXELS_API_KEY;
const UNSPLASH_KEY = process.env.UNSPLASH_API_KEY;
const PIXABAY_KEY = process.env.PIXABAY_API_KEY;
const COVERR_KEY = process.env.COVERR_API_KEY;

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

  // Pick the sharpest usable file: prefer the SMALLEST file that still
  // meets our 1920px target (no point downloading a much bigger 4K master
  // than we'll ever render at), but if nothing reaches 1920, fall back to
  // the LARGEST available rather than settling for something small.
  const MIN_TARGET_WIDTH = 1920;
  const files = (video.video_files || [])
    .filter((f) => f.file_type === "video/mp4" && f.width)
    .sort((a, b) => b.width - a.width); // largest first
  const bigEnough = files.filter((f) => f.width >= MIN_TARGET_WIDTH);
  const file = bigEnough.length ? bigEnough[bigEnough.length - 1] : files[0];
  if (!file) return null;

  return {
    url: file.link,
    type: "video",
    durationSec: video.duration,
    source: "Pexels",
    sourceId: String(video.id),
    pageUrl: video.url || `https://www.pexels.com/video/${video.id}/`,
    license: "Pexels License (free for commercial use, no attribution required)",
  };
}

/** Secondary video source: Pixabay's official Video API (pixabay.com/api/docs/). */
async function findPixabayVideo(query) {
  if (!PIXABAY_KEY) return null;
  const res = await fetch(
    `https://pixabay.com/api/videos/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&orientation=horizontal&per_page=5&safesearch=true`
  );
  if (!res.ok) return null;
  const data = await res.json();
  const hit = data.hits?.[0];
  if (!hit) return null;

  // Pixabay returns a fixed set of named renditions (large/medium/small/tiny)
  // rather than a list of arbitrary widths — take the biggest one present.
  const rendition = hit.videos?.large?.url
    ? hit.videos.large
    : hit.videos?.medium?.url
      ? hit.videos.medium
      : hit.videos?.small?.url
        ? hit.videos.small
        : null;
  if (!rendition?.url) return null;

  return {
    url: rendition.url,
    type: "video",
    durationSec: hit.duration,
    source: "Pixabay",
    sourceId: String(hit.id),
    pageUrl: hit.pageURL || `https://pixabay.com/videos/id-${hit.id}/`,
    license: "Pixabay Content License (free for commercial use, no attribution required)",
  };
}

/** Additional video source: Coverr's official Content API (api.coverr.co/docs). */
async function findCoverrVideo(query) {
  if (!COVERR_KEY) return null;
  const res = await fetch(
    `https://api.coverr.co/videos?query=${encodeURIComponent(query)}&urls=true&page_size=5`,
    { headers: { Authorization: `Bearer ${COVERR_KEY}` } }
  );
  if (!res.ok) return null;
  const data = await res.json();
  const hit = data.hits?.[0];
  if (!hit) return null;

  const fileUrl = hit.urls?.mp4_download || hit.urls?.mp4 || hit.urls?.mp4_preview;
  if (!fileUrl) return null;

  return {
    url: fileUrl,
    type: "video",
    durationSec: hit.duration,
    source: "Coverr",
    sourceId: String(hit.id),
    pageUrl: `https://coverr.co/videos/${hit.id}`,
    license: "Coverr License (free for commercial use — see coverr.co/license)",
  };
}

/** Secondary photo source: Pixabay's Image API. */
async function findPixabayPhoto(query) {
  if (!PIXABAY_KEY) return null;
  const res = await fetch(
    `https://pixabay.com/api/?key=${PIXABAY_KEY}&q=${encodeURIComponent(query)}&orientation=horizontal&per_page=5&safesearch=true&image_type=photo`
  );
  if (!res.ok) return null;
  const data = await res.json();
  const hit = data.hits?.[0];
  if (!hit) return null;
  const url = hit.largeImageURL || hit.webformatURL;
  if (!url) return null;
  return {
    url,
    type: "image",
    source: "Pixabay",
    sourceId: String(hit.id),
    pageUrl: hit.pageURL || `https://pixabay.com/photos/id-${hit.id}/`,
    license: "Pixabay Content License (free for commercial use, no attribution required)",
  };
}

/** Fallback chain: Pexels -> Pixabay -> Unsplash. */
async function findPhoto(query) {
  if (PEXELS_KEY) {
    const res = await fetch(
      `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: PEXELS_KEY } }
    );
    if (res.ok) {
      const data = await res.json();
      const photo = data.photos?.[0];
      if (photo) {
        return {
          url: photo.src.large2x || photo.src.large,
          type: "image",
          source: "Pexels",
          sourceId: String(photo.id),
          pageUrl: photo.url || `https://www.pexels.com/photo/${photo.id}/`,
          license: "Pexels License (free for commercial use, no attribution required)",
        };
      }
    }
  }

  const pixabayPhoto = await findPixabayPhoto(query).catch(() => null);
  if (pixabayPhoto) return pixabayPhoto;

  if (UNSPLASH_KEY) {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${UNSPLASH_KEY}` } }
    );
    if (res.ok) {
      const data = await res.json();
      const photo = data.results?.[0];
      if (photo) {
        return {
          url: photo.urls.regular,
          type: "image",
          source: "Unsplash",
          sourceId: String(photo.id),
          pageUrl: photo.links?.html || `https://unsplash.com/photos/${photo.id}`,
          license: "Unsplash License (free for commercial use, no attribution required)",
        };
      }
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
 * term across all real video sources first (Pexels -> Pixabay -> Coverr, so
 * a named place always wins over a generic clip), then falls back to photos
 * with the same terms (Pexels -> Pixabay -> Unsplash).
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
    for (const finder of [findPexelsVideo, findPixabayVideo, findCoverrVideo]) {
      const video = await finder(term).catch(() => null);
      if (video) {
        const dest = path.join(outDir, `segment_${index}_raw.mp4`);
        await downloadTo(video.url, dest);
        return {
          type: "video",
          path: dest,
          matchedTerm: term,
          source: video.source,
          sourceId: video.sourceId,
          pageUrl: video.pageUrl,
          license: video.license,
        };
      }
    }
  }

  for (const term of terms) {
    const photo = await findPhoto(term).catch(() => null);
    if (photo) {
      const ext = photo.url.includes(".png") ? "png" : "jpg";
      const dest = path.join(outDir, `segment_${index}_raw.${ext}`);
      await downloadTo(photo.url, dest);
      return {
        type: "image",
        path: dest,
        matchedTerm: term,
        source: photo.source,
        sourceId: photo.sourceId,
        pageUrl: photo.pageUrl,
        license: photo.license,
      };
    }
  }

  // last-resort: no visual found for any search term — caller should fall
  // back to a branded placeholder/title card rather than leaving a gap.
  return null;
}

/**
 * Downloads a country flag PNG from flagcdn.com — a free, no-key-required
 * public CDN (https://flagcdn.com/h240/{code}.png) — for the Top-10 style
 * rank badge overlay. Returns null (never throws) if the code is missing/
 * malformed or the download fails, so a bad/unknown code just skips the
 * badge rather than breaking the segment.
 *
 * @param {string} countryCode - ISO 3166-1 alpha-2 code, e.g. "ke" for Kenya
 * @param {string} outDir
 */
export async function fetchFlag(countryCode, outDir) {
  const code = (countryCode || "").trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(code)) return null;

  await fs.mkdir(outDir, { recursive: true });
  const dest = path.join(outDir, `flag_${code}.png`);
  try {
    await downloadTo(`https://flagcdn.com/h240/${code}.png`, dest);
    return dest;
  } catch {
    return null;
  }
}

/**
 * Writes a per-video asset manifest — one JSON array with an entry for
 * every downloaded visual/audio asset (source, source ID, page link,
 * license, which segment it was used for). This is the "store the source
 * URL and license information for every downloaded asset" record from the
 * channel-upgrade brief; it never affects the render, so a failure here is
 * logged and swallowed rather than breaking the pipeline.
 *
 * @param {Array<object>} entries
 * @param {string} outPath
 */
export async function writeAssetManifest(entries, outPath) {
  try {
    await fs.writeFile(outPath, JSON.stringify(entries, null, 2));
  } catch (err) {
    console.warn(`[asset-manifest] failed to write ${outPath}: ${err.message}`);
  }
}
