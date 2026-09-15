import { getArticleById } from "@/lib/store";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const WIDTH = 1200;
const HEIGHT = 675;
const CACHE_CONTROL = "public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800";

// Vercel's Node serverless functions do NOT ship system fonts like Arial —
// there is nothing on the box for librsvg (the SVG renderer Sharp uses under
// the hood) to fall back to, so every <text>/<tspan> that named
// "Arial, Helvetica, sans-serif" rendered as empty missing-glyph boxes
// ("tofu") once this route moved off the Edge/@vercel-og renderer (which
// bundled its own font).
//
// Attempt 1 was to embed the font directly in the SVG via a base64
// `@font-face` data URI. That rendered correctly in local testing but NOT
// on Vercel's production Lambda — the bundled libvips/librsvg build there
// evidently doesn't honor an embedded @font-face the same way, so it still
// produced tofu boxes even though the exact same code and font data ran
// without error. So this is now a belt-and-suspenders fix: in addition to
// the @font-face declaration, the font file is also registered as a real
// OS-level font via a private fontconfig config pointed at our bundled
// font directory, with FONTCONFIG_PATH set before any rendering happens.
// That makes librsvg's normal "find an installed font named X" path work
// (font-family="Anton"), which does not depend on @font-face/data-URI
// support at all. Reuses the same Anton font already bundled for the
// NEXTSCENE TV thumbnail engine (assets/fonts/, OFL-licensed) — also a good
// stylistic fit for a bold all-caps news-card headline.
const REAL_FONT_FAMILY = "Anton";
const HEADLINE_FONT_FAMILY = "VOX254Headline";
const FONT_FAMILY_STACK = `${REAL_FONT_FAMILY}, ${HEADLINE_FONT_FAMILY}, sans-serif`;
const FONT_FILE_PATH = path.join(process.cwd(), "assets", "fonts", "Anton-Regular.ttf");
const headlineFontBase64 = fs.readFileSync(FONT_FILE_PATH).toString("base64");

// Real VOX254 logo mark (the same square "V" icon used as the Facebook Page
// profile photo) embedded directly in the card instead of a plain "V254"
// text badge, so the corner watermark matches actual branding.
const LOGO_ICON_BASE64 = fs
  .readFileSync(path.join(process.cwd(), "public", "vox254_icon.png"))
  .toString("base64");
const FONT_FACE_STYLE = `<style>@font-face{font-family:'${HEADLINE_FONT_FAMILY}';src:url(data:font/truetype;charset=utf-8;base64,${headlineFontBase64}) format('truetype');}text,tspan{font-family:'${FONT_FAMILY_STACK}';}</style>`;

let fontConfigStatus = "not-attempted";
function ensureFontconfigRegistered(): string {
  try {
    const fontDir = path.join(process.cwd(), "assets", "fonts");
    const fontconfigDir = "/tmp/vox254-fontconfig";
    const cacheDir = "/tmp/vox254-fontconfig-cache";
    fs.mkdirSync(fontconfigDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const confXml = `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>${fontDir}</dir>
  <cachedir>${cacheDir}</cachedir>
</fontconfig>`;
    fs.writeFileSync(path.join(fontconfigDir, "fonts.conf"), confXml);

    process.env.FONTCONFIG_PATH = fontconfigDir;
    return "ok";
  } catch (error) {
    console.error("OG fontconfig registration failed", error);
    return "failed";
  }
}
fontConfigStatus = ensureFontconfigRegistered();

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

  // No more solid/white panel behind the headline or date bar — the request
  // was to drop that background entirely and have the caption sit directly
  // on the photo. To keep bold BLACK text legible against a photo of any
  // brightness (a plain black fill can vanish into a dark photo), the
  // headline and date text are drawn with a thin white outline
  // (paint-order: stroke) behind the black fill, instead of a rectangle.
  const background = hasPhoto
    ? ""
    : `<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#152a46"/>\n       <rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="#000000" fill-opacity="0.12"/>`;

  const accentY = Math.max(18, Math.round(panelY - 13));
  const dateY = HEIGHT - 25;
  const captionStroke = (width: number) =>
    `paint-order="stroke" stroke="#ffffff" stroke-width="${width}" stroke-linejoin="round"`;

  return Buffer.from(`
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  ${FONT_FACE_STYLE}
  ${background}
  <image x="28" y="28" width="64" height="64" href="data:image/png;base64,${LOGO_ICON_BASE64}"/>

  <rect x="${WIDTH - 135}" y="28" width="107" height="42" rx="21" fill="#f5c518"/>
  <text x="${WIDTH - 81}" y="55" text-anchor="middle" font-family="${FONT_FAMILY_STACK}" font-size="15" font-weight="900" letter-spacing="2" fill="#111111">${escapeXml(categoryLabel)}</text>

  <rect x="48" y="${accentY}" width="80" height="7" fill="#f5c518"/>
  <text font-family="${FONT_FAMILY_STACK}" font-size="${fontSize}" font-weight="900" fill="#050505" letter-spacing="0.4" ${captionStroke(6)}>${textLines}</text>

  <text x="60" y="${dateY - 3}" font-family="${FONT_FAMILY_STACK}" font-size="16" font-weight="800" letter-spacing="0.7" fill="#050505" ${captionStroke(4)}>VOX254 — THE VOICE OF 254${dateLabel ? ` · ${escapeXml(dateLabel)}` : ""}</text>
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
        "X-Vox254-OG": "sharp-compositor-v4-fontconfig",
        "X-Vox254-Font-Setup": fontConfigStatus,
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
