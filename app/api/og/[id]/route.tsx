import { getArticleById } from "@/lib/store";
import sharp from "sharp";

export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 675;
const CACHE_CONTROL = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

const CATEGORY_STYLES: Record<string, { from: string; to: string; label: string }> = {
  politics: { from: "#7a1f2b", to: "#2b0a0e", label: "POLITICS" },
  business: { from: "#1f3a5f", to: "#0a1420", label: "BUSINESS" },
  sports: { from: "#1f5f3a", to: "#0a2416", label: "SPORTS" },
  crime: { from: "#3a2b2b", to: "#140d0d", label: "CRIME" },
  kenya: { from: "#1a1a1a", to: "#000000", label: "KENYA" },
  news: { from: "#1a1a1a", to: "#000000", label: "NEWS" },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapHeadline(headline: string, maxChars = 31): string[] {
  const words = headline.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }

  if (current) lines.push(current);

  if (lines.length <= 3) return lines;
  return [lines[0], lines[1], lines.slice(2).join(" ")];
}

async function fetchPhotoAsJpeg(url: string): Promise<Buffer | null> {
  if (!url || url.includes("/api/og/")) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/jpeg,image/png,image/*,*/*;q=0.8",
          "User-Agent": "VOX254-News-OG/3.0",
        },
        cache: "no-store",
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) return null;

    const type = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!type.startsWith("image/")) return null;

    const input = Buffer.from(await response.arrayBuffer());

    return await sharp(input)
      .rotate()
      .resize(WIDTH, HEIGHT, { fit: "cover", position: "attention" })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
  } catch (error) {
    console.error("OG source photo conversion failed", error);
    return null;
  }
}

function buildOverlaySvg(
  headline: string,
  categoryLabel: string,
  dateLabel: string,
  hasPhoto: boolean
): Buffer {
  const lines = wrapHeadline(headline, headline.length > 75 ? 28 : 32);
  const fontSize = lines.length >= 3 ? 47 : 55;
  const lineHeight = fontSize * 1.08;
  const panelHeight = Math.max(205, 92 + lines.length * lineHeight + 58);
  const panelY = HEIGHT - panelHeight;
  const headlineStartY = panelY + 72;

  const textLines = lines
    .map(
      (line, index) =>
        `<tspan x="48" y="${Math.round(headlineStartY + index * lineHeight)}">${escapeXml(line)}</tspan>`
    )
    .join("");

  const background = hasPhoto
    ? `<rect x="0" y="${panelY}" width="${WIDTH}" height="${panelHeight}" fill="#ffffff" fill-opacity="0.94"/>`
    : `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#152a46"/>\n       <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#000000" fill-opacity="0.12"/>\n       <rect x="0" y="${panelY}" width="${WIDTH}" height="${panelHeight}" fill="#ffffff"/>`;

  const accentY = Math.max(18, Math.round(panelY - 13));
  const dateY = HEIGHT - 25;

  return Buffer.from(`
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  ${background}
  <rect x="28" y="28" width="145" height="46" rx="10" fill="#071526" fill-opacity="0.92"/>
  <text x="48" y="59" font-family="Arial, Helvetica, sans-serif" font-size="21" font-weight="900" fill="#ffffff">V<tspan fill="#f5c518">254</tspan></text>

  <rect x="${WIDTH - 135}" y="28" width="107" height="42" rx="21" fill="#f5c518"/>
  <text x="${WIDTH - 81}" y="55" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="15" font-weight="900" letter-spacing="2" fill="#111111">${escapeXml(categoryLabel)}</text>

  <rect x="48" y="${accentY}" width="80" height="7" fill="#f5c518"/>
  <text font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" fill="#050505" letter-spacing="0.4">${textLines}</text>

  <rect x="48" y="${HEIGHT - 55}" width="570" height="34" rx="5" fill="#ffffff" fill-opacity="0.96"/>
  <text x="60" y="${dateY - 3}" font-family="Arial, Helvetica, sans-serif" font-size="16" font-weight="800" letter-spacing="0.7" fill="#111111">VOX254 — THE VOICE OF 254${dateLabel ? ` · ${escapeXml(dateLabel)}` : ""}</text>
</svg>`);
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const article = await getArticleById(params.id);
    const headline = (article?.headline ?? "VOX254 NEWS").toUpperCase();
    const category = article?.photo?.fallbackCategory ?? "news";
    const style = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.news;
    const dateLabel = article?.publishedAt
      ? new Date(article.publishedAt).toLocaleDateString("en-KE", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "";

    // The complete photo pipeline now happens inside this Node route:
    // source image -> Sharp decode/resize/crop -> JPEG -> card composite.
    // Facebook/Make never needs to decode the original WebP/AVIF source.
    let photoBuffer = await fetchPhotoAsJpeg(article?.photo?.url ?? "");
    let usingFilePhoto = false;

    if (!photoBuffer && article?.photo?.softBackgroundUrl) {
      photoBuffer = await fetchPhotoAsJpeg(article.photo.softBackgroundUrl);
      usingFilePhoto = Boolean(photoBuffer);
    }

    const background = photoBuffer
      ? photoBuffer
      : await sharp({
          create: {
            width: WIDTH,
            height: HEIGHT,
            channels: 3,
            background: style.from,
          },
        })
          .png()
          .toBuffer();

    const overlay = buildOverlaySvg(
      headline,
      usingFilePhoto ? "FILE PHOTO" : style.label,
      dateLabel,
      Boolean(photoBuffer)
    );

    const output = await sharp(background)
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer();

    return new Response(output, {
      status: 200,
      headers: {
        "Content-Type": "image/jpeg",
        "Content-Length": String(output.length),
        "Cache-Control": CACHE_CONTROL,
        "X-Vox254-OG": "sharp-compositor-v3",
      },
    });
  } catch (error) {
    console.error("OG card generation failed", error);
    return new Response("Unable to generate OG card", {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
