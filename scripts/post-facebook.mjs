const SITE_URL = process.env.SITE_URL;
const PAGE_ID = process.env.FACEBOOK_PAGE_ID;
const PAGE_ACCESS_TOKEN = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const POSTS_PER_RUN = 3;

async function getArticle() {
  const res = await fetch(`${SITE_URL}/api/social/next-article`);
  if (!res.ok) return null;
  return res.json();
}

async function postToFacebook(article) {
  const caption = `${article.title}\n\n${article.teaser}\n\nRead full story: ${article.articleUrl}`;

  const params = new URLSearchParams({
    url: article.imageUrl,
    caption,
    access_token: PAGE_ACCESS_TOKEN,
  });

  const res = await fetch(`https://graph.facebook.com/v26.0/${PAGE_ID}/photos`, {
    method: 'POST',
    body: params,
  });

  const data = await res.json();
  if (!res.ok) throw new Error('Facebook post failed: ' + JSON.stringify(data));
  return data;
}

async function main() {
  for (let i = 0; i < POSTS_PER_RUN; i++) {
    console.log(`\n--- Post ${i + 1} of ${POSTS_PER_RUN} ---`);
    const article = await getArticle();

    if (!article) {
      console.log('No more unposted articles available. Stopping.');
      break;
    }

    console.log('Posting:', article.title);
    const result = await postToFacebook(article);
    console.log('Posted! Post ID:', result.post_id || result.id);
  }
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
