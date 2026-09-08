// Publishes a finished local video file as a Facebook Reel on the VOX254
// Page - via a dedicated Make.com scenario ("VOX254 Reel Auto-Post":
// Webhooks -> Facebook Pages "Publish a Reel"), not the Graph API directly.
//
// Why: the direct-API path (POST /{page-id}/video_reels) used
// FACEBOOK_PAGE_ACCESS_TOKEN, and the personal Facebook account behind
// that token got blocked, which broke publishing with an OAuthException
// (code 190, subcode 459) even though the Page itself was fine. Make's
// own "VOX254 Facebook connection" - the same one the existing
// link-posting scenario already uses successfully - is a separate,
// healthy connection, so routing through Make sidesteps the blocked
// account entirely instead of depending on it.
//
// The webhook call is multipart/form-data with the video's raw bytes as
// a file field - Make's "Publish a Reel" module reads the file straight
// out of the webhook payload (Upload method: Data file), so no video
// hosting / public URL is needed anywhere in this pipeline.

const MAKE_REEL_WEBHOOK_URL = process.env.MAKE_REEL_WEBHOOK_URL;

/**
 * @param {string} videoPath - local path to a finished mp4 (portrait video
 *   works best for Reels)
 * @param {string} title - short title for the video
 * @param {string} caption - Reel caption/description (hashtags supported)
 * @param {string} [articleUrl] - full article link, sent along in the
 *   webhook payload for reference/future use
 * @returns {Promise<void>}
 */
export async function postFacebookReel(videoPath, title, caption, articleUrl = "") {
  const fs = await import("node:fs/promises");

  if (!MAKE_REEL_WEBHOOK_URL) {
    throw new Error("MAKE_REEL_WEBHOOK_URL is not set");
  }

  const videoBuffer = await fs.readFile(videoPath);

  const form = new FormData();
  form.append("title", title);
  form.append("caption", caption);
  form.append("articleUrl", articleUrl);
  form.append("video", new Blob([videoBuffer], { type: "video/mp4" }), "reel.mp4");

  const res = await fetch(MAKE_REEL_WEBHOOK_URL, {
    method: "POST",
    body: form,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error("Make Reel webhook failed: " + res.status + " " + text);
  }

  console.log("Make Reel webhook response:", text);
}
