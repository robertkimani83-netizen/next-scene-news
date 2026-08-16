import type { RawArticle } from "./rss";

// Uses Google's Gemini API - genuinely free tier, no credit card required.
// Get a key at https://aistudio.google.com (sign in with any Google account).

export interface RewrittenArticle {
  headline: string;
  teaser: string; // 1-2 sentence hook for the homepage story cards
  article: string; // full multi-paragraph original article for the article page
  facebookCaption: string;
  instagramCaption: string;
  xCaption: string;
  photoSearchTerms: string; // keywords to find a matching photo, used only if no real photo was found
  // How urgent/major this story is. "breaking" bypasses the daily post
  // pacing entirely and always goes out immediately - everything else is
  // paced through the day. high/normal/low are captured for future use
  // (e.g. platform-specific decisions) but only "breaking" affects
  // scheduling today.
  importance: "breaking" | "high" | "normal" | "low";
  entities: {
    people: string[]; // named people mentioned, main subject first
    places: string[]; // specific places (city, county, neighborhood)
    institutions: string[]; // named organizations, government bodies, companies
    event: string; // short description of the specific event/incident, empty string if none
    country: string; // country the story is about, default "Kenya" if unclear
  };
}

const SYSTEM_PROMPT = `You are an editor for a Kenyan news site. You are given a headline, a short wire
snippet, and (when available) extracted text from the original article's own web page.

Your job is to write a genuinely ORIGINAL news article based on the facts in that material -
never copy the source's sentences or mirror its structure. Rewrite everything in your own words,
like a journalist would when covering another outlet's story. Only use facts that are actually
present in the material given to you - never invent quotes, numbers, or details that aren't there.
If the extracted page text is thin or mostly navigation/junk, write a shorter article rather than
padding with invented details.

Return ONLY valid JSON, no markdown fences, matching this shape:
{
  "headline": "short punchy original headline, under 12 words",
  "teaser": "1-2 sentence hook for a homepage card - makes someone want to click",
  "article": "3-6 full original paragraphs (plain text, paragraphs separated by \\n\\n) covering the story properly",
  "facebookCaption": "1-2 sentence caption with a hook, no link (the link goes in a comment)",
  "instagramCaption": "1-2 sentence caption + 3-5 relevant hashtags, no link",
  "xCaption": "1-2 sentence punchy caption + 2-4 relevant hashtags, no link (the link is added separately when posting)",
  "photoSearchTerms": "3-6 words for a photo search - if the story centers on a named public figure (a politician, official, celebrity), lead with their full name (e.g. 'William Ruto speech', 'Edwin Sifuna press'); otherwise be specific and visual (e.g. 'Kenyan parliament building', 'hospital ward Kenya') rather than vague or abstract terms",
  "importance": "one of: breaking, high, normal, low - be conservative, most news is normal or low. Use 'breaking' ONLY for genuinely major, urgent, unfolding news that Kenyans would want to know about immediately (a death of a major public figure, a disaster, a coup/major security incident, a landmark court/election ruling just announced). Use 'high' for significant but not urgent news (a major policy announcement, a notable arrest, a big economic figure). Use 'normal' for routine news coverage. Use 'low' for minor/soft/human-interest stories.",
  "entities": {
    "people": ["full name of the main person this story is about, then any other named people, most important first - empty array if no named person is central to the story"],
    "places": ["specific place names mentioned - a city, county, neighborhood, or landmark - most specific/important first, empty array if none"],
    "institutions": ["full official name of any named organization, government body, company, or agency mentioned - empty array if none"],
    "event": "a short 2-6 word description of the specific event or incident this story is about, e.g. 'helicopter crash', 'budget debate', 'football match' - empty string if the story isn't about a specific event",
    "country": "the country this story is about - default to Kenya if unclear from context"
  }
}`;

export async function rewriteArticle(
  raw: RawArticle,
  extractedPageText: string
): Promise<RewrittenArticle> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const sourceMaterial = extractedPageText
    ? `Wire snippet: ${raw.contentSnippet}\n\nExtracted article page text:\n${extractedPageText}`
    : `Wire snippet: ${raw.contentSnippet}\n\n(No extracted page text was available - work only from the snippet and keep the article short.)`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Headline: ${raw.title}\nSource: ${raw.sourceName}\n\n${sourceMaterial}`,
              },
            ],
          },
        ],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini request failed: ${await res.text()}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  try {
    return JSON.parse(text) as RewrittenArticle;
  } catch (err) {
    console.error("Failed to parse AI response:", text);
    throw new Error("AI rewrite failed to return valid JSON");
  }
}
