import { NextRequest, NextResponse } from "next/server";
import { fetchAllFeeds, fetchArticlePage } from "@/lib/rss";
import { rewriteArticle } from "@/lib/ai";
import {
  findMatchingPhoto,
  verifyExternalCandidate,
  type MatchedPhoto,
} from "@/lib/photos";
import {
  addArticle,
  loadArticlesStrict,
  filterUnseenLinks,
  markLinksSeen,
  withinHours,
  STORY_DEDUPE_WINDOW_HOURS,
  getDailyPacedCount,
  getDailyBreakingCount,
  getUsedPhotoUrls,
  type StoredArticle,
} from "@/lib/store";
import { StoryMatcher } from "@/lib/story-dedupe";
import { postToInstagram } from "@/lib/social/instagram";
import { postToX } from "@/lib/social/x";

// This route ingests news and publishes to Instagram/X.
// Facebook has ONE publisher only: GitHub Actions -> Make -> Facebook.
// The old direct Facebook call here created a second publisher and could
// duplicate stories on the Page.

// Nov 14 2026: was 3. Vercel kills this function at 60s and three articles
// (rewrite + photo verification + social posts) regularly took longer, so most
// runs timed out (FUNCTION_INVOCATION_TIMEOUT) before saving anything. One
// article per run plus a time budget keeps each run inside the limit; the
// hourly GitHub "Ingest News" workflow supplies the frequency instead.
const MAX_POSTS_PER_RUN = 1;
// Stop starting new slow steps once this much of the 60s budget is used.
const TIME_BUDGET_MS = 48_000;
// Instagram/X are best-effort; never let them hold up saving the article.
const SOCIAL_TIMEOUT_MS = 6_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");

  const providedSecret =
    auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    new URL(req.url).origin;

  const pacedPostedToday = await getDailyPacedCount();
  const breakingPostedToday = await getDailyBreakingCount();

  // If the store can't be read, stop. Treating it as empty would make every
  // RSS item look new and republish the whole backlog.
  let existing: StoredArticle[];
  try {
    existing = await loadArticlesStrict();
  } catch (err) {
    console.error("Article store unavailable - aborting ingest:", err);
    return NextResponse.json(
      { error: "Article store unavailable; skipped this run to avoid duplicates" },
      { status: 503 }
    );
  }
  const existingLinks = new Set(existing.map((a) => a.link));
  const usedPhotoUrls = getUsedPhotoUrls(existing);

  const raw = await fetchAllFeeds();
  const notInStore = raw.filter((a) => !existingLinks.has(a.link));
  // Also skip links processed long ago that fell out of the 200-article list.
  const unseen = await filterUnseenLinks(notInStore.map((a) => a.link));
  const candidates = notInStore.filter((a) => unseen.has(a.link));

  // Shuffle the RSS candidates so one source does not always dominate.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const withPhoto = candidates.filter((a) => a.realImageUrl);
  const withoutPhoto = candidates.filter((a) => !a.realImageUrl);
  const freshRaw = [...withPhoto, ...withoutPhoto].slice(0, MAX_POSTS_PER_RUN);

  const results: Array<{
    headline: string;
    importance: string;
    postedTo: { facebook: boolean; instagram: boolean; x: boolean };
  }> = [];

  const skippedDuplicates: string[] = [];
  const skippedNoPhoto: string[] = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    if (elapsed() > TIME_BUDGET_MS - 20_000) {
      console.log("Ingest time budget nearly used; leaving remaining items for the next run.");
      break;
    }
    try {
      const pageData = await fetchArticlePage(rawArticle.link);
      const rewritten = await rewriteArticle(rawArticle, pageData.bodyText);

      // Cross-source duplicate protection: the same event often appears
      // under different URLs on Kenyans.co.ke, AllAfrica and Nairobi Wire.
      // Checked BEFORE Instagram/X so a repeat never goes out anywhere.
      const draft = { headline: rewritten.headline, teaser: rewritten.teaser };
      const matcher = new StoryMatcher([...existing, draft]);
      const twin = existing.find(
        (a) =>
          withinHours(a.publishedAt, rawArticle.publishedAt, STORY_DEDUPE_WINDOW_HOURS) &&
          matcher.isSameStory(a, draft)
      );
      if (twin) {
        skippedDuplicates.push(rewritten.headline);
        console.log(`Skipping duplicate story: "${rewritten.headline}" ~ "${twin.headline}"`);
        await markLinksSeen([rawArticle.link]).catch(() => {});
        continue;
      }

      const realPhotoUrl = rawArticle.realImageUrl ?? pageData.imageUrl;
      let photo: MatchedPhoto | null = null;

      // Prefer the publisher's own article image when it passes verification.
      if (realPhotoUrl && !usedPhotoUrls.has(realPhotoUrl)) {
        photo = await verifyExternalCandidate(
          realPhotoUrl,
          rawArticle.title,
          rawArticle.sourceName,
          rawArticle.link,
          rewritten.entities,
          rewritten.photoSearchTerms,
          rewritten.headline
        );
      }

      // Otherwise use the verified photo discovery engine.
      if (!photo && elapsed() < TIME_BUDGET_MS) {
        photo = await findMatchingPhoto(
          rewritten.photoSearchTerms,
          rewritten.entities,
          rewritten.headline,
          rewritten.photoSearchQueries,
          rewritten.photoNeedsCurrentEvent
        );
      }

      if (!photo) {
        skippedNoPhoto.push(rewritten.headline);
        console.log(`Skipping "${rewritten.headline}": out of time before a photo was found.`);
        continue;
      }

      // A Facebook news card must have a real image. Do not create another
      // blank/solid card just to keep the posting queue moving.
      const photoUrl = photo?.url || photo?.softBackgroundUrl || "";
      if (!photoUrl || usedPhotoUrls.has(photoUrl)) {
        skippedNoPhoto.push(rewritten.headline);
        console.log(`Skipping "${rewritten.headline}" because no unused verified photo is available.`);
        continue;
      }

      const id = crypto.randomUUID();
      const ownArticleUrl = `${siteUrl}/article/${id}`;

      const stored: StoredArticle = {
        id,
        link: rawArticle.link,
        sourceName: rawArticle.sourceName,
        publishedAt: rawArticle.publishedAt,
        photo,
        postedTo: {
          // Facebook is intentionally false here. GitHub/Make is the sole
          // Facebook publisher and will confirm it after Facebook succeeds.
          facebook: false,
          instagram: false,
          x: false,
        },
        ...rewritten,
      };

      const socialImageUrl = `${siteUrl}/api/og/${id}?v=4`;

      try {
        if (elapsed() > TIME_BUDGET_MS) throw new Error("skipped: out of time");
        await withTimeout(
          postToInstagram(socialImageUrl, rewritten.instagramCaption, ownArticleUrl),
          SOCIAL_TIMEOUT_MS,
          "Instagram"
        );
        stored.postedTo.instagram = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("IG post failed:", e);
        errors.push(`"${stored.headline}" - Instagram: ${message}`);
      }

      try {
        if (elapsed() > TIME_BUDGET_MS) throw new Error("skipped: out of time");
        await withTimeout(
          postToX(socialImageUrl, rewritten.xCaption, ownArticleUrl),
          SOCIAL_TIMEOUT_MS,
          "X"
        );
        stored.postedTo.x = true;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error("X post failed:", e);
        errors.push(`"${stored.headline}" - X: ${message}`);
      }

      await addArticle(stored);
      // Let later items in this same run be compared against it too.
      existing.unshift(stored);

      usedPhotoUrls.add(photoUrl);
      if (photo.url) usedPhotoUrls.add(photo.url);
      if (photo.softBackgroundUrl) usedPhotoUrls.add(photo.softBackgroundUrl);

      results.push({
        headline: stored.headline,
        importance: rewritten.importance,
        postedTo: stored.postedTo,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Failed to process article "${rawArticle.title}":`, e);
      errors.push(`"${rawArticle.title}": ${message}`);
    }
  }

  return NextResponse.json({
    rawFeedItemsFound: raw.length,
    newItemsAfterDedup: freshRaw.length,
    processed: results.length,
    skippedDuplicates,
    skippedNoPhoto,
    // These are informational only here. Facebook's 15/day counter is
    // incremented exclusively after the Make/Facebook publisher confirms.
    facebookNormalPostsToday: pacedPostedToday,
    facebookNormalDailyLimit: 15,
    breakingFacebookPostsToday: breakingPostedToday,
    results,
    errors,
    elapsedMs: elapsed(),
  });
}
