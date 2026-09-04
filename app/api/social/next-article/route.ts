import { NextResponse } from 'next/server';
import {
  loadArticles,
  getDailyPacedCount,
  incrementDailyPacedCount,
  incrementDailyBreakingCount,
  DAILY_PACED_LIMIT,
  expectedPacedSlotsByNow,
} from '@/lib/store';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://next-scene-news-897q.vercel.app';

async function isPosted(id: string, platform: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(`${REDIS_URL}/get/${platform}-posted:${id}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: 'no-store',
  });
  const data = await res.json();
  return !!data.result;
}

async function markPosted(id: string, platform: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/${platform}-posted:${id}/1`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
}

export async function GET() {
  try {
    const articles = await loadArticles();

    // Non-breaking (paced) posts are capped at DAILY_PACED_LIMIT/day and
    // spread across the day; breaking news always bypasses both the cap
    // and the pacing entirely. Both counters are shared with the
    // app/api/cron pipeline (see lib/store.ts) so they draw from one
    // combined daily budget.
    const pacedPostedToday = await getDailyPacedCount();
    const pacedSlotsAllowedByNow = Math.min(DAILY_PACED_LIMIT, expectedPacedSlotsByNow());
    const pacedLimitReached = pacedPostedToday >= pacedSlotsAllowedByNow;

    let sawPacedCandidate = false;

    for (const article of articles) {
      const posted = await isPosted(article.id, 'facebook');
      if (posted) continue;

      const isBreaking = article.importance === 'breaking';

      if (!isBreaking && pacedLimitReached) {
        // Hold this one back for a later call - keep scanning in case a
        // breaking story further down the list should jump the queue.
        sawPacedCandidate = true;
        continue;
      }

      await markPosted(article.id, 'facebook');

      if (isBreaking) {
        await incrementDailyBreakingCount();
      } else {
        await incrementDailyPacedCount();
      }

      return NextResponse.json({
        id: article.id,
        title: article.headline,
        teaser: article.teaser,
        imageUrl: article.photo?.url || null,
        articleUrl: `${SITE_URL}/article/${article.id}`,
      });
    }

    if (sawPacedCandidate) {
      return NextResponse.json(
        { error: `Daily pace limit reached for now (${pacedPostedToday}/${DAILY_PACED_LIMIT} used today)` },
        { status: 404 }
      );
    }

    return NextResponse.json({ error: 'No unposted articles found' }, { status: 404 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
