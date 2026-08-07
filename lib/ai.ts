import type { RawArticle } from "./rss";

// Uses Google's Gemini API - genuinely free tier, no credit card required.
// Get a key at https://aistudio.google.com (sign in with any Google account).

export interface RewrittenArticle {
  headline: string;
  summary: string; // 3-5 sentence original summary for the website
  facebookCaption: string;
  instagramCaption: string;
  tiktokCaption: string;
  photoSearchTerms: string; // keywords to find a matching photo
}

const SYSTEM_PROMPT = `You are an editor for a Kenyan news site. You are given a headline and snippet
from a news wire. Your job is to write an ORIGINAL summary in your own words - never copy the
source's exact sentences. Keep facts accurate; do not invent details not in the snippet.
Return ONLY valid JSON, no markdown fences, matching this shape:
{
  "headline": "short punchy original headline, under 12 words",
  "summary": "3-5 original sentences for a website article page",
  "facebookCaption": "1-2 sentence caption with a hook, no link (the link goes in a comment)",
  "instagramCaption": "1-2 sentence caption + 3-5 relevant hashtags, no link",
  "tiktokCaption": "short punchy caption + 3-5 relevant hashtags, no link",
  "photoSearchTerms": "2-4 words describing the best stock photo subject for this story"
}`;

export async function rewriteArticle(raw: RawArticle): Promise<RewrittenArticle> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
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
                text: `Headline: ${raw.title}\nSnippet: ${raw.contentSnippet}\nSource: ${raw.sourceName}`,
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
