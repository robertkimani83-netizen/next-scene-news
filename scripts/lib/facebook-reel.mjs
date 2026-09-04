// Publishes a finished local video file as a Facebook Reel on the VOX254
// Page, via the Graph API's resumable-upload flow for Reels
// (POST /{page-id}/video_reels, phases: start -> upload bytes -> finish).
//
// Reuses the exact same Page credentials already configured for the
// article-photo pipeline (see lib/social/facebook.ts): FACEBOOK_PAGE_ID +
// FACEBOOK_PAGE_ACCESS_TOKEN, both already set as GitHub Actions secrets.
// This is intentionally plain fetch (no SDK), matching the style of
// scripts/lib/youtube.mjs.

const GRAPH_VERSION = "v20.0";

/**
 * @param {string} videoPath - local path to a finished mp4 (portrait video
 *   works best for Reels, but Facebook will accept most common formats)
 * @param {string} description - Reel caption (Facebook truncates well
 *   beyond what's needed for a Short's description, but we cap it anyway)
 * @param {string|null} [articleLink] - when set, posted as the first
 *   comment on the published Reel (same "link in the first comment, not
 *   the caption" convention already used for photo posts in
 *   lib/social/facebook.ts, so the Reel itself stays algorithm-friendly)
 * @returns {Promise<{ reelId: string }>}
 */
export async function postFacebookReel(videoPath, description, articleLink = null) {
  const fs = await import("node:fs/promises");

  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) {
    throw new Error("Facebook credentials not set (FACEBOOK_PAGE_ID / FACEBOOK_PAGE_ACCESS_TOKEN)");
  }

  const videoBuffer = await fs.readFile(videoPath);
  const fileSize = videoBuffer.byteLength;

  // Phase 1: start an upload session — returns a video_id + upload_url.
  const startRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ upload_phase: "start", access_token: token }),
  });
  const startData = await startRes.json();
  if (!startRes.ok || !startData.video_id || !startData.upload_url) {
    throw new Error("Facebook Reel start-phase failed: " + JSON.stringify(startData));
  }
  const { video_id, upload_url } = startData;

  // Phase 2: upload the raw video bytes to the session's upload_url. This
  // is the same "Resumable Upload API" protocol Facebook uses for regular
  // video uploads — one shot works fine for files this small (Shorts run
  // well under a minute), no need to chunk.
  const uploadRes = await fetch(upload_url, {
    method: "POST",
    headers: {
      Authorization: `OAuth ${token}`,
      "Content-Type": "application/octet-stream",
      offset: "0",
      file_size: String(fileSize),
    },
    body: videoBuffer,
  });
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || uploadData.success === false) {
    throw new Error("Facebook Reel upload-phase failed: " + JSON.stringify(uploadData));
  }

  // Phase 3: finish the session and publish the Reel.
  const finishRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/video_reels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      upload_phase: "finish",
      video_id,
      video_state: "PUBLISHED",
      description: description.slice(0, 2200),
      access_token: token,
    }),
  });
  const finishData = await finishRes.json();
  if (!finishRes.ok || finishData.success === false) {
    throw new Error("Facebook Reel finish-phase failed: " + JSON.stringify(finishData));
  }

  if (articleLink) {
    const commentRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${video_id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Full story: ${articleLink}`, access_token: token }),
    });
    if (!commentRes.ok) {
      console.error("Facebook Reel comment failed:", await commentRes.text());
    }
  }

  return { reelId: video_id };
}
