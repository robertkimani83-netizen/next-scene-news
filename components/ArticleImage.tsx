"use client";

import { useState } from "react";
import type { MatchedPhoto } from "@/lib/photos";

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
  const isLarge = watermarkSize === "large";
  const isGeneratedPoster = photo?.url?.includes("/api/og/") ?? false;

  const containerStyle: React.CSSProperties = {
    position: "relative",
    width: "100%",
    aspectRatio: aspectRatio || undefined,
    overflow: "hidden",
    backgroundColor: "#111111",
  };

  const watermarkStyle: React.CSSProperties = {
    position: "absolute",
    bottom: isLarge ? "16px" : "8px",
    right: isLarge ? "16px" : "8px",
    width: isLarge ? "72px" : "44px",
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
          }}
        >
          <img
            src="/vox254_icon.png"
            alt="VOX254"
            style={{ width: "48px", height: "auto", opacity: 0.9 }}
          />
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
      {!isGeneratedPoster && (
        <img src="/vox254_icon.png" alt="VOX254" style={watermarkStyle} />
      )}
    </div>
  );
}
