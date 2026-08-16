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
  loadArticles,
  getDailyPacedCount,
  incrementDailyPacedCount,
  getDailyBreakingCount,
  incrementDailyBreakingCount,
  type StoredArticle,
} from "@/lib/store";
import { postToFacebook } from "@/lib/social/facebook";
import { postToInstagram } from "@/lib/social/instagram";
import { postToX } from "@/lib/social/x";

// This route is the whole pipeline in one place:
// pull news -> read the real article page -> rewrite as a full original
// article -> find and verify a photo -> post to all three platforms ->
// save it to the site.
//
// Designed to run on a schedule through vercel.json.

const MAX_POSTS_PER_RUN = 3;

// Maximum number of non-breaking articles posted per day.
const DAILY_PACED_LIMIT = 15;

// Vision-verifying candidate photos takes time because each candidate may
// require an image download + Gemini verification call.
export const maxDuration = 60;

// How many paced slots should have been used by this point in the Kenyan day.
function expectedPacedSlotsByNow(): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(
    parts.find((p) => p.type === "hour")?.value ?? "0"
  );

  const minute = Number(
    parts.find((p) => p.type === "minute")?.value ?? "0"
  );

  const minutesSinceMidnight = hour * 60 + minute;

  return Math.ceil(
    (minutesSinceMidnight / 1440) * DAILY_PACED_LIMIT
  );
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");

  const providedSecret =
    auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ??
    new URL(req.url).origin;

  const pacedPostedToday = await getDailyPacedCount();
  const breakingPostedToday = await getDailyBreakingCount();

  // Determine how many non-breaking slots this run can use.
  let pacedSlotsLeftThisRun = Math.max(
    0,
    Math.min(
      MAX_POSTS_PER_RUN,
      expectedPacedSlotsByNow() - pacedPostedToday,
      DAILY_PACED_LIMIT - pacedPostedToday
    )
  );

  const existing = await loadArticles();

  const existingLinks = new Set(
    existing.map((a) => a.link)
  );

  const raw = await fetchAllFeeds();

  const candidates = raw.filter(
    (a) => !existingLinks.has(a.link)
  );

  // Shuffle the RSS candidates so the same feed does not always dominate
  // the run.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));

    [candidates[i], candidates[j]] = [
      candidates[j],
      candidates[i],
    ];
  }

  // Prefer stories that already have a real article image.
  const withPhoto = candidates.filter(
    (a) => a.realImageUrl
  );

  const withoutPhoto = candidates.filter(
    (a) => !a.realImageUrl
  );

  const freshRaw = [
    ...withPhoto,
    ...withoutPhoto,
  ].slice(0, MAX_POSTS_PER_RUN);

  const results: Array<{
    headline: string;
    importance: string;
    postedTo: {
      facebook: boolean;
      instagram: boolean;
      x: boolean;
    };
  }> = [];

  const skippedForPacing: string[] = [];
  const errors: string[] = [];

  for (const rawArticle of freshRaw) {
    try {
      // ---------------------------------------------------------------
      // 1. Read the original article page
      // ---------------------------------------------------------------

      const pageData = await fetchArticlePage(
        rawArticle.link
      );

      // ---------------------------------------------------------------
      // 2. Rewrite + extract entities + photo intelligence
      // ---------------------------------------------------------------

      const rewritten = await rewriteArticle(
        rawArticle,
        pageData.bodyText
      );

      const isBreaking =
        rewritten.importance === "breaking";

      // ---------------------------------------------------------------
      // 3. Respect the daily pacing system
      // ---------------------------------------------------------------

      if (
        !isBreaking &&
        pacedSlotsLeftThisRun <= 0
      ) {
        skippedForPacing.push(
          rewritten.headline
        );

        continue;
      }

      // ---------------------------------------------------------------
      // 4. Try the ORIGINAL article photograph first
      // ---------------------------------------------------------------

      const realPhotoUrl =
        rawArticle.realImageUrl ??
        pageData.imageUrl;

      let photo: MatchedPhoto | null = null;

      if (realPhotoUrl) {
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

      // ---------------------------------------------------------------
      // 5. If the original image fails, use the upgraded photo engine
      //
      // IMPORTANT:
      // photoSearchQueries and photoNeedsCurrentEvent come from the
      // upgraded lib/ai.ts.
      // ---------------------------------------------------------------

      if (!photo) {
        photo = await findMatchingPhoto(
          rewritten.photoSearchTerms,
          rewritten.entities,
          rewritten.headline,
          rewritten.photoSearchQueries,
          rewritten.photoNeedsCurrentEvent
        );
      }

      // ---------------------------------------------------------------
      // 6. Generate article ID
      // ---------------------------------------------------------------

      const id = crypto.randomUUID();

      const ownArticleUrl =
        `${siteUrl}/article/${id}`;

      // ---------------------------------------------------------------
      // 7. If no verified photograph exists, use VOX254 fallback
      // ---------------------------------------------------------------

      if (!photo.url) {
        photo = {
          ...photo,
          url: `${siteUrl}/api/og/${id}`,
          photographer: "VOX254",
          photographerUrl: siteUrl,
          credit: "VOX254",
        };
      }

      // ---------------------------------------------------------------
      // 8. Build stored article
      // ---------------------------------------------------------------

      const stored: StoredArticle = {
        id,
        link: rawArticle.link,
        sourceName: rawArticle.sourceName,
        publishedAt: rawArticle.publishedAt,
        photo,
        postedTo: {
          facebook: false,
          instagram: false,
          x: false,
        },
        ...rewritten,
      };

      // ---------------------------------------------------------------
      // 9. Generate social image
      // ---------------------------------------------------------------

      const socialImageUrl =
        `${siteUrl}/api/og/${id}`;

      // ---------------------------------------------------------------
      // 10. Facebook
      // ---------------------------------------------------------------

      try {
        await postToFacebook(
          socialImageUrl,
          rewritten.facebookCaption,
          ownArticleUrl
        );

        stored.postedTo.facebook = true;
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          "FB post failed:",
          e
        );

        errors.push(
          `"${stored.headline}" - Facebook: ${message}`
        );
      }

      // ---------------------------------------------------------------
      // 11. Instagram
      // ---------------------------------------------------------------

      try {
        await postToInstagram(
          socialImageUrl,
          rewritten.instagramCaption,
          ownArticleUrl
        );

        stored.postedTo.instagram = true;
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          "IG post failed:",
          e
        );

        errors.push(
          `"${stored.headline}" - Instagram: ${message}`
        );
      }

      // ---------------------------------------------------------------
      // 12. X
      // ---------------------------------------------------------------

      try {
        await postToX(
          socialImageUrl,
          rewritten.xCaption,
          ownArticleUrl
        );

        stored.postedTo.x = true;
      } catch (e) {
        const message =
          e instanceof Error
            ? e.message
            : String(e);

        console.error(
          "X post failed:",
          e
        );

        errors.push(
          `"${stored.headline}" - X: ${message}`
        );
      }

      // ---------------------------------------------------------------
      // 13. Save article
      // ---------------------------------------------------------------

      await addArticle(stored);

      // ---------------------------------------------------------------
      // 14. Update daily counters
      // ---------------------------------------------------------------

      if (isBreaking) {
        await incrementDailyBreakingCount();
      } else {
        await incrementDailyPacedCount();

        pacedSlotsLeftThisRun -= 1;
      }

      // ---------------------------------------------------------------
      // 15. Record successful processing
      // ---------------------------------------------------------------

      results.push({
        headline: stored.headline,
        importance: rewritten.importance,
        postedTo: stored.postedTo,
      });
    } catch (e) {
      const message =
        e instanceof Error
          ? e.message
          : String(e);

      console.error(
        `Failed to process article "${rawArticle.title}":`,
        e
      );

      errors.push(
        `"${rawArticle.title}": ${message}`
      );
    }
  }

  // ---------------------------------------------------------------
  // Final counters
  // ---------------------------------------------------------------

  const newPacedCount =
    results.filter(
      (r) => r.importance !== "breaking"
    ).length;

  const newBreakingCount =
    results.filter(
      (r) => r.importance === "breaking"
    ).length;

  return NextResponse.json({
    rawFeedItemsFound: raw.length,

    newItemsAfterDedup:
      freshRaw.length,

    processed:
      results.length,

    skippedForPacing,

    pacedPostedToday:
      pacedPostedToday + newPacedCount,

    pacedDailyLimit:
      DAILY_PACED_LIMIT,

    breakingPostedToday:
      breakingPostedToday + newBreakingCount,

    results,

    errors,
  });
}
