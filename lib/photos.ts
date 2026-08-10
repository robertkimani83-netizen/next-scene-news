// Finds a free-to-use stock photo that matches a story's subject.
// Tries Pexels first, then falls back to Unsplash if Pexels has no
// match - two sources means far fewer stories end up with no photo
// or a poor generic match.

export interface MatchedPhoto {
  url: string;
  photographer: string;
  photographerUrl: string;
}

async function findFromPexels(searchTerms: string): Promise<MatchedPhoto | null> {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) {
    console.warn("PEXELS_API_KEY not set - skipping Pexels photo match");
    return null;
  }

  try {
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
  } catch (err) {
    console.error("Pexels request failed:", err);
    return null;
  }
}

async function findFromUnsplash(searchTerms: string): Promise<MatchedPhoto | null> {
  const apiKey = process.env.UNSPLASH_API_KEY;
  if (!apiKey) {
    console.warn("UNSPLASH_API_KEY not set - skipping Unsplash photo match");
    return null;
  }

  try {
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(
        searchTerms
      )}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${apiKey}` } }
    );

    if (!res.ok) {
      console.error("Unsplash lookup failed:", await res.text());
      return null;
    }

    const data = await res.json();
    const photo = data.results?.[0];
    if (!photo) return null;

    return {
      url: photo.urls.regular,
      photographer: photo.user.name,
      photographerUrl: photo.user.links.html,
    };
  } catch (err) {
    console.error("Unsplash request failed:", err);
    return null;
  }
}

export async function findMatchingPhoto(
  searchTerms: string
): Promise<MatchedPhoto | null> {
  const fromPexels = await findFromPexels(searchTerms);
  if (fromPexels) return fromPexels;

  const fromUnsplash = await findFromUnsplash(searchTerms);
  if (fromUnsplash) return fromUnsplash;

  return null;
}
