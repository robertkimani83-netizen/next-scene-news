// Posts a photo + caption to a Facebook Page, then adds the article link
// as the FIRST COMMENT rather than in the post body. This is a deliberate
// choice, not a workaround: Facebook's algorithm suppresses reach on posts
// with outbound links in the caption, so posting the link as a comment
// keeps the post itself "link-free" while the link is still one tap away.

const GRAPH_VERSION = "v20.0";

export async function postToFacebook(
  photoUrl: string,
  caption: string,
  articleLink: string
): Promise<{ postId: string }> {
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  if (!pageId || !token) throw new Error("Facebook credentials not set");

  // Step 1: publish the photo with the caption (no link)
  const postRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${pageId}/photos`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: photoUrl,
        caption,
        access_token: token,
      }),
    }
  );
  const postData = await postRes.json();
  if (!postRes.ok) throw new Error(`Facebook post failed: ${JSON.stringify(postData)}`);

  const postId = postData.post_id ?? postData.id;

  // Step 2: add the article link as the first comment
  const commentRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${postId}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Full story: ${articleLink}`,
        access_token: token,
      }),
    }
  );
  if (!commentRes.ok) {
    console.error("Facebook comment failed:", await commentRes.text());
  }

  return { postId };
}
