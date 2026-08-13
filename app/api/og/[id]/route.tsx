import { ImageResponse } from "next/og";
import { getArticleById } from "@/lib/store";

export const runtime = "edge";

const CATEGORY_STYLES: Record
  string,
  { from: string; to: string; label: string }
> = {
  politics: { from: "#7a1f2b", to: "#2b0a0e", label: "POLITICS" },
  business: { from: "#1f3a5f", to: "#0a1420", label: "BUSINESS" },
  sports: { from: "#1f5f3a", to: "#0a2416", label: "SPORTS" },
  crime: { from: "#3a2b2b", to: "#140d0d", label: "CRIME" },
  kenya: { from: "#1a1a1a", to: "#000000", label: "KENYA" },
  news: { from: "#1a1a1a", to: "#000000", label: "NEWS" },
};

export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  const article = await getArticleById(params.id);

  const headline = article?.headline ?? "VOX254 News";
  const category = article?.photo?.fallbackCategory ?? "news";
  const style = CATEGORY_STYLES[category] ?? CATEGORY_STYLES.news;

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? new URL(req.url).origin;
  const logoUrl = `${siteUrl}/vox254_icon.png`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "1200px",
          height: "675px",
          display: "flex",
          flexDirection: "column",
          position: "relative",
          background: `linear-gradient(135deg, ${style.from} 0%, ${style.to} 100%)`,
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            padding: "48px 56px 0 56px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "16px",
              background: "rgba(0,0,0,0.35)",
              borderRadius: "12px",
              padding: "14px 22px",
            }}
          >
            <img src={logoUrl} width="44" height="44" style={{ opacity: 0.95 }} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span
                style={{
                  color: "#ffffff",
                  fontSize: "26px",
                  fontWeight: 800,
                  letterSpacing: "1px",
                }}
              >
                VOX254
              </span>
              <span
                style={{
                  color: "#f5c518",
                  fontSize: "13px",
                  fontWeight: 700,
                  letterSpacing: "2px",
                }}
              >
                THE VOICE OF 254
              </span>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              background: "#f5c518",
              color: "#111111",
              fontSize: "18px",
              fontWeight: 800,
              letterSpacing: "2px",
              padding: "10px 26px",
              borderRadius: "999px",
            }}
          >
            {style.label}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            padding: "0 56px",
            gap: "20px",
          }}
        >
          <div
            style={{
              width: "90px",
              height: "6px",
              background: "#f5c518",
              display: "flex",
            }}
          />
          <div
            style={{
              display: "flex",
              color: "#ffffff",
              fontSize: "54px",
              fontWeight: 800,
              lineHeight: 1.2,
              maxWidth: "980px",
            }}
          >
            {headline}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "24px 0",
            background: "rgba(0,0,0,0.35)",
          }}
        >
          <span
            style={{
              color: "rgba(255,255,255,0.7)",
              fontSize: "16px",
              fontWeight: 600,
              letterSpacing: "1px",
            }}
          >
            VOX254 — The Voice of 254
          </span>
        </div>
      </div>
    ),
    { width: 1200, height: 675 }
  );
}
