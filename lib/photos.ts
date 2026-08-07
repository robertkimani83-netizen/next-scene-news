// Finds a free-to-use stock photo that matches a story's subject.
// Uses Pexels because its API key is instant and free, with no business
// verification step - unlike most photo APIs.

export interface MatchedPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
}

export async function findMatchingPhoto(
  searchTerms: string
): Promise<MatchedPhoto | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn("PEXELS_API_KEY not set - skipping photo match");
    return null;
  }

  const res = await fetch(
    `https://api.pexels.com/v1/search?query=${encodeURIComponent(
      searchTerms
    )}&per_page=1&orientation=landscape`,
    { headers: { Authorization: apiKey } }
  );

  if (!res.ok) {
    console.error("Pexels lookup failed:", await res.text());
    return null;
  }

  const data = await res.json();
  const photo = data.photos?.[0];
  if (!photo) return null;

  return {
    url: photo.src.large,
    photographer: photo.photographer,
    photographerUrl: photo.photographer_url,
  };
}

// Note: Pexels/Unsplash carry general stock imagery, not photos of the
// actual people or scene in a Kenyan news story - there's no free API that
// finds "the real photo from this specific event." For real event photos
// you'd need the original article's image (check its usage rights) or a
// press photo agency subscription.
