import type { RawArticle } from "./rss";

export interface RewrittenArticle {
  headline: string;
  teaser: string;
  article: string;
  facebookCaption: string;
  instagramCaption: string;
  xCaption: string;

  // Primary photo search phrase.
  photoSearchTerms: string;

  // Additional, more specific searches for the photo engine.
  photoSearchQueries: string[];

  // Short description of what the correct photograph should show.
  photoCaptionHint: string;

  // Whether the story really needs a photograph from the specific
  // current event, rather than a generic archive photograph.
  photoNeedsCurrentEvent: boolean;

  importance: "breaking" | "high" | "normal" | "low";

  entities: {
    people: string[];
    places: string[];
    institutions: string[];
    event: string;
    country: string;
  };
}

const SYSTEM_PROMPT = `
You are an editor for a Kenyan news site.

You are given:
- a headline
- a short wire snippet
- and, when available, extracted text from the original article's own web page.

Your job is to write a genuinely ORIGINAL news article based only on the facts in that material.

Never copy the source's sentences or mirror its structure.
Rewrite everything in your own words, like a journalist covering another outlet's story.

Only use facts actually present in the supplied material.
Never invent quotes, numbers, dates, locations, people, events, or other details.

If the extracted page text is thin or mostly navigation/junk, write a shorter article rather than padding it with invented details.

IMPORTANT PHOTO RULES:

The photo information is for finding a REAL photograph on the internet.

Never suggest generating an AI photograph of a real person or real event.

The goal is to help a separate photo-search system find an authentic photograph that actually matches the article.

Distinguish carefully between:
1. A photograph of the person.
2. A photograph of the specific event described by the article.

For example, if the story says William Ruto met leaders at State House today, a generic photograph of Ruto from another year is NOT an exact event match.

When the article clearly describes a specific current event, photoNeedsCurrentEvent should be true.

When the story is general/background/analysis and an exact event photograph is not necessary, photoNeedsCurrentEvent can be false.

For photoSearchQueries:
- Return 3-6 different search queries.
- Make them specific and visually useful.
- Lead with the main person's full name when a named person is central.
- Include the event, location, institution, or other important context when known.
- Prefer searches that could locate the actual event photograph.
- Do not make every query identical.
- Do not invent a date that is not present in the source material.
- If a date is known from the supplied material, it may be included.
- If the event is a meeting, search for the people + meeting + location.
- If it is a court case, search for the person/case + court.
- If it is a parliament story, search for the person/event + Parliament.
- If it is an accident, search for the incident + location.
- If it is a sports story, search for the teams/players + match/event.
- If no named person is central, use a specific visual description instead.

photoCaptionHint should describe what the desired photograph should visibly show.

Return ONLY valid JSON.
Do not use markdown fences.

Return exactly this shape:

{
  "headline": "short punchy original headline, under 12 words",

  "teaser": "1-2 sentence hook for a homepage card - makes someone want to click",

  "article": "3-6 full original paragraphs (plain text, paragraphs separated by \\\\n\\\\n) covering the story properly",

  "facebookCaption": "1-2 sentence caption with a hook, no link",

  "instagramCaption": "1-2 sentence caption + 3-5 relevant hashtags, no link",

  "xCaption": "1-2 sentence punchy caption + 2-4 relevant hashtags, no link",

  "photoSearchTerms": "the single best 3-8 word photo search phrase",

  "photoSearchQueries": [
    "specific photo search query 1",
    "specific photo search query 2",
    "specific photo search query 3"
  ],

  "photoCaptionHint": "short description of what the correct photograph should visibly show",

  "photoNeedsCurrentEvent": true,

  "importance": "one of: breaking, high, normal, low",

  "entities": {
    "people": [
      "full name of the main person this story is about",
      "other named people, most important first"
    ],
    "places": [
      "specific place names mentioned"
    ],
    "institutions": [
      "full official name of named organizations, government bodies, companies or agencies"
    ],
    "event": "short 2-6 word description of the specific event or incident",

    "country": "country the story is about - default to Kenya if unclear"
  }
}

IMPORTANCE RULES:

Be conservative.

Use "breaking" ONLY for genuinely major, urgent, unfolding news that Kenyans would want to know about immediately, such as:
- death of a major public figure
- major disaster
- coup
- major security incident
- landmark court/election ruling just announced

Use "high" for significant but not urgent news such as:
- major policy announcement
- notable arrest
- major economic figure

Use "normal" for routine news.

Use "low" for minor, soft, or human-interest stories.
`;

export async function rewriteArticle(
  raw: RawArticle,
  extractedPageText: string
): Promise<RewrittenArticle> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set");
  }

  const sourceMaterial = extractedPageText
    ? `Wire snippet: ${raw.contentSnippet}

Extracted article page text:
${extractedPageText}`
    : `Wire snippet: ${raw.contentSnippet}

(No extracted page text was available - work only from the snippet and keep the article short.)`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },

        contents: [
          {
            role: "user",
            parts: [
              {
                text: `Headline: ${raw.title}
Source: ${raw.sourceName}

${sourceMaterial}`,
              },
            ],
          },
        ],

        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini request failed: ${await res.text()}`);
  }

  const data = await res.json();

  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

  try {
    const parsed = JSON.parse(text) as RewrittenArticle;

    // Basic safety/defaults so older articles do not break if Gemini
    // occasionally omits one of the new optional photo fields.
    return {
      ...parsed,

      photoSearchTerms:
        parsed.photoSearchTerms ||
        parsed.entities?.people?.[0] ||
        "Kenya news",

      photoSearchQueries:
        Array.isArray(parsed.photoSearchQueries) &&
        parsed.photoSearchQueries.length > 0
          ? parsed.photoSearchQueries
          : [
              parsed.photoSearchTerms ||
                parsed.entities?.people?.[0] ||
                "Kenya news",
            ],

      photoCaptionHint:
        parsed.photoCaptionHint ||
        parsed.photoSearchTerms ||
        "Relevant news photograph",

      photoNeedsCurrentEvent:
        typeof parsed.photoNeedsCurrentEvent === "boolean"
          ? parsed.photoNeedsCurrentEvent
          : Boolean(parsed.entities?.event),
    };
  } catch (err) {
    console.error("Failed to parse AI response:", text);
    throw new Error("AI rewrite failed to return valid JSON");
  }
}
