import { NextResponse } from 'next/server';
import {
  loadArticles,
  getDailyPacedCount,
  DAILY_PACED_LIMIT,
  areLikelyDuplicateHeadlines,
} from '@/lib/store';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL =
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://next-scene-news-897q.vercel.app';

// Bump whenever the OG renderer changes. Facebook/Make then receives a new
// image URL instead of reusing an older cached card.
const OG_CARD_VERSION = '4';

async function isPosted(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;

  try {
    const res = await fetch(`${REDIS_URL}/get/facebook-posted:${id}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      cache: 'no-store',
    });
    const data = await res.json();
    return !!data.result;
  } catch {
    return false;
  }
}

async function isClaimed(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;

  try {
    const res = await fetch(`${REDIS_URL}/get/facebook-claim:${id}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      cache: 'no-store',
    });
    const data = await res.json();
    return !!data.result;
  } catch {
    return false;
  }
}

async function claimArticle(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;

  await fetch(`${REDIS_URL}/set/facebook-claim:${id}/1/EX/1800`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
}

async function hasValidCard(imageUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(imageUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/*' },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(`Facebook card validation failed: HTTP ${res.status} ${imageUrl}`);
      return false;
    }

    const contentType = res.headers.get('content-type')?.toLowerCase() || '';
    if (!contentType.startsWith('image/')) {
      console.error(`Facebook card validation failed: invalid content-type "${contentType}"`);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Facebook card validation failed:', err);
    return false;
  }
}

export async function GET() {
  try {
    const articles = await loadArticles();
    const pacedPostedToday = await getDailyPacedCount();
    const dailyCapReached = pacedPostedToday >= DAILY_PACED_LIMIT;

    // Newest articles are first. Once one headline represents an event, do
    // not release another substantially identical rewrite from another RSS
    // source to Facebook.
    const seenHeadlines: string[] = [];

    for (const article of articles) {
      if (await isPosted(article.id)) continue;
      if (await isClaimed(article.id)) continue;

      // Protect against the older direct Facebook publisher as well. If an
      // article was already marked posted in the persistent article store,
      // the Make publisher must never publish it a second time.
      if (article.postedTo?.facebook) continue;

      const isBreaking = article.importance === 'breaking';
      if (!isBreaking && dailyCapReached) continue;

      if (seenHeadlines.some((headline) => areLikelyDuplicateHeadlines(headline, article.headline))) {
        console.log(`Skipping duplicate Facebook story: ${article.headline}`);
        continue;
      }
      seenHeadlines.push(article.headline);

      // Facebook cards are never allowed to be blank/gradient-only. The
      // article must have a real stored photo or an honest contextual file
      // photo before it enters the Make/Facebook pipeline.
      const hasStoredPhoto = Boolean(
        (article.photo?.url && !article.photo.url.includes('/api/og/')) ||
        article.photo?.softBackgroundUrl
      );

      if (!hasStoredPhoto) {
        console.log(`Skipping "${article.headline}" because it has no usable photo.`);
        continue;
      }

      const imageUrl = `${SITE_URL}/api/og/${article.id}?v=${OG_CARD_VERSION}`;

      // Website-level image validation is the release gate.
      const validCard = await hasValidCard(imageUrl);
      if (!validCard) {
        console.log(`Skipping "${article.headline}" because its Facebook card is invalid.`);
        continue;
      }

      // Do NOT mark posted or increment the daily counter here. Confirmation
      // happens only after Make accepts the Facebook post.
      await claimArticle(article.id);

      return NextResponse.json({
        id: article.id,
        title: article.headline,
        teaser: article.teaser,
        facebookCaption:
          article.facebookCaption ||
          `${article.headline}\n${article.teaser}`,
        imageUrl,
        articleUrl: `${SITE_URL}/article/${article.id}`,
      });
    }

    if (dailyCapReached) {
      return NextResponse.json(
        {
          error: `Daily normal Facebook post limit reached (${pacedPostedToday}/${DAILY_PACED_LIMIT} used today)`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      { error: 'No unposted articles with a unique story and valid photo found' },
      { status: 404 }
    );
  } catch (err: any) {
    console.error('next-article error:', err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
