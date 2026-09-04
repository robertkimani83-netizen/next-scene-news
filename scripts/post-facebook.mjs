const SITE_URL = process.env.SITE_URL;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const POSTS_PER_RUN = 3;

async function getArticle() {
  const res = await fetch(`${SITE_URL}/api/social/next-article`);
  if (!res.ok) return null;
  return res.json();
}

async function postToFacebook(article) {
  // Posts through the Make.com scenario (Webhooks -> Facebook Pages: Create a Post)
  // instead of calling the Facebook Graph API directly.
  const body = {
    title: article.title,
    teaser: article.teaser,
    image: article.imageUrl,
    link: article.articleUrl,
  };

  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error('Make webhook post failed: ' + res.status + ' ' + text);

  console.log('Make webhook response:', text);
  return text;
}

async function main() {
  if (!MAKE_WEBHOOK_URL) {
    console.log('MAKE_WEBHOOK_URL is not set. Aborting.');
    process.exit(1);
  }

  for (let i = 0; i < POSTS_PER_RUN; i++) {
    console.log(`\n--- Post ${i + 1} of ${POSTS_PER_RUN} ---`);
    const article = await getArticle();

    if (!article) {
      console.log('No more unposted articles available. Stopping.');
      break;
    }

    console.log('Posting:', article.title);
    try {
      await postToFacebook(article);
      console.log('Sent to Make webhook successfully.');
    } catch (err) {
      console.log('FAILED:', err.message);
    }
  }
}

main();
