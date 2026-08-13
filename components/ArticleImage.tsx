"use client";

import { useState } from "react";
import type { MatchedPhoto, PhotoCategory } from "@/lib/photos";

const CATEGORY_STYLES: Record
  PhotoCategory,
  { background: string; label: string }
> = {
  politics: { background: "#7a1f2b", label: "POLITICS" },
  business: { background: "#1f3a5f", label: "BUSINESS" },
  sports: { background: "#1f5f3a", label: "SPORTS" },
  crime: { background: "#2b2b2b", label: "CRIME" },
  kenya: { background: "#111111", label: "KENYA" },
  news: { background: "#111111", label: "NEWS" },
};

interface ArticleImageProps {
  photo: MatchedPhoto | null | undefined;
  alt: string;
  className?: string;
  aspectRatio?: string;
  watermarkSize?: "small" | "large";
}

export default function ArticleImage({
  photo,
  alt,
  className,
  aspectRatio,
  watermarkSize = "small",
}: ArticleImageProps) {
  const [failed, setFailed] = useState(false);

  const showFallback = !photo || !photo.url || failed;
  const category = photo?.fallbackCategory ?? "news";
  const style = CATEGORY_STYLES[category];

  const containerStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    aspectRatio: aspectRatio || undefined,
    overflow: "hidden",
    backgroundColor: showFallback ? style.background : "#e5e5e5",
  };

  const watermarkStyle: React.CSSProperties = {
    position: "absolute",
    bottom: watermarkSize === "large" ? "16px" : "8px",
    right: watermarkSize === "large" ? "16px" : "8px",
    width: watermarkSize === "large" ? "72px" : "44px",
    height: "auto",
    opacity: 0.85,
    pointerEvents: "none",
  };

  if (showFallback) {
    return (
      <div className={className} style={containerStyle}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
            padding: "8% 10%",
            gap: "16px",
            background:
              "radial-gradient(circle at 30% 20%, rgba(255,255,255,0.06), transparent 55%)",
          }}
        >
          <img
            src="/vox254_icon.png"
            alt="VOX254"
            style={{ width: "40px", height: "auto", opacity: 0.95 }}
          />
          <span
            style={{
              color: "#f5c518",
              fontSize: "12px",
              fontWeight: 800,
              letterSpacing: "2px",
              textTransform: "uppercase",
            }}
          >
            VOX254 {style.label}
          </span>
          <span
            style={{
              color: "#ffffff",
              fontSize: "clamp(16px, 3.2vw, 26px)",
              fontWeight: 800,
              lineHeight: 1.3,
              maxWidth: "90%",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 4,
              WebkitBoxOrient: "vertical",
            }}
          >
            {alt}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={className} style={containerStyle}>
      <img
        src={photo!.url}
        alt={alt}
        onError={() => setFailed(true)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />
      <img src="/vox254_icon.png" alt="VOX254" style={watermarkStyle} />
    </div>
  );
}
