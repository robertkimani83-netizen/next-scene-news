const SITE_URL = process.env.SITE_URL;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const POSTS_PER_RUN = 3;

async function getArticle() {
  const res = await fetch(`${SITE_URL}/api/social/next-article`);
  if (!res.ok) return null;
  return res.json();
}

// Facebook's crawler fetches the article PAGE itself (not just the image)
// to read the og:image tag, the moment Make.com creates the post. If that
// page hasn't been hit yet, Vercel's serverless function for it is "cold"
// and can be slow enough that Facebook's scraper gives up - Facebook's own
// Sharing Debugger showed this happening as "Response Code 418 / Could Not
// Connect To Server" for an article whose live Facebook post had no photo,
// even though the og:image tag and the image itself were both fine once
// the page was warm. Hitting the article URL ourselves first warms up the
// function so Facebook's fetch, moments later, succeeds and gets the real
// og:image instead of leaving the post with a blank placeholder.
async function warmArticlePage(url) {
  try {
    const res = await fetch(url, { method: 'GET' });
    console.log(`Warmed article page (${res.status}): ${url}`);
  } catch (err) {
    console.log(`Warm-up request failed, continuing anyway: ${err.message}`);
  }
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
    await warmArticlePage(article.articleUrl);
    try {
      await postToFacebook(article);
      console.log('Sent to Make webhook successfully.');
    } catch (err) {
      console.log('FAILED:', err.message);
    }
  }
}

main();
