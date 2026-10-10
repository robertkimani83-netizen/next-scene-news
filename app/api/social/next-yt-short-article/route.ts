import { NextRequest, NextResponse } from 'next/server';
import {
  loadArticlesStrict,
  redisMget,
  withinHours,
  STORY_DEDUPE_WINDOW_HOURS,
} from '@/lib/store';
import { StoryMatcher } from '@/lib/story-dedupe';

// Oct 10 2026: picks the story for the daily NEXTSCENE TV "Kenya story"
// YouTube Short (scripts/generate-kenya-short.mjs). It replaced the old
// "money & power" Shorts, which got no views after the channel moved to
// Kenya / KOT stories.
//
// Rules:
//  - Kenya stories only, from the last 36 hours, rated breaking/high.
//  - A REAL news photo only: no fallback/stock photo and no branded
//    headline card. The owner wants real visuals, never stock, so on a
//    day with no suitable story this returns 404 and the run skips.
//  - Its own posted key ("ytshort-posted:<id>"), separate from the
//    Facebook link and Reel keys, so a story can go to every platform once.
//
// Protected with CRON_SECRET because a successful GET marks the story as
// used.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://vox254news.vercel.app';

const TRENDING_IMPORTANCE = new Set(['breaking', 'high']);
const MAX_AGE_HOURS = 36;

async function markPosted(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  await fetch(`${REDIS_URL}/set/ytshort-posted:${id}/1`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
}

function isKenyaStory(a: { entities?: { country?: string; places?: string[] }; headline: string; teaser: string }): boolean {
  const country = (a.entities?.country || '').toLowerCase();
  if (country.includes('kenya')) return true;
  const text = `${a.headline} ${a.teaser} ${(a.entities?.places || []).join(' ')}`;
  return /\b(kenya|kenyan|kenyans|nairobi|mombasa|kisumu|nakuru|eldoret|ruto|kot)\b/i.test(text);
}

export async function GET(req: NextRequest) {
  const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim();
  const expected = (process.env.CRON_SECRET || '').trim();
  if (!provided || !expected || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const articles = await loadArticlesStrict();
    const flags = await redisMget(articles.map((a) => `ytshort-posted:${a.id}`));
    const done = articles.filter((_, i) => !!flags[i]);
    const matcher = new StoryMatcher(articles);
    const now = new Date().toISOString();
    const isCardUrl = (url: string) => url.includes('/api/og/');

    const eligible = articles.filter((article, i) => {
      if (flags[i]) return false;
      if (!TRENDING_IMPORTANCE.has(article.importance)) return false;
      if (!article.photo?.url || article.photo.isFallback || isCardUrl(article.photo.url)) return false;
      if (!withinHours(article.publishedAt, now, MAX_AGE_HOURS)) return false;
      if (!isKenyaStory(article)) return false;
      const twin = done.find(
        (d) =>
          withinHours(d.publishedAt, article.publishedAt, STORY_DEDUPE_WINDOW_HOURS) &&
          matcher.isSameStory(d, article),
      );
      return !twin;
    });

    // Breaking first, then the newest.
    eligible.sort((a, b) => {
      const rank = (x: typeof a) => (x.importance === 'breaking' ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return Date.parse(b.publishedAt || '') - Date.parse(a.publishedAt || '');
    });

    const pick = eligible[0];
    if (!pick) {
      return NextResponse.json(
        { error: 'No unused Kenya breaking/high story with a real photo in the last 36 hours' },
        { status: 404 },
      );
    }

    await markPosted(pick.id);

    return NextResponse.json({
      id: pick.id,
      title: pick.headline,
      teaser: pick.teaser,
      article: pick.article,
      importance: pick.importance,
      sourceName: pick.sourceName,
      imageUrl: pick.photo!.url,
      photoCredit: pick.photo!.credit,
      articleUrl: `${SITE_URL}/article/${pick.id}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
