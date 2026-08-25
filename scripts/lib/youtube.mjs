// Shared YouTube OAuth + upload logic for both pipelines (long-form
// documentaries and Shorts) — same channel, same refresh token, same raw-
// fetch multipart upload pattern already used in scripts/generate-video.mjs
// (no extra "googleapis" dependency needed).

async function getAccessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Failed to get YouTube access token: " + JSON.stringify(data));
  return data.access_token;
}

/**
 * @param {string} videoPath
 * @param {string} title
 * @param {string} description
 * @param {{tags?: string[], categoryId?: string}} opts
 */
export async function uploadToYouTube(videoPath, title, description, opts = {}) {
  const fs = await import("node:fs/promises");
  const { tags = ["geopolitics", "top10", "future predictions", "world power ranking"], categoryId = "25" } = opts;

  const accessToken = await getAccessToken();
  const videoBuffer = await fs.readFile(videoPath);

  const metadata = {
    snippet: {
      title: title.slice(0, 100),
      description: description.slice(0, 4900),
      tags,
      categoryId, // 25 = News & Politics
    },
    status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
  };

  const boundary = "nextscenedocumentaryboundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`),
    videoBuffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const uploadRes = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  const result = await uploadRes.json();
  if (!uploadRes.ok) throw new Error("YouTube upload failed: " + JSON.stringify(result));
  return result;
}

/** Finds an existing playlist on this channel with an exact title match, or
 * creates one. Used so every upload can be filed into a themed playlist
 * (grouping helps session watch time, which the algorithm rewards) without
 * ever creating a duplicate playlist across separate runs. */
export async function getOrCreatePlaylist(title, description) {
  const accessToken = await getAccessToken();

  const listRes = await fetch(
    "https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true&maxResults=50",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const listData = await listRes.json();
  if (!listRes.ok) throw new Error("YouTube playlist lookup failed: " + JSON.stringify(listData));
  const existing = (listData.items || []).find((p) => p.snippet?.title === title);
  if (existing) return existing.id;

  const createRes = await fetch("https://www.googleapis.com/youtube/v3/playlists?part=snippet,status", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { title, description },
      status: { privacyStatus: "public" },
    }),
  });
  const createData = await createRes.json();
  if (!createRes.ok) throw new Error("YouTube playlist creation failed: " + JSON.stringify(createData));
  return createData.id;
}

/** Adds a video to a playlist. Safe to call once per upload — YouTube allows
 * the same video in a playlist only once, and this is never called twice for
 * the same video in this pipeline. */
export async function addVideoToPlaylist(playlistId, videoId) {
  const accessToken = await getAccessToken();
  const res = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?part=snippet", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      snippet: { playlistId, resourceId: { kind: "youtube#video", videoId } },
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("YouTube add-to-playlist failed: " + JSON.stringify(data));
  return data;
}
