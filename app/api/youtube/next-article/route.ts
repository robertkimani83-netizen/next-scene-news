import { NextResponse } from 'next/server';
import { loadArticles } from '@/lib/store';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function isVideoPosted(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const res = await fetch(`${REDIS_URL}/get/video-posted:${id}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: 'no-store',
  });
  const data = await res.json();
  return !!data.result;
}

async function markVideoPosted(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/video-posted:${id}/1`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
}

export async function GET() {
  try {
    const articles = await loadArticles();

    for (const article of articles) {
      const posted = await isVideoPosted(article.id);
      if (posted) continue;

      await markVideoPosted(article.id);

   return NextResponse.json({
        id: article.id,
        title: article.headline,
        text: article.article,
        imageUrl: article.photo?.url || null,
      });
    }

    return NextResponse.json({ error: 'No unposted articles found' }, { status: 404 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
