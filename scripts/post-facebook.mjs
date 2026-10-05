// Function to convert Gemini's stylized faux-Unicode bold/italic text into normal clean text
function normalizeUnicodeText(text) {
  if (!text) return "";
  return text
    // Bold Serif (e.g., 𝐐, 𝐚)
    .replace(/[\uD835][\uDC00-\uDC33]/g, m => String.fromCharCode(m.charCodeAt(0) * 0x400 + m.charCodeAt(1) - 0x35400 + 65))
    .replace(/[\uD835][\uDC34-\uDC67]/g, m => String.fromCharCode(m.charCodeAt(0) * 0x400 + m.charCodeAt(1) - 0x35434 + 97))
    // Bold Sans-Serif (e.g., 𝝠, 𝝥 / 𝗔, 𝗮)
    .replace(/[\uD835][\uDFEC-\uE01F]/g, m => String.fromCharCode(m.charCodeAt(0) * 0x400 + m.charCodeAt(1) - 0x35FEC + 65))
    .replace(/[\uD835][\uE020-\uE053]/g, m => String.fromCharCode(m.charCodeAt(0) * 0x400 + m.charCodeAt(1) - 0x36020 + 97))
    // Monospace / Alternative blocks (e.g., 𝖳, 𝗁)
    .replace(/[\uD835][\uDDE2-\uDE1B]/g, m => String.fromCharCode(m.charCodeAt(0) * 0x400 + m.charCodeAt(1) - 0x35DE2 + 65))
    .replace(/[\uD835][\uDE1C-\uDE55]/g, m => String.fromCharCode(m.charCodeAt(0) * 0x400 + m.charCodeAt(1) - 0x35DE2 + 97))
    // Direct fallbacks for remaining complex multi-byte characters
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, ""); 
}
const SITE_URL = process.env.SITE_URL;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

const POSTS_PER_RUN = 3;

// Oct 2026: post straight to the Facebook Graph API. Make's free plan
// (1,000 credits/month) ran out, so Make kept replying "Accepted" while
// nothing was published. Make is now only a fallback when no Page token is set.
const FB_TOKEN = (process.env.FACEBOOK_PAGE_ACCESS_TOKEN || '').trim();
const FB_PAGE_ID = (process.env.FACEBOOK_PAGE_ID || '').trim();
const GRAPH = 'https://graph.facebook.com/v26.0';
const DIRECT = Boolean(FB_TOKEN && FB_PAGE_ID);

function buildCaption(article) {
  const base = String(article.facebookCaption || [article.title, article.teaser].filter(Boolean).join('\n\n')).trim();
  if (article.articleUrl && !base.includes(article.articleUrl)) {
    return base + '\n\nRead more: ' + article.articleUrl;
  }
  return base;
}

async function postDirectToFacebook(article) {
  const body = new URLSearchParams({
    url: article.imageUrl,
    caption: buildCaption(article),
    access_token: FB_TOKEN,
  });
  const res = await fetch(GRAPH + '/' + FB_PAGE_ID + '/photos', { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error('Facebook Graph API ' + res.status + ': ' + (data && data.error ? data.error.message : JSON.stringify(data)));
  }
  console.log('Published on Facebook. Post id:', data.post_id || data.id);
  return data;
}

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
  if (DIRECT) return postDirectToFacebook(article);

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
      // FIX: Added explicit UTF-8 charset to headers to enforce clean payload serialization
      'Content-Type': 'application/json; charset=utf-8',
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
        // FIX: Enforced UTF-8 charset matching rules for consistency
        'Content-Type': 'application/json; charset=utf-8',
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
          'Content-Type': 'application/json; charset=utf-8',
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

  if (!DIRECT && !MAKE_WEBHOOK_URL) {
    console.log(
      'Neither FACEBOOK_PAGE_ACCESS_TOKEN/FACEBOOK_PAGE_ID nor MAKE_WEBHOOK_URL is set. Aborting.'
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
      // Retry: a single failed confirmation used to leave the article
      // unmarked, so a later run could post the same story again.
      let lastErr;
      let confirmed = false;
      for (let attempt = 1; attempt <= 4 && !confirmed; attempt++) {
        try {
          await confirmFacebookPost(article.id);
          confirmed = true;
        } catch (e) {
          lastErr = e;
          console.log(`Confirmation attempt ${attempt} failed: ${e.message}`);
          if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000));
        }
      }
      if (!confirmed) throw lastErr;

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

      // Stop this run: without confirmation the site can't mark stories as
      // posted, so continuing could publish duplicates later.
      console.error('Stopping this run until the website confirmation (CRON_SECRET) works again.');
      process.exitCode = 1;
      break;
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
