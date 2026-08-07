// Instagram posting is a two-step "container" process: create a media
// container, then publish it. Instagram captions can't contain clickable
// links at all (only the bio link is clickable), so the article link is
// posted as the first comment - the closest thing to a working link on IG.

const GRAPH_VERSION = "v20.0";

export async function postToInstagram(
  photoUrl: string,
  caption: string,
  articleLink: string
): Promise<{ postId: string }> {
  const igUserId = process.env.IG_BUSINESS_ACCOUNT_ID;
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN; // IG uses the same token as the linked FB Page
  if (!igUserId || !token) throw new Error("Instagram credentials not set");

  // Step 1: create a media container
  const containerRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: photoUrl,
        caption,
        access_token: token,
      }),
    }
  );
  const containerData = await containerRes.json();
  if (!containerRes.ok) {
    throw new Error(`Instagram container failed: ${JSON.stringify(containerData)}`);
  }

  // Step 2: publish the container
  const publishRes = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${igUserId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: containerData.id,
        access_token: token,
      }),
    }
  );
  const publishData = await publishRes.json();
  if (!publishRes.ok) {
    throw new Error(`Instagram publish failed: ${JSON.stringify(publishData)}`);
  }

  const postId = publishData.id;

  // Step 3: add the article link as the first comment
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
    console.error("Instagram comment failed:", await commentRes.text());
  }

  return { postId };
}
