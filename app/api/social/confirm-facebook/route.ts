import { NextRequest, NextResponse } from 'next/server';
import {
  getArticleById,
  incrementDailyPacedCount,
  incrementDailyBreakingCount,
} from '@/lib/store';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function isPosted(id: string): Promise<boolean> {
  if (!REDIS_URL || !REDIS_TOKEN) return false;

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
}

async function markPosted(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) {
    throw new Error('Upstash Redis credentials are not configured');
  }

  const postedRes = await fetch(
    `${REDIS_URL}/set/facebook-posted:${id}/1`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
      },
    }
  );

  if (!postedRes.ok) {
    throw new Error(
      `Failed to mark Facebook post as posted: HTTP ${postedRes.status}`
    );
  }

  await fetch(
    `${REDIS_URL}/del/facebook-claim:${id}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
      },
    }
  );
}

async function releaseClaim(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;

  await fetch(
    `${REDIS_URL}/del/facebook-claim:${id}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
      },
    }
  );
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization');
  const providedSecret = auth?.replace('Bearer ', '');

  if (
    !providedSecret ||
    providedSecret !== process.env.CRON_SECRET
  ) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    const body = await req.json();
    const id = body?.id;

    if (!id || typeof id !== 'string') {
      return NextResponse.json(
        { error: 'Article id is required' },
        { status: 400 }
      );
    }

    const article = await getArticleById(id);

    if (!article) {
      return NextResponse.json(
        { error: 'Article not found' },
        { status: 404 }
      );
    }

    if (await isPosted(id)) {
      await releaseClaim(id);

      return NextResponse.json({
        ok: true,
        alreadyPosted: true,
        id,
      });
    }

    await markPosted(id);

    if (article.importance === 'breaking') {
      await incrementDailyBreakingCount();
    } else {
      await incrementDailyPacedCount();
    }

    console.log(
      `Facebook post confirmed successfully: ${id}`
    );

    return NextResponse.json({
      ok: true,
      alreadyPosted: false,
      id,
      importance: article.importance,
    });
  } catch (err: any) {
    console.error('confirm-facebook error:', err);

    return NextResponse.json(
      {
        error:
          err instanceof Error
            ? err.message
            : String(err),
      },
      { status: 500 }
    );
  }
}
