import { NextRequest, NextResponse } from 'next/server';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

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

    if (REDIS_URL && REDIS_TOKEN) {
      const res = await fetch(
        `${REDIS_URL}/del/facebook-claim:${id}`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${REDIS_TOKEN}`,
          },
        }
      );

      if (!res.ok) {
        throw new Error(
          `Failed to release Facebook claim: HTTP ${res.status}`
        );
      }
    }

    return NextResponse.json({
      ok: true,
      released: id,
    });
  } catch (err: any) {
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
