"use client";

import { useState } from "react";
import type { MatchedPhoto, PhotoCategory } from "@/lib/photos";

const CATEGORY_STYLES: Record
  PhotoCategory,
  { background: string; label: string }
> = {
  politics: { background: "#7a1f2b", label: "VOX254 POLITICS" },
  business: { background: "#1f3a5f", label: "VOX254 BUSINESS" },
  sports: { background: "#1f5f3a", label: "VOX254 SPORTS" },
  crime: { background: "#2b2b2b", label: "VOX254 CRIME" },
  kenya: { background: "#111111", label: "VOX254 KENYA" },
  news: { background: "#111111", label: "VOX254 NEWS" },
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
            alignItems: "center",
            justifyContent: "center",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <img
            src="/vox254_icon.png"
            alt="VOX254"
            style={{ width: "48px", height: "auto", opacity: 0.9 }}
          />
          <span
            style={{
              color: "#ffffff",
              fontSize: "13px",
              fontWeight: 700,
              letterSpacing: "1px",
            }}
          >
            {style.label}
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
