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
