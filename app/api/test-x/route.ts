import { NextRequest, NextResponse } from "next/server";
import { postToX } from "@/lib/social/x";

// TEMPORARY diagnostic route - posts a single test tweet directly, with no
// dependency on pacing, the daily cap, or the article pipeline at all.
// Exists purely to answer "does the X integration actually work" with a
// clean yes/no, independent of whether the cron pipeline ever reaches the
// posting step. Safe to delete once X posting is confirmed working through
// the real pipeline.
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization");
  const querySecret = req.nextUrl.searchParams.get("secret");
  const providedSecret = auth?.replace("Bearer ", "") ?? querySecret;

  if (providedSecret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;

  try {
    const result = await postToX(
      `${siteUrl}/vox254_icon.png`,
      "VOX254 test post - confirming X posting is working. #VOX254",
      siteUrl
    );
    return NextResponse.json({ success: true, tweetId: result.tweetId });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
