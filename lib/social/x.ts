// Posts a photo + caption to X (Twitter). Posting your own content is on
// X's free API tier - it's only search/read access that's paywalled - so
// this needs no paid plan, just a developer app with read+write permissions.
//
// X's media upload endpoint predates API v2 and still only accepts OAuth 1.0a
// user-context signing (there's no v2 equivalent), so both the media upload
// and the tweet-creation calls below are signed that way for consistency.
// Node's built-in crypto module handles the HMAC-SHA1 signature - no extra
// dependency needed.

import crypto from "crypto";

function oauthEncode(str: string): string {
  // OAuth 1.0a's percent-encoding (RFC 3986) is stricter than
  // encodeURIComponent - it also encodes !, *, ', (, ) which
  // encodeURIComponent leaves alone.
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function buildOAuthHeader(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerKey: string,
  consumerSecret: string,
  token: string,
  tokenSecret: string
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };

  // The signature covers ALL params (oauth params + request params),
  // sorted by key - this only applies to form-urlencoded body params or
  // query params, never a JSON body (X's tweet-creation call has no
  // extra params here for that reason).
  const allParams = { ...oauthParams, ...params };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${oauthEncode(k)}=${oauthEncode(allParams[k])}`)
    .join("&");

  const baseString = [method.toUpperCase(), oauthEncode(url), oauthEncode(paramString)].join(
    "&"
  );

  const signingKey = `${oauthEncode(consumerSecret)}&${oauthEncode(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams: Record<string, string> = { ...oauthParams, oauth_signature: signature };
  return (
    "OAuth " +
    Object.keys(headerParams)
      .sort()
      .map((k) => `${oauthEncode(k)}="${oauthEncode(headerParams[k])}"`)
      .join(", ")
  );
}

export async function postToX(
  photoUrl: string,
  caption: string,
  articleLink: string
): Promise<{ tweetId: string }> {
  // .trim() guards against a stray space/newline from copy-pasting a
  // secret into Vercel's env var UI - even one invisible character here
  // breaks the OAuth signature and produces "Bad Authentication data"
  // (error 215) with no other indication of what's wrong.
  const consumerKey = process.env.X_API_KEY?.trim();
  const consumerSecret = process.env.X_API_SECRET?.trim();
  const token = process.env.X_ACCESS_TOKEN?.trim();
  const tokenSecret = process.env.X_ACCESS_TOKEN_SECRET?.trim();
  if (!consumerKey || !consumerSecret || !token || !tokenSecret) {
    throw new Error("X (Twitter) credentials not set");
  }

  // Step 1: download the image and upload it via X's (still-v1.1) media
  // endpoint - simple base64 upload, no chunking, since our branded/K24
  // card images are well under the 5MB limit for this path.
  const imgRes = await fetch(photoUrl);
  if (!imgRes.ok) {
    throw new Error(`Could not download image for X: ${imgRes.status}`);
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.byteLength > 5 * 1024 * 1024) {
    throw new Error("Image too large for X's simple media upload (5MB limit)");
  }
  const mediaData = buf.toString("base64");

  const uploadUrl = "https://upload.twitter.com/1.1/media/upload.json";
  const uploadParams = { media_data: mediaData };
  const uploadAuth = buildOAuthHeader(
    "POST",
    uploadUrl,
    uploadParams,
    consumerKey,
    consumerSecret,
    token,
    tokenSecret
  );

  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: uploadAuth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(uploadParams).toString(),
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok) {
    throw new Error(`X media upload failed: ${JSON.stringify(uploadData)}`);
  }
  const mediaId = uploadData.media_id_string;

  // Step 2: post the tweet with the uploaded media + caption + link. X
  // shortens ANY link to 23 characters via t.co regardless of its real
  // length, so trim the caption to comfortably fit the 280-char limit
  // alongside that fixed-width link rather than risking a rejected post.
  const linkPlaceholderLength = 23;
  const maxCaptionLength = 280 - linkPlaceholderLength - 1; // 1 for the newline
  const trimmedCaption =
    caption.length > maxCaptionLength
      ? caption.slice(0, maxCaptionLength - 1).trimEnd() + "\u2026"
      : caption;
  const text = `${trimmedCaption}\n${articleLink}`;

  const tweetUrl = "https://api.twitter.com/2/tweets";
  const tweetAuth = buildOAuthHeader(
    "POST",
    tweetUrl,
    {},
    consumerKey,
    consumerSecret,
    token,
    tokenSecret
  );

  const tweetRes = await fetch(tweetUrl, {
    method: "POST",
    headers: {
      Authorization: tweetAuth,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, media: { media_ids: [mediaId] } }),
  });
  const tweetData = await tweetRes.json();
  if (!tweetRes.ok) {
    throw new Error(`X post failed: ${JSON.stringify(tweetData)}`);
  }

  return { tweetId: tweetData.data.id };
}
