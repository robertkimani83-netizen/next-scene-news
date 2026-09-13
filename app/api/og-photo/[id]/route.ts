import { getArticleById } from "@/lib/store";
import sharp from "sharp";

export const runtime = "nodejs";

const CACHE_CONTROL =
  "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const article = await getArticleById(params.id);
    if (!article?.photo) {
      return new Response("Photo not found", {
        status: 404,
        headers: { "Cache-Control": CACHE_CONTROL },
      });
    }

    // Only allow photo URLs already stored on the article. The route does not
    // accept an arbitrary URL, which avoids turning this into an open proxy.
    const variant = new URL(req.url).searchParams.get("variant");
    const sourceUrl =
      variant === "soft"
        ? article.photo.softBackgroundUrl ?? null
        : article.photo.url ?? null;

    if (!sourceUrl || sourceUrl.includes("/api/og/")) {
      return new Response("Photo not available", {
        status: 404,
        headers: { "Cache-Control": CACHE_CONTROL },
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response: Response;
    try {
      response = await fetch(sourceUrl, {
        signal: controller.signal,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
          "User-Agent": "VOX254-News-ImageProxy/1.0",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      return new Response("Source photo unavailable", {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/")) {
      return new Response("Source is not an image", {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const input = Buffer.from(await response.arrayBuffer());
    const output = await sharp(input)
      .resize(1200, 675, { fit: "cover", position: "centre" })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();

    return new Response(output, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(output.length),
        "Cache-Control": CACHE_CONTROL,
      },
    });
  } catch (error) {
    console.error("OG photo conversion failed", error);
    return new Response("Unable to convert photo", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
