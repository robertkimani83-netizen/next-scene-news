import { NextResponse } from 'next/server';
import {
  loadArticles,
  getDailyPacedCount,
  DAILY_PACED_LIMIT,
  expectedPacedSlotsByNow,
} from '@/lib/store';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL =
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://next-scene-news-897q.vercel.app';

async function isPosted(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;

  try {
    const res = await fetch(
      `${REDIS_URL}/get/facebook-posted:${id}`,
      {
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
        },
        cache: 'no-store',
      }
    );

    const data = await res.json();
    return !!data.result;
  } catch {
    return false;
  }
}

// Temporary claim prevents two requests from selecting the same article
// before the Facebook post has been confirmed successful.
async function isClaimed(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;

  try {
    const res = await fetch(
      `${REDIS_URL}/get/facebook-claim:${id}`,
      {
        headers: {
          Authorization: `Bearer ${REDIS_TOKEN}`,
        },
        cache: 'no-store',
      }
    );

    const data = await res.json();
    return !!data.result;
  } catch {
    return false;
  }
}

async function claimArticle(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;

  // Claim expires after 30 minutes so a crashed GitHub run
  // cannot permanently lock an article.
  await fetch(
    `${REDIS_URL}/set/facebook-claim:${id}/1/EX/1800`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
      },
    }
  );
}

// Verify that the branded card really exists and is returning
// an image before this article is released to Make/Facebook.
async function hasValidCard(
  imageUrl: string
): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      15000
    );

    const res = await fetch(imageUrl, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        Accept: 'image/png,image/jpeg,image/webp,image/*',
      },
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.error(
        `Facebook card validation failed: HTTP ${res.status} ${imageUrl}`
      );
      return false;
    }

    const contentType =
      res.headers.get('content-type')?.toLowerCase() || '';

    if (!contentType.startsWith('image/')) {
      console.error(
        `Facebook card validation failed: invalid content-type "${contentType}"`
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error(
      'Facebook card validation failed:',
      err
    );
    return false;
  }
}

export async function GET() {
  try {
    const articles = await loadArticles();

    const pacedPostedToday =
      await getDailyPacedCount();

    const pacedSlotsAllowedByNow = Math.min(
      DAILY_PACED_LIMIT,
      expectedPacedSlotsByNow()
    );

    const pacedLimitReached =
      pacedPostedToday >= pacedSlotsAllowedByNow;

    let sawPacedCandidate = false;

    for (const article of articles) {
      if (await isPosted(article.id)) continue;
      if (await isClaimed(article.id)) continue;

      const isBreaking =
        article.importance === 'breaking';

      if (!isBreaking && pacedLimitReached) {
        sawPacedCandidate = true;
        continue;
      }

      const imageUrl =
        `${SITE_URL}/api/og/${article.id}`;

      // IMPORTANT:
      // The website itself is now the gatekeeper.
      // If the branded card cannot be generated and returned
      // as an actual image, this article is NOT released.
      const validCard =
        await hasValidCard(imageUrl);

      if (!validCard) {
        console.log(
          `Skipping "${article.headline}" because its Facebook card is invalid.`
        );
        continue;
      }

      // Do NOT mark the article as posted here.
      // Do NOT increment the daily counter here.
      //
      // Those happen only after Make/Facebook succeeds.
      await claimArticle(article.id);

      return NextResponse.json({
        id: article.id,
        title: article.headline,
        teaser: article.teaser,

        facebookCaption:
          article.facebookCaption ||
          `${article.headline}\n${article.teaser}`,

        imageUrl,

        articleUrl:
          `${SITE_URL}/article/${article.id}`,
      });
    }

    if (sawPacedCandidate) {
      return NextResponse.json(
        {
          error:
            `Daily pace limit reached for now (${pacedPostedToday}/${DAILY_PACED_LIMIT} used today)`,
        },
        { status: 404 }
      );
    }

    return NextResponse.json(
      {
        error:
          'No unposted articles with a valid Facebook card found',
      },
      { status: 404 }
    );
  } catch (err: any) {
    console.error(
      'next-article error:',
      err
    );

    return NextResponse.json(
      { error: err.message },
      { status: 500 }
    );
  }
}
