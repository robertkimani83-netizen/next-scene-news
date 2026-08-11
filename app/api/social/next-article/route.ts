import { NextResponse } from 'next/server';
import { loadArticles } from '@/lib/store';

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

    for (const article of articles) {
      const posted = await isPosted(article.id, 'facebook');
      if (posted) continue;

      await markPosted(article.id, 'facebook');

      return NextResponse.json({
        id: article.id,
        title: article.headline,
        teaser: article.teaser,
        imageUrl: article.photo?.url || null,
        articleUrl: `${SITE_URL}/article/${article.id}`,
      });
    }

    return NextResponse.json({ error: 'No unposted articles found' }, { status: 404 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
