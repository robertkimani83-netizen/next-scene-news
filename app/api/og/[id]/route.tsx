import { ImageResponse } from "next/og";
import { getArticleById } from "@/lib/store";

export const runtime = "edge";

const CATEGORY_STYLES: Record<string, { from: string; to: string; label: string }> = {
  politics: { from: "#7a1f2b", to: "#2b0a0e", label: "POLITICS" },
  business: { from: "#1f3a5f", to: "#0a1420", label: "BUSINESS" },
  sports: { from: "#1f5f3a", to: "#0a2416", label: "SPORTS" },
  crime: { from: "#3a2b2b", to: "#140d0d", label: "CRIME" },
  kenya: { from: "#1a1a1a", to: "#000000", label: "KENYA" },
  news: { from: "#1a1a1a", to: "#000000", label: "NEWS" },
};

const PHOTO_TIMEOUT_MS = 15000;

function arrayBufferToBase64(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}

async function getPhotoDataUrl(siteUrl: string, id: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PHOTO_TIMEOUT_MS);

  try {
    // Fetch the Node/Sharp JPEG proxy ourselves and pass the resulting JPEG
    // bytes to Satori as a data URL. This avoids relying on Satori to fetch a
    // same-origin route during ImageResponse rendering and fixes WebP sources.
    const response = await fetch(`${siteUrl}/api/og-photo/${id}`, {
      signal: controller.signal,
      headers: { Accept: "image/jpeg" },
      cache: "no-store",
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("image/jpeg")) return null;

    const bytes = await response.arrayBuffer();
    return `data:image/jpeg;base64,${arrayBufferToBase64(bytes)}`;
  } catch (error) {
    console.error("OG photo fetch failed", error);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const article = await getArticleById(params.id);
  const headline = (article?.headline ?? "VOX254 News").toUpperCase();
  const category = article?.photo?.fallbackCategory ?? "news";
  const style = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.news;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const logoUrl = `${siteUrl}/vox254_icon.png`;
  const hasRealPhoto = Boolean(article?.photo?.url && !article.photo.url.includes("/api/og/"));
  const photoDataUrl = hasRealPhoto ? await getPhotoDataUrl(siteUrl, params.id) : null;
  const dateLabel = article?.publishedAt
    ? new Date(article.publishedAt).toLocaleDateString("en-KE", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

  return new ImageResponse(
    <div
      style={{
        width: "1200px",
        height: "675px",
        display: "flex",
        position: "relative",
        flexDirection: "column",
        fontFamily: "sans-serif",
        background: `linear-gradient(135deg, ${style.from} 0%, ${style.to} 100%)`,
      }}
    >
      {photoDataUrl ? (
        <img
          src={photoDataUrl}
          width="1200"
          height="675"
          style={{ position: "absolute", inset: 0, objectFit: "cover" }}
        />
      ) : null}

      {photoDataUrl ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            background:
              "linear-gradient(to top, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.48) 48%, rgba(255,255,255,0.08) 100%)",
          }}
        />
      ) : null}

      <div
        style={{
          position: "absolute",
          top: "28px",
          left: "28px",
          display: "flex",
          alignItems: "center",
          gap: "10px",
          background: "rgba(0,0,0,0.45)",
          borderRadius: "10px",
          padding: "8px 14px",
        }}
      >
        <img src={logoUrl} width="28" height="28" style={{ opacity: 0.95 }} />
        <span
          style={{
            color: "#fff",
            fontSize: "18px",
            fontWeight: 800,
            letterSpacing: "1px",
          }}
        >
          VOX254
        </span>
      </div>

      <div
        style={{
          position: "absolute",
          top: "28px",
          right: "28px",
          display: "flex",
          background: "#f5c518",
          color: "#111",
          fontSize: "15px",
          fontWeight: 800,
          letterSpacing: "2px",
          padding: "8px 20px",
          borderRadius: "999px",
        }}
      >
        {style.label}
      </div>

      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          display: "flex",
          flexDirection: "column",
          padding: "0 48px 32px",
          gap: "14px",
        }}
      >
        <div
          style={{
            width: "80px",
            height: "7px",
            background: "#f5c518",
            display: "flex",
          }}
        />
        <div
          style={{
            display: "flex",
            color: "#050505",
            fontSize: hasRealPhoto ? "62px" : "58px",
            fontWeight: 900,
            lineHeight: 1.08,
            maxWidth: "1080px",
            letterSpacing: "0.5px",
          }}
        >
          {headline}
        </div>
        <div
          style={{
            display: "flex",
            color: "#111",
            fontSize: "17px",
            fontWeight: 800,
            letterSpacing: "1px",
          }}
        >
          VOX254 — THE VOICE OF 254 {dateLabel ? `· ${dateLabel}` : ""}
        </div>
      </div>
    </div>,
    { width: 1200, height: 675 }
  );
}
