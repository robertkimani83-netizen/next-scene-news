import { NextResponse } from 'next/server';
import { loadArticles } from '@/lib/store';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://vox254news.vercel.app';

// Reels get their OWN posted-tracking key ("reel-posted:<id>"), separate
// from the "facebook-posted:<id>" key the link-posting pipeline
// (next-article/route.ts) uses. An article should be free to become a
// Reel even if it's already gone out as a Facebook link post, and vice
// versa - they're different content, not duplicates of each other.
async function isPosted(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(`${REDIS_URL}/get/reel-posted:${id}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: 'no-store',
  });
  const data = await res.json();
  return !!data.result;
}

async function markPosted(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/reel-posted:${id}/1`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
}

export async function GET() {
  try {
    const articles = await loadArticles();

    // A Reel needs a real photo behind it - a video with no visual isn't
    // usable. Two passes: first prefer a genuine, vision-verified photo
    // (photo.isFallback === false) for the most "eye catching" result;
    // only fall back to a fallback/stock photo if nothing else is
    // available, so the Reel pipeline doesn't stall dry on a slow news day.
    const eligible: typeof articles = [];
    for (const article of articles) {
      if (!article.photo?.url) continue;
      if (await isPosted(article.id)) continue;
      eligible.push(article);
    }

    const pick =
      eligible.find((a) => a.photo && !a.photo.isFallback) ?? eligible[0] ?? null;

    if (!pick) {
      return NextResponse.json({ error: 'No unposted articles with a usable photo found' }, { status: 404 });
    }

    await markPosted(pick.id);

    return NextResponse.json({
      id: pick.id,
      title: pick.headline,
      teaser: pick.teaser,
      article: pick.article,
      // The REAL article photo (not the branded OG card) - this is what
      // gets used as the video's visual, so it should be the actual,
      // vision-verified news photo rather than a flat headline graphic.
      imageUrl: pick.photo!.url,
      photoCredit: pick.photo!.credit,
      articleUrl: `${SITE_URL}/article/${pick.id}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
