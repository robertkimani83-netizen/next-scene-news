import { NextResponse } from 'next/server';
import {
  loadArticlesStrict,
  getDailyPacedCount,
  DAILY_PACED_LIMIT,
  redisMget,
  withinHours,
  STORY_DEDUPE_WINDOW_HOURS,
  type StoredArticle,
} from '@/lib/store';
import { StoryMatcher, isMemeRoundup } from '@/lib/story-dedupe';

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SITE_URL =
  process.env.SITE_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://next-scene-news-897q.vercel.app';

// Bump whenever the OG renderer changes. Facebook/Make then receives a new
// image URL instead of reusing an older cached card.
const OG_CARD_VERSION = '4';

// Claims last 6 hours. The GitHub script releases the claim itself when
// Make rejects a post, so the long TTL only matters when Make ACCEPTED the
// post but the website confirmation failed - the case that previously let
// the same article go out again 30 minutes later.
async function claimArticle(id: string): Promise<void> {
  if (!REDIS_URL || !REDIS_TOKEN) return;

  await fetch(`${REDIS_URL}/set/facebook-claim:${id}/1/EX/21600`, {
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

// Recurring memes roundups: at most one on the Page per this many hours.
const MEME_ROUNDUP_COOLDOWN_HOURS = 72;

export async function GET() {
  try {
    // Strict load + batch status lookups. If Redis can't be read we return
    // 503 and post NOTHING, instead of assuming "not posted yet".
    const articles = await loadArticlesStrict();
    const pacedPostedToday = await getDailyPacedCount();
    const dailyCapReached = pacedPostedToday >= DAILY_PACED_LIMIT;

    const ids = articles.map((a) => a.id);
    const [postedFlags, claimFlags] = await Promise.all([
      redisMget(ids.map((id) => `facebook-posted:${id}`)),
      redisMget(ids.map((id) => `facebook-claim:${id}`)),
    ]);

    // Everything already on the Page (or in flight right now).
    const onPage: StoredArticle[] = articles.filter(
      (a, i) => !!postedFlags[i] || !!claimFlags[i] || a.postedTo?.facebook,
    );
    const matcher = new StoryMatcher(articles);

    // Newest articles are first.
    for (let i = 0; i < articles.length; i++) {
      const article = articles[i];
      if (postedFlags[i] || claimFlags[i] || article.postedTo?.facebook) continue;

      const isBreaking = article.importance === 'breaking';
      if (!isBreaking && dailyCapReached) continue;

      // THE KEY CHECK: never release a story the Page already carried in the
      // last few days, even if it was re-reported by another outlet under a
      // different headline. (The old check only compared unposted articles
      // with each other, so any later rewrite of a posted story went out.)
      const twin = onPage.find((p) => {
        if (isMemeRoundup(p) && isMemeRoundup(article)) {
          return withinHours(p.publishedAt, article.publishedAt, MEME_ROUNDUP_COOLDOWN_HOURS);
        }
        return (
          withinHours(p.publishedAt, article.publishedAt, STORY_DEDUPE_WINDOW_HOURS) &&
          matcher.isSameStory(p, article)
        );
      });
      if (twin) {
        console.log(`Skipping repeat of a posted story: "${article.headline}" ~ "${twin.headline}"`);
        continue;
      }

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
