// TikTok's Content Posting API supports photo posts (a slideshow of one
// image works fine for a news-story format). IMPORTANT LIMITATION:
// TikTok's public API does not currently offer a documented endpoint for
// posting a comment on your own content programmatically. So for TikTok,
// the article link goes directly in the caption instead - TikTok doesn't
// penalize captions with links the way Facebook does, so this isn't a
// downgrade, just a different platform convention.

export async function postToTikTok(
  photoUrl: string,
  caption: string,
  articleLink: string
): Promise<{ publishId: string }> {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  if (!token) throw new Error("TikTok credentials not set");

  const fullCaption = `${caption}\n\nFull story: ${articleLink}`;

  const res = await fetch(
    "https://open.tiktokapis.com/v2/post/publish/content/init/",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        post_info: {
          title: fullCaption,
          privacy_level: "PUBLIC_TO_EVERYONE",
          disable_comment: false,
        },
        source_info: {
          source: "PULL_FROM_URL",
          photo_images: [photoUrl],
          photo_cover_index: 0,
        },
        post_mode: "DIRECT_POST",
        media_type: "PHOTO",
      }),
    }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(`TikTok post failed: ${JSON.stringify(data)}`);

  return { publishId: data.data.publish_id };
}
