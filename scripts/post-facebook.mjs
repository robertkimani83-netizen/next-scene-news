const SITE_URL = process.env.SITE_URL;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const CRON_SECRET = process.env.CRON_SECRET;

const POSTS_PER_RUN = 3;

async function getArticle() {
  const res = await fetch(
    `${SITE_URL}/api/social/next-article`
  );

  if (!res.ok) return null;

  return res.json();
}

// Extra safety check.
// The website/API already validates the card before releasing
// the article, but GitHub verifies it again before Make receives it.
async function validateCard(imageUrl) {
  try {
    const res = await fetch(imageUrl, {
      method: 'GET',
      headers: {
        Accept: 'image/png,image/jpeg,image/webp,image/*',
      },
    });

    const contentType =
      res.headers.get('content-type')?.toLowerCase() || '';

    if (!res.ok) {
      console.log(
        `Card validation failed: HTTP ${res.status}`
      );
      return false;
    }

    if (!contentType.startsWith('image/')) {
      console.log(
        `Card validation failed: ${contentType}`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.log(
      'Card validation failed:',
      err.message
    );
    return false;
  }
}

async function postToFacebook(article) {
  const body = {
    title: article.title,
    teaser: article.teaser,
    image: article.imageUrl,
    link: article.articleUrl,
    facebookCaption: article.facebookCaption,
  };

  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      'Make webhook post failed: ' +
        res.status +
        ' ' +
        text
    );
  }

  console.log(
    'Make webhook response:',
    text
  );

  return text;
}

async function confirmFacebookPost(id) {
  if (!CRON_SECRET) {
    throw new Error(
      'CRON_SECRET is not configured in GitHub Actions'
    );
  }

  const res = await fetch(
    `${SITE_URL}/api/social/confirm-facebook`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ id }),
    }
  );

  const text = await res.text();

  if (!res.ok) {
    throw new Error(
      'Facebook confirmation failed: ' +
        res.status +
        ' ' +
        text
    );
  }

  console.log(
    'Facebook posting confirmed by website:',
    text
  );

  return text;
}

async function releaseClaim(id) {
  // If Make fails, release the temporary claim so the
  // article can be selected again on a later run.
  //
  // We intentionally don't fail the whole GitHub run if this
  // cleanup request fails because the claim expires automatically.
  try {
    if (!CRON_SECRET) return;

    const res = await fetch(
      `${SITE_URL}/api/social/release-facebook`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ id }),
      }
    );

    console.log(
      'Released Facebook claim:',
      res.status
    );
  } catch (err) {
    console.log(
      'Could not release Facebook claim:',
      err.message
    );
  }
}

async function main() {
  if (!SITE_URL) {
    console.log(
      'SITE_URL is not set. Aborting.'
    );
    process.exit(1);
  }

  if (!MAKE_WEBHOOK_URL) {
    console.log(
      'MAKE_WEBHOOK_URL is not set. Aborting.'
    );
    process.exit(1);
  }

  if (!CRON_SECRET) {
    console.log(
      'CRON_SECRET is not set. Aborting.'
    );
    process.exit(1);
  }

  for (
    let i = 0;
    i < POSTS_PER_RUN;
    i++
  ) {
    console.log(
      `\n--- Post ${i + 1} of ${POSTS_PER_RUN} ---`
    );

    const article =
      await getArticle();

    if (!article) {
      console.log(
        'No more eligible Facebook articles available. Stopping.'
      );
      break;
    }

    console.log(
      'Selected:',
      article.title
    );

    // The API already performed this check.
    // This is a second independent safety gate.
    const validCard =
      await validateCard(article.imageUrl);

    if (!validCard) {
      console.log(
        'STOPPED: article has no valid Facebook card. It will NOT be sent to Make.'
      );

      await releaseClaim(article.id);

      continue;
    }

    // --------------------------------------------------
    // STEP 1: Send to Make
    // --------------------------------------------------

    try {
      // Make/Facebook gets the article ONLY after
      // the card has been validated.
      await postToFacebook(article);

      console.log(
        'Make accepted the Facebook post.'
      );
    } catch (err) {
      console.log(
        'MAKE FAILED:',
        err.message
      );

      // Make did not accept the post.
      // It is safe to release the claim so the article
      // can be retried later.
      await releaseClaim(article.id);

      continue;
    }

    // --------------------------------------------------
    // STEP 2: Confirm on website
    // --------------------------------------------------

    try {
      await confirmFacebookPost(
        article.id
      );

      console.log(
        'SUCCESS: Facebook article marked as posted.'
      );
    } catch (err) {
      // VERY IMPORTANT:
      //
      // Make already accepted the post.
      // Do NOT release the claim here because doing so
      // could cause the same article to be posted again.
      console.error(
        'WARNING: Make accepted the Facebook post, but website confirmation failed:',
        err.message
      );

      console.error(
        'The Facebook claim was NOT released to prevent a possible duplicate post.'
      );
    }
  }
}

main().catch((err) => {
  console.error(
    'Fatal Facebook script error:',
    err
  );

  process.exit(1);
});