#!/usr/bin/env python3
"""NEXT SCENE TV premium thumbnail compositor.

Pipeline:
    video title
        -> Gemini analyzes the story and creates a thumbnail concept
        -> FLUX.1-schnell generates a cinematic background
        -> Pillow adds the real headline, category tag and channel logo

The generated background is NEVER asked to contain text, logos or watermarks.

Designed for:
    NEXT SCENE TV - THE FUTURE UNCOVERED

The compositor is intentionally optimized for:
    - premium documentary/news visuals
    - strong mobile readability
    - one dominant visual idea
    - cinematic depth and lighting
    - clean headline space
    - strong but restrained color
    - high visual hierarchy
"""

import argparse
import json
import math
import os
import random
import re
import sys
import time
import traceback
from pathlib import Path

from PIL import (
    Image,
    ImageDraw,
    ImageEnhance,
    ImageFilter,
    ImageFont,
    ImageOps,
)

try:
    import requests
except ImportError:
    print(
        "[thumbnail] fatal: the 'requests' package is not installed "
        "(pip install requests)",
        file=sys.stderr,
    )
    raise

try:
    from huggingface_hub import InferenceClient
except ImportError:
    print(
        "[thumbnail] fatal: the 'huggingface_hub' package is not installed "
        "(pip install huggingface_hub)",
        file=sys.stderr,
    )
    raise


# ============================================================================
# PATHS / CONFIGURATION
# ============================================================================

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

FONT_PATH = REPO_ROOT / "assets" / "fonts" / "Anton-Regular.ttf"
LOGO_PATH = REPO_ROOT / "assets" / "logo.png"

OUT_WIDTH = 1280
OUT_HEIGHT = 720

# FLUX generation size.
GEN_WIDTH = 1344
GEN_HEIGHT = 768

HF_TOKEN = os.environ.get("HF_TOKEN")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

GEMINI_MODELS = [
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
]

FLUX_MODEL = "black-forest-labs/FLUX.1-schnell"


# ============================================================================
# COLORS
# ============================================================================

COLORS = {
    "white": (255, 255, 255),
    "yellow": (255, 214, 10),
    "red": (237, 28, 36),
    "green": (60, 220, 90),
}

OUTLINE_COLOR = (0, 0, 0)


# ============================================================================
# GEMINI THUMBNAIL ART DIRECTOR
# ============================================================================

ANALYZE_PROMPT_TMPL = """You are the senior visual director and thumbnail art director
for NEXT SCENE TV - THE FUTURE UNCOVERED, a premium YouTube
documentary/news channel.

Your job is NOT to create a generic YouTube thumbnail.

Your job is to design a powerful, cinematic, premium documentary/news
thumbnail concept that communicates the story in less than one second.

The visual quality should feel like a major international documentary or
television news production:

- realistic photography
- cinematic lighting
- strong depth
- sophisticated composition
- believable environments
- controlled color grading
- powerful visual storytelling
- clear subject hierarchy
- professional editorial photography

Create an ORIGINAL NEXT SCENE TV visual identity.

Do NOT copy the exact composition, typography, logo, artwork or layout of
another YouTube channel.

VIDEO TITLE:
"{title}"

======================================================================
CORE VISUAL RULES
======================================================================

1. ONE DOMINANT VISUAL IDEA

Choose the single strongest visual representation of the story.

Do NOT try to visually explain every part of the title.

The viewer should immediately understand the main subject.

Use one dominant hero subject or visual object.

Use supporting elements only when they genuinely strengthen the story.

The thumbnail must feel intentional, not crowded.

======================================================================

2. HERO SUBJECT

The hero subject should be:

- large
- recognizable
- visually striking
- realistic
- emotionally meaningful

Use professional rule-of-thirds composition.

Place the dominant subject primarily on the LEFT third or RIGHT third.

Do NOT automatically put the subject in the center.

Create strong separation between:

foreground
middle ground
background

Use realistic depth, perspective, atmospheric haze and cinematic lighting.

======================================================================

3. CLEAN HEADLINE AREA

The opposite side of the hero subject must remain relatively simple.

Keep it:

- darker
- calmer
- less detailed
- visually uncluttered

This space is reserved for a large headline that will be added later.

IMPORTANT:

Do not put the most important visual details underneath the future headline.

Do not fill the entire frame with objects.

======================================================================

4. PREMIUM DOCUMENTARY REALISM

The image must look like a real high-budget documentary photograph
or cinematic news still.

Use:

- realistic architecture
- realistic landscapes
- realistic vehicles
- realistic military equipment
- realistic technology
- realistic people
- believable lighting
- realistic materials
- natural atmospheric depth

Avoid:

- cartoon imagery
- plastic-looking objects
- cheap stock-photo appearance
- excessive fantasy
- excessive CGI appearance
- unrealistic HDR
- excessive neon
- random futuristic objects

======================================================================

5. STORY-SPECIFIC VISUAL LANGUAGE

Study the title and select the most powerful visual scene.

FOR GEOPOLITICS:

Use relevant geopolitical environments, government buildings,
military hardware, strategic landscapes, borders, cities or
international locations when appropriate.

FOR WAR / CONFLICT:

Use realistic military equipment, soldiers, damaged infrastructure,
battlefield atmosphere, smoke, strategic landscapes or tense military
environments.

Do NOT create excessive gore.

FOR TECHNOLOGY:

Use believable AI infrastructure, advanced computers, server rooms,
robotics, semiconductor manufacturing, data centers, advanced machines
or realistic future technology.

FOR ECONOMICS:

Use financial districts, ports, factories, trade infrastructure,
commodities, currency, business districts or powerful economic symbols.

FOR COUNTRIES / RANKINGS:

Prefer distinctive landscapes, architecture, skylines, infrastructure,
landmarks or recognizable environments.

Do NOT simply fill the image with many national flags.

FOR AFRICA:

Use authentic African environments, cities, infrastructure, landscapes,
business districts, ports, wildlife or people when relevant to the story.

Avoid generic "Africa" stereotypes.

FOR DISASTERS:

Show the actual environmental or human consequence with cinematic
realism, atmosphere and emotional weight.

FOR FUTURE PREDICTIONS:

Create a believable near-future world.

Avoid unrealistic science-fiction fantasy.

FOR PEOPLE:

Use a realistic hero portrait or small group.

Faces should have:

- believable expressions
- natural skin texture
- realistic proportions
- cinematic lighting

======================================================================
6. EMOTION
======================================================================

Choose ONE dominant emotional response:

- curiosity
- surprise
- urgency
- ambition
- danger
- mystery
- opportunity
- awe
- tension

Do not combine too many emotional signals.

======================================================================
7. COLOR AND LIGHT
======================================================================

Use sophisticated cinematic color grading.

Prefer:

- deep rich shadows
- controlled highlights
- strong subject/background separation
- realistic skin tones
- cinematic atmospheric light
- restrained accent colors

Avoid:

- rainbow colors
- extreme saturation
- excessive neon
- cheap HDR
- artificial glow everywhere

The image should feel expensive.

======================================================================
8. VISUAL SIMPLICITY
======================================================================

Premium thumbnails are easy to understand.

Avoid:

- dozens of tiny objects
- random arrows
- random circles
- excessive icons
- meaningless charts
- decorative shapes
- unnecessary flags
- excessive digital effects
- clutter

The viewer should identify the main visual within one second.

======================================================================
9. PEOPLE
======================================================================

If people are used:

Make them anatomically correct.

Avoid:

- distorted faces
- duplicated people
- extra limbs
- unnatural hands
- strange eyes
- uncanny expressions

Use realistic photography.

======================================================================
10. TEXT RESTRICTION
======================================================================

The AI image generator creates ONLY the cinematic photographic background.

ABSOLUTELY NO:

text
words
letters
numbers
logos
watermarks
captions
labels
typography
fake headlines
signs containing readable writing

The headline will be added separately by Pillow.

======================================================================
11. MOBILE-FIRST DESIGN
======================================================================

The thumbnail must remain powerful when reduced to a small YouTube
thumbnail.

The hero subject must remain recognizable.

Do not depend on tiny details.

Use strong silhouettes, clear shapes and obvious visual hierarchy.

======================================================================
12. ORIGINALITY
======================================================================

Create an original NEXT SCENE TV visual concept using professional
documentary/news design principles.

Do not reproduce another channel's exact thumbnail.

======================================================================
HEADLINE STRATEGY
======================================================================

The YouTube video title may be long.

The thumbnail headline should NOT automatically repeat the entire title.

Create a SHORT, HIGH-IMPACT thumbnail headline.

The thumbnail headline should normally contain approximately
3 to 8 words.

Select the strongest words from the original title.

The thumbnail headline must:

- preserve the central meaning
- create curiosity
- be understandable instantly
- work on a mobile screen
- avoid unnecessary filler words

Examples:

Video title:
"10 Countries That Could Collapse First Between 2026 and 2035"

Good thumbnail headline:
"10 COUNTRIES AT RISK"

Video title:
"Why Africa Could Become the World's Biggest Economic Opportunity"

Good thumbnail headline:
"AFRICA'S BIG OPPORTUNITY"

Video title:
"These Cities May Become Unlivable Before 2035"

Good thumbnail headline:
"CITIES THAT MAY DISAPPEAR"

Do NOT invent facts that are not supported by the title.

======================================================================
RETURN FORMAT
======================================================================

Return ONLY valid JSON.

No markdown.

No explanation.

Use exactly this structure:

{
  "image_prompt": "A detailed English prompt describing ONLY the cinematic photographic scene.",
  "category": "one of: war, africa, economy, countries, cities, technology, disaster, people, other",
  "category_label": "short 1-3 word ALL CAPS label",
  "words": [
    {"text": "WORD", "color": "white"}
  ]
}

======================================================================
IMAGE_PROMPT REQUIREMENTS
======================================================================

The image_prompt must:

1. Describe a specific scene based on the title.
2. Identify the hero subject.
3. Describe the environment.
4. Describe cinematic lighting.
5. Describe depth and atmosphere.
6. State that the hero subject is positioned on the LEFT or RIGHT third.
7. State that the opposite side is clean, darker and suitable for headline placement.
8. Require realistic documentary photography.
9. Require strong cinematic composition.
10. Explicitly require:

NO TEXT
NO WORDS
NO LETTERS
NO NUMBERS
NO LOGOS
NO WATERMARKS

======================================================================
HEADLINE WORD RULES
======================================================================

The "words" array is the SHORT THUMBNAIL HEADLINE.

Do NOT return the entire video title when a shorter headline would be
stronger.

Use approximately 3-8 words whenever possible.

Keep the wording powerful and natural.

Most words MUST be white.

Use yellow only for:

- important numbers
- rankings
- years
- positive/high-attention words

Use red only for genuinely dramatic words such as:

- WAR
- COLLAPSE
- CRISIS
- DANGER
- ATTACK
- THREAT
- DEATH
- DISASTER
- WARNING
- SECRET
- EXPOSED
- FALL
- DYING

Use green very rarely for:

- BEST
- RICHEST
- SAFEST
- STRONGEST
- SUCCESS
- WINNING

Use only 2-4 highlighted words maximum.

Never color every word.

The visual hierarchy must be:

HERO SUBJECT
>
HEADLINE
>
SMALL CATEGORY LABEL
>
CHANNEL LOGO
"""


# ============================================================================
# JSON CLEANING
# ============================================================================

def _clean_json(raw: str) -> str:
    raw = raw.strip()

    raw = re.sub(
        r"^```json\s*",
        "",
        raw,
        flags=re.IGNORECASE,
    )

    raw = re.sub(
        r"^```\s*",
        "",
        raw,
    )

    raw = re.sub(
        r"```\s*$",
        "",
        raw,
    )

    return raw.strip()


# ============================================================================
# GEMINI ANALYSIS
# ============================================================================

def analyze_title_with_gemini(title: str):
    if not GEMINI_API_KEY:
        return None

    safe_title = title.replace('"', "'")

    prompt = ANALYZE_PROMPT_TMPL.format(
        title=safe_title
    )

    last_err = None

    for model in GEMINI_MODELS:
        try:
            res = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={
                    "x-goog-api-key": GEMINI_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "contents": [
                        {
                            "parts": [
                                {
                                    "text": prompt
                                }
                            ]
                        }
                    ]
                },
                timeout=30,
            )

            if not res.ok:
                raise RuntimeError(
                    f"{model} responded {res.status_code}"
                )

            data = res.json()

            raw = (
                data["candidates"][0]
                ["content"]
                ["parts"][0]
                ["text"]
            )

            parsed = json.loads(
                _clean_json(raw)
            )

            words = parsed.get("words") or []

            if not words:
                raise RuntimeError(
                    "Gemini returned no headline words"
                )

            cleaned_words = []

            for w in words:
                if not isinstance(w, dict):
                    continue

                text = str(
                    w.get("text", "")
                ).strip()

                if not text:
                    continue

                color = w.get("color", "white")

                if color not in COLORS:
                    color = "white"

                cleaned_words.append(
                    {
                        "text": text.upper(),
                        "color": color,
                    }
                )

            if not cleaned_words:
                raise RuntimeError(
                    "Gemini returned an empty headline"
                )

            category = (
                parsed.get("category")
                or "other"
            )

            allowed_categories = {
                "war",
                "africa",
                "economy",
                "countries",
                "cities",
                "technology",
                "disaster",
                "people",
                "other",
            }

            if category not in allowed_categories:
                category = "other"

            category_label = (
                parsed.get("category_label")
                or ""
            ).upper().strip()

            category_label = category_label[:24]

            image_prompt = (
                parsed.get("image_prompt")
                or _fallback_prompt(
                    title,
                    category,
                )
            )

            # Extra safety instruction added after Gemini response.
            image_prompt = (
                f"{image_prompt}. "
                "Clean cinematic photographic background only. "
                "NO TEXT, NO WORDS, NO LETTERS, NO NUMBERS, "
                "NO LOGOS, NO WATERMARKS."
            )

            return {
                "image_prompt": image_prompt,
                "category": category,
                "category_label": category_label,
                "words": cleaned_words,
            }

        except Exception as err:
            last_err = err

            print(
                f"[thumbnail] title analysis via {model} failed: "
                f"{err}, trying next model...",
                file=sys.stderr,
            )

    print(
        f"[thumbnail] all Gemini analysis models failed "
        f"({last_err}), using rule-based fallback",
        file=sys.stderr,
    )

    return None


# ============================================================================
# RULE-BASED FALLBACK
# ============================================================================

CATEGORY_KEYWORDS = {
    "war": [
        "war",
        "wars",
        "conflict",
        "conflicts",
        "military",
        "army",
        "invasion",
        "battle",
        "soldier",
        "weapon",
        "missile",
        "nuclear",
        "attack",
    ],

    "africa": [
        "africa",
        "african",
        "nigeria",
        "kenya",
        "ethiopia",
        "egypt",
        "sahara",
        "congo",
        "rwanda",
        "ghana",
        "tanzania",
        "uganda",
        "south africa",
    ],

    "economy": [
        "economy",
        "economic",
        "gdp",
        "money",
        "billionaire",
        "billionaires",
        "richest",
        "poorest",
        "trade",
        "market",
        "currency",
        "debt",
        "wealth",
        "investment",
        "jobs",
        "business",
    ],

    "countries": [
        "countries",
        "country",
        "nations",
        "nation",
        "world",
        "ranking",
        "ranked",
    ],

    "cities": [
        "city",
        "cities",
        "skyline",
        "megacity",
        "urban",
    ],

    "technology": [
        "technology",
        "tech",
        "ai",
        "artificial intelligence",
        "robot",
        "robots",
        "chip",
        "chips",
        "digital",
        "cyber",
        "computer",
        "internet",
        "future",
    ],

    "disaster": [
        "collapse",
        "crisis",
        "disaster",
        "flood",
        "earthquake",
        "famine",
        "drought",
        "pandemic",
        "fire",
        "storm",
    ],

    "people": [
        "women",
        "men",
        "people",
        "population",
        "human",
    ],
}


RED_WORDS = {
    "collapse",
    "collapsing",
    "war",
    "wars",
    "crisis",
    "danger",
    "dangerous",
    "attack",
    "attacks",
    "dying",
    "death",
    "dead",
    "warning",
    "threat",
    "invasion",
    "disaster",
    "doom",
    "fall",
    "falling",
    "poorest",
    "worst",
    "secret",
    "hidden",
    "banned",
    "exposed",
    "conflict",
    "conflicts",
    "nuclear",
    "famine",
    "collapsed",
}


GREEN_WORDS = {
    "beautiful",
    "richest",
    "best",
    "winning",
    "success",
    "successful",
    "safest",
    "happiest",
    "strongest",
}


YELLOW_WORDS = {
    "biggest",
    "largest",
    "fastest",
    "top",
    "most",
    "first",
    "future",
}


YEAR_RE = re.compile(
    r"^\d{4}([-–]\d{2,4})?$"
)

NUM_RE = re.compile(
    r"^\d+([.,]\d+)?$"
)


def _fallback_prompt(
    title: str,
    category: str,
) -> str:

    scene_by_category = {

        "war":
            "premium cinematic documentary photograph of a "
            "realistic military conflict environment with modern "
            "military vehicles and distant smoke, dramatic "
            "atmosphere, powerful directional lighting",

        "africa":
            "premium cinematic documentary photograph of a "
            "distinctive African city or landscape directly "
            "connected to the story, authentic architecture, "
            "realistic atmosphere and dramatic natural lighting",

        "economy":
            "premium cinematic documentary photograph of a "
            "major financial district and economic infrastructure, "
            "modern towers, realistic financial atmosphere, "
            "dramatic evening lighting",

        "countries":
            "premium cinematic documentary photograph representing "
            "global countries through a dramatic world landscape, "
            "major skyline or distinctive international environment, "
            "realistic atmospheric lighting",

        "cities":
            "premium cinematic documentary photograph of a massive "
            "modern city skyline, realistic buildings, roads and "
            "urban atmosphere, dramatic cinematic lighting",

        "technology":
            "premium cinematic documentary photograph of advanced "
            "real-world technology infrastructure, servers, "
            "robotics, computing hardware or AI systems in a "
            "professional facility",

        "disaster":
            "premium cinematic documentary photograph showing a "
            "realistic environmental or urban disaster scene with "
            "dramatic weather, atmospheric depth and powerful "
            "emotional realism",

        "people":
            "premium cinematic documentary portrait photograph "
            "of realistic people in an authentic real-world "
            "environment, expressive faces and cinematic lighting",

        "other":
            "premium cinematic documentary photograph representing "
            "the strongest visual idea from the story with one "
            "clear hero subject",
    }

    base = scene_by_category.get(
        category,
        scene_by_category["other"],
    )

    return (
        f"{base}, inspired by the story '{title}', "
        "professional international television documentary "
        "quality, realistic photography, sophisticated cinematic "
        "color grading, deep shadows, controlled highlights, "
        "strong foreground and background separation, "
        "atmospheric depth, realistic textures, "
        "main hero subject positioned on the LEFT or RIGHT third "
        "of the frame using professional rule-of-thirds "
        "composition, opposite side kept clean, darker and "
        "visually calm for headline placement, "
        "strong mobile thumbnail readability, "
        "NO TEXT, NO WORDS, NO LETTERS, NO NUMBERS, "
        "NO LOGOS, NO WATERMARKS."
    )


def analyze_title_rule_based(title: str):

    lower = title.lower()

    category = "other"

    for cat, keywords in CATEGORY_KEYWORDS.items():
        if any(
            keyword in lower
            for keyword in keywords
        ):
            category = cat
            break

    # ------------------------------------------------------------
    # Create a shorter fallback headline.
    # ------------------------------------------------------------

    raw_words = title.split()

    cleaned = []

    for raw_word in raw_words:

        token = raw_word.strip()

        if not token:
            continue

        stripped = re.sub(
            r"[^\w.–-]",
            "",
            token,
        ).lower()

        # Remove very weak filler words from long fallback titles.
        filler_words = {
            "the",
            "a",
            "an",
            "of",
            "to",
            "in",
            "on",
            "for",
            "and",
            "that",
            "this",
            "with",
            "are",
            "is",
            "will",
            "could",
            "may",
            "from",
        }

        if (
            stripped in filler_words
            and len(raw_words) > 8
        ):
            continue

        if (
            YEAR_RE.match(stripped)
            or NUM_RE.match(stripped)
        ):
            color = "yellow"

        elif stripped in RED_WORDS:
            color = "red"

        elif stripped in GREEN_WORDS:
            color = "green"

        elif stripped in YELLOW_WORDS:
            color = "yellow"

        else:
            color = "white"

        cleaned.append(
            {
                "text": token.upper(),
                "color": color,
            }
        )

    # Limit fallback headline size.
    if len(cleaned) > 8:
        important = [
            w for w in cleaned
            if w["color"] != "white"
        ]

        normal = [
            w for w in cleaned
            if w["color"] == "white"
        ]

        selected = important[:4]

        remaining = 8 - len(selected)

        selected.extend(
            normal[:remaining]
        )

        cleaned = selected

    label_by_category = {
        "war": "CONFLICT WATCH",
        "africa": "AFRICA REPORT",
        "economy": "ECONOMIC OUTLOOK",
        "countries": "GLOBAL RANKING",
        "cities": "URBAN FUTURE",
        "technology": "TECH FRONTIER",
        "disaster": "BREAKING ANALYSIS",
        "people": "SPOTLIGHT",
        "other": "NEXT SCENE",
    }

    return {
        "image_prompt": _fallback_prompt(
            title,
            category,
        ),

        "category": category,

        "category_label":
            label_by_category.get(
                category,
                "NEXT SCENE",
            ),

        "words": cleaned,
    }


def analyze_title(title: str):
    return (
        analyze_title_with_gemini(title)
        or analyze_title_rule_based(title)
    )


# ============================================================================
# FLUX BACKGROUND GENERATION
# ============================================================================

def generate_background(
    prompt: str,
    seed: int | None = None,
    max_attempts: int = 3,
) -> Image.Image:

    if not HF_TOKEN:
        raise RuntimeError(
            "HF_TOKEN is not set"
        )

    client = InferenceClient(
        provider="auto",
        api_key=HF_TOKEN,
    )

    last_err = None

    for attempt in range(
        1,
        max_attempts + 1,
    ):

        try:

            image = client.text_to_image(
                prompt,
                model=FLUX_MODEL,
                width=GEN_WIDTH,
                height=GEN_HEIGHT,
                seed=seed,
            )

            return image.convert("RGB")

        except Exception as err:
            last_err = err

            try:

                image = client.text_to_image(
                    prompt,
                    model=FLUX_MODEL,
                )

                return image.convert("RGB")

            except Exception as err2:
                last_err = err2

            if attempt < max_attempts:

                delay = 2 ** attempt

                print(
                    f"[thumbnail] FLUX generation attempt "
                    f"{attempt} failed: {last_err} - "
                    f"retrying in {delay}s...",
                    file=sys.stderr,
                )

                time.sleep(delay)

    raise RuntimeError(
        "FLUX.1-schnell generation failed after "
        f"{max_attempts} attempts: {last_err}"
    )


# ============================================================================
# IMAGE PROCESSING
# ============================================================================

def cover_crop(
    im: Image.Image,
    target_w: int,
    target_h: int,
) -> Image.Image:

    return ImageOps.fit(
        im,
        (target_w, target_h),
        method=Image.LANCZOS,
        centering=(0.5, 0.45),
    )


def cinematic_grade(
    im: Image.Image,
) -> Image.Image:
    """Apply restrained cinematic finishing."""

    im = ImageOps.autocontrast(
        im,
        cutoff=1,
    )

    # Slightly reduce FLUX oversaturation.
    im = ImageEnhance.Color(
        im
    ).enhance(0.90)

    # Small contrast increase.
    im = ImageEnhance.Contrast(
        im
    ).enhance(1.06)

    # Slight sharpening.
    im = im.filter(
        ImageFilter.UnsharpMask(
            radius=1.2,
            percent=105,
            threshold=3,
        )
    )

    return im


def add_vignette(
    im: Image.Image,
    strength: float = 0.22,
) -> Image.Image:

    w, h = im.size

    overlay = Image.new(
        "RGBA",
        (w, h),
        (0, 0, 0, 0),
    )

    pixels = overlay.load()

    cx = w / 2
    cy = h / 2

    max_dist = math.sqrt(
        cx * cx + cy * cy
    )

    for y in range(h):
        for x in range(w):

            dx = (x - cx) / cx
            dy = (y - cy) / cy

            distance = math.sqrt(
                dx * dx + dy * dy
            )

            normalized = min(
                1.0,
                distance / 1.35,
            )

            alpha = int(
                255
                * strength
                * (normalized ** 2)
            )

            pixels[x, y] = (
                0,
                0,
                0,
                alpha,
            )

    return Image.alpha_composite(
        im.convert("RGBA"),
        overlay,
    ).convert("RGB")


def darken_headline_area(
    im: Image.Image,
    zone,
    strength: float = 0.48,
) -> Image.Image:
    """Create a subtle dark gradient behind headline text.

    Unlike the old full-width dark band, this is restrained so the
    background still looks cinematic.
    """

    w, h = im.size

    overlay = Image.new(
        "RGBA",
        (w, h),
        (0, 0, 0, 0),
    )

    draw = ImageDraw.Draw(
        overlay
    )

    x0, y0, x1, y1 = zone

    # Expand slightly around the headline.
    margin = 80

    x0 = max(
        0,
        int(x0 - margin),
    )

    x1 = min(
        w,
        int(x1 + margin),
    )

    y0 = max(
        0,
        int(y0 - margin),
    )

    y1 = min(
        h,
        int(y1 + margin),
    )

    height = max(
        1,
        y1 - y0,
    )

    for y in range(
        y0,
        y1,
    ):

        relative = (
            y - y0
        ) / height

        # Strongest around the center/bottom of the text area.
        local = (
            0.30
            + 0.70 * relative
        )

        alpha = int(
            255
            * strength
            * local
        )

        draw.line(
            [
                (x0, y),
                (x1, y),
            ],
            fill=(
                0,
                0,
                0,
                alpha,
            ),
        )

    blurred = overlay.filter(
        ImageFilter.GaussianBlur(28)
    )

    return Image.alpha_composite(
        im.convert("RGBA"),
        blurred,
    ).convert("RGB")


# ============================================================================
# HEADLINE LAYOUT
# ============================================================================

def fit_words_to_lines(
    draw: ImageDraw.ImageDraw,
    words,
    max_width: int,
    max_lines: int,
    max_height: int,
    font_path: Path,
):
    """Wrap headline using real font measurements."""

    def measure(
        font,
        text,
    ):
        return draw.textlength(
            text,
            font=font,
        )

    def wrap_at(size):

        font = ImageFont.truetype(
            str(font_path),
            size,
        )

        space_w = measure(
            font,
            " ",
        )

        lines = []
        current = []
        current_w = 0.0

        for word in words:

            text = word["text"]

            word_w = measure(
                font,
                text,
            )

            add_w = (
                word_w
                + (
                    space_w
                    if current
                    else 0
                )
            )

            if (
                current
                and current_w + add_w
                > max_width
            ):

                lines.append(
                    current
                )

                current = [
                    word
                ]

                current_w = word_w

            else:

                current.append(
                    word
                )

                current_w += add_w

        if current:
            lines.append(
                current
            )

        return (
            font,
            lines,
            space_w,
        )

    sizes = [
        126,
        116,
        106,
        96,
        88,
        80,
        72,
        66,
        60,
        54,
        48,
        42,
        38,
        34,
        30,
    ]

    best = None

    for size in sizes:

        font, lines, space_w = wrap_at(
            size
        )

        line_height = int(
            font.size * 1.12
        )

        total_h = (
            line_height
            * len(lines)
        )

        best = (
            font,
            lines,
            space_w,
        )

        if (
            len(lines) <= max_lines
            and total_h <= max_height
        ):
            return (
                font,
                lines,
                space_w,
            )

    return best


def draw_headline(
    base: Image.Image,
    words,
    zone,
    font_path: Path,
):

    if not words:
        return base

    draw = ImageDraw.Draw(
        base
    )

    zone_w = (
        zone[2] - zone[0]
    )

    zone_h = (
        zone[3] - zone[1]
    )

    font, lines, space_w = (
        fit_words_to_lines(
            draw,
            words,
            int(zone_w * 0.94),
            max_lines=4,
            max_height=int(
                zone_h * 0.92
            ),
            font_path=font_path,
        )
    )

    line_height = int(
        font.size * 1.12
    )

    total_h = (
        line_height
        * len(lines)
    )

    start_y = (
        zone[1]
        + max(
            0,
            (
                zone_h
                - total_h
            ) // 2,
        )
    )

    # Thick but clean outline.
    outline_w = max(
        3,
        min(
            8,
            font.size // 13,
        ),
    )

    # ------------------------------------------------------------
    # Shadow layer
    # ------------------------------------------------------------

    shadow_layer = Image.new(
        "RGBA",
        base.size,
        (0, 0, 0, 0),
    )

    shadow_draw = ImageDraw.Draw(
        shadow_layer
    )

    for i, line in enumerate(
        lines
    ):

        line_w = (
            sum(
                draw.textlength(
                    w["text"],
                    font=font,
                )
                for w in line
            )
            + space_w
            * (
                len(line) - 1
            )
        )

        x = (
            zone[0]
            + (
                zone_w
                - line_w
            )
            / 2
        )

        y = (
            start_y
            + i
            * line_height
        )

        for word in line:

            text = word[
                "text"
            ]

            shadow_draw.text(
                (
                    x + 5,
                    y + 7,
                ),
                text,
                font=font,
                fill=(
                    0,
                    0,
                    0,
                    190,
                ),
            )

            x += (
                draw.textlength(
                    text,
                    font=font,
                )
                + space_w
            )

    shadow_layer = shadow_layer.filter(
        ImageFilter.GaussianBlur(5)
    )

    base_rgba = (
        base.convert("RGBA")
    )

    base_rgba = Image.alpha_composite(
        base_rgba,
        shadow_layer,
    )

    draw = ImageDraw.Draw(
        base_rgba
    )

    # ------------------------------------------------------------
    # Main headline
    # ------------------------------------------------------------

    for i, line in enumerate(
        lines
    ):

        line_w = (
            sum(
                draw.textlength(
                    w["text"],
                    font=font,
                )
                for w in line
            )
            + space_w
            * (
                len(line) - 1
            )
        )

        x = (
            zone[0]
            + (
                zone_w
                - line_w
            )
            / 2
        )

        y = (
            start_y
            + i
            * line_height
        )

        for word in line:

            text = word[
                "text"
            ]

            color = COLORS.get(
                word.get("color"),
                COLORS["white"],
            )

            draw.text(
                (
                    x,
                    y,
                ),
                text,
                font=font,
                fill=color,
                stroke_width=outline_w,
                stroke_fill=OUTLINE_COLOR,
            )

            x += (
                draw.textlength(
                    text,
                    font=font,
                )
                + space_w
            )

    return base_rgba.convert(
        "RGB"
    )


# ============================================================================
# CATEGORY LABEL
# ============================================================================

def draw_category_banner(
    base: Image.Image,
    label: str,
    font_path: Path,
    accent=(237, 28, 36),
):

    if not label:
        return base

    draw = ImageDraw.Draw(
        base
    )

    font = ImageFont.truetype(
        str(font_path),
        29,
    )

    pad_x = 20
    pad_y = 9

    text_w = draw.textlength(
        label,
        font=font,
    )

    box_w = int(
        text_w
        + pad_x * 2
    )

    box_h = int(
        font.size
        + pad_y * 2
    )

    # Slight shadow.
    draw.rounded_rectangle(
        [
            7,
            39,
            box_w + 7,
            39 + box_h,
        ],
        radius=6,
        fill=(0, 0, 0),
    )

    draw.rounded_rectangle(
        [
            0,
            32,
            box_w,
            32 + box_h,
        ],
        radius=6,
        fill=accent,
    )

    draw.text(
        (
            pad_x,
            32
            + pad_y
            - 2,
        ),
        label,
        font=font,
        fill=(255, 255, 255),
        stroke_width=2,
        stroke_fill=(0, 0, 0),
    )

    return base


# ============================================================================
# LOGO
# ============================================================================

def paste_logo(
    base: Image.Image,
    logo_path: Path,
    corner: str = "bottom-right",
):

    if not logo_path.exists():
        print(
            f"[thumbnail] logo not found: {logo_path}",
            file=sys.stderr,
        )
        return base

    logo = Image.open(
        logo_path
    ).convert("RGBA")

    # Slightly smaller than the previous version.
    # This keeps the logo branded without competing with the headline.
    target_h = int(
        base.height * 0.125
    )

    scale = (
        target_h
        / logo.height
    )

    logo = logo.resize(
        (
            int(
                logo.width
                * scale
            ),
            target_h,
        ),
        Image.LANCZOS,
    )

    margin = 24

    if corner == "bottom-right":

        pos = (
            base.width
            - logo.width
            - margin,
            base.height
            - logo.height
            - margin,
        )

    elif corner == "top-right":

        pos = (
            base.width
            - logo.width
            - margin,
            margin,
        )

    elif corner == "bottom-left":

        pos = (
            margin,
            base.height
            - logo.height
            - margin,
        )

    else:

        pos = (
            base.width
            - logo.width
            - margin,
            margin,
        )

    # ------------------------------------------------------------
    # Logo shadow
    # ------------------------------------------------------------

    shadow = Image.new(
        "RGBA",
        base.size,
        (0, 0, 0, 0),
    )

    shadow_alpha = (
        logo
        .split()[3]
        .point(
            lambda a:
                min(a, 145)
        )
    )

    shadow_layer = Image.new(
        "RGBA",
        logo.size,
        (0, 0, 0, 255),
    )

    shadow_layer.putalpha(
        shadow_alpha
    )

    shadow.paste(
        shadow_layer,
        (
            pos[0] + 3,
            pos[1] + 5,
        ),
        shadow_layer,
    )

    shadow = shadow.filter(
        ImageFilter.GaussianBlur(4)
    )

    base_rgba = (
        base.convert("RGBA")
    )

    base_rgba = Image.alpha_composite(
        base_rgba,
        shadow,
    )

    base_rgba.paste(
        logo,
        pos,
        logo,
    )

    return base_rgba.convert(
        "RGB"
    )


# ============================================================================
# LAYOUTS
# ============================================================================

# Each layout provides a slightly different headline position.
#
# Importantly:
# NO automatic yellow arrow.
# The visual itself must guide the viewer's eye.

LAYOUTS = [

    # Main premium layout.
    {
        "headline_zone": (
            54,
            360,
            1226,
            690,
        ),
        "logo_corner": "bottom-right",
        "show_banner": True,
    },

    # Higher headline layout.
    {
        "headline_zone": (
            54,
            95,
            1226,
            410,
        ),
        "logo_corner": "bottom-right",
        "show_banner": False,
    },

    # Upper/middle cinematic layout.
    {
        "headline_zone": (
            54,
            285,
            1226,
            625,
        ),
        "logo_corner": "top-right",
        "show_banner": True,
    },
]


# ============================================================================
# COMPOSITION
# ============================================================================

def compose_thumbnail(
    bg: Image.Image,
    analysis: dict,
    variation_index: int,
) -> Image.Image:

    # ------------------------------------------------------------
    # 1. Crop
    # ------------------------------------------------------------

    im = cover_crop(
        bg,
        OUT_WIDTH,
        OUT_HEIGHT,
    )

    # ------------------------------------------------------------
    # 2. Cinematic finishing
    # ------------------------------------------------------------

    im = cinematic_grade(
        im
    )

    # ------------------------------------------------------------
    # 3. Select layout
    # ------------------------------------------------------------

    layout = LAYOUTS[
        variation_index
        % len(LAYOUTS)
    ]

    zone = layout[
        "headline_zone"
    ]

    # ------------------------------------------------------------
    # 4. Add subtle headline contrast
    # ------------------------------------------------------------

    im = darken_headline_area(
        im,
        zone,
        strength=0.42,
    )

    # ------------------------------------------------------------
    # 5. Add subtle cinematic vignette
    # ------------------------------------------------------------

    im = add_vignette(
        im,
        strength=0.18,
    )

    # ------------------------------------------------------------
    # 6. Headline
    # ------------------------------------------------------------

    im = draw_headline(
        im,
        analysis.get(
            "words",
            [],
        ),
        zone,
        FONT_PATH,
    )

    # ------------------------------------------------------------
    # 7. Category banner
    # ------------------------------------------------------------

    if layout[
        "show_banner"
    ]:

        im = draw_category_banner(
            im,
            analysis.get(
                "category_label",
                "",
            ),
            FONT_PATH,
        )

    # ------------------------------------------------------------
    # 8. Channel logo
    # ------------------------------------------------------------

    im = paste_logo(
        im,
        LOGO_PATH,
        layout[
            "logo_corner"
        ],
    )

    return im


# ============================================================================
# CLI
# ============================================================================

def main():

    parser = argparse.ArgumentParser(
        description=(
            "NEXT SCENE TV premium "
            "thumbnail compositor"
        )
    )

    parser.add_argument(
        "--title",
        required=True,
    )

    parser.add_argument(
        "--variations",
        type=int,
        default=1,
    )

    parser.add_argument(
        "--out-dir",
        required=True,
    )

    parser.add_argument(
        "--style",
        default=None,
        help=(
            "Optional extra style hint "
            "appended to the image prompt"
        ),
    )

    args = parser.parse_args()

    out_dir = Path(
        args.out_dir
    )

    out_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    # ------------------------------------------------------------
    # Analyze title
    # ------------------------------------------------------------

    print(
        "[thumbnail] analyzing title...",
        file=sys.stderr,
    )

    analysis = analyze_title(
        args.title
    )

    # ------------------------------------------------------------
    # Optional workflow style hint
    # ------------------------------------------------------------

    if args.style:

        analysis[
            "image_prompt"
        ] = (
            f"{analysis['image_prompt']} "
            f"Additional visual direction: "
            f"{args.style}."
        )

    print(
        f"[thumbnail] category: "
        f"{analysis.get('category')}",
        file=sys.stderr,
    )

    print(
        f"[thumbnail] headline: "
        f"{' '.join(w['text'] for w in analysis.get('words', []))}",
        file=sys.stderr,
    )

    # ------------------------------------------------------------
    # Generate variations
    # ------------------------------------------------------------

    generated = []

    requested_variations = max(
        1,
        args.variations,
    )

    for i in range(
        1,
        requested_variations + 1,
    ):

        seed = random.randint(
            1,
            2_147_483_647,
        )

        try:

            print(
                f"[thumbnail] generating "
                f"background {i}/{requested_variations}...",
                file=sys.stderr,
            )

            bg = generate_background(
                analysis[
                    "image_prompt"
                ],
                seed=seed,
            )

            thumb = compose_thumbnail(
                bg,
                analysis,
                variation_index=i - 1,
            )

            out_path = (
                out_dir
                / f"thumbnail_{i:02d}.jpg"
            )

            thumb.save(
                out_path,
                "JPEG",
                quality=95,
                optimize=True,
            )

            generated.append(
                str(out_path)
            )

            print(
                f"[thumbnail] variation "
                f"{i}/{requested_variations} ready: "
                f"{out_path}",
                file=sys.stderr,
            )

        except Exception as err:

            print(
                f"[thumbnail] variation "
                f"{i}/{requested_variations} failed, "
                f"skipping: {err}",
                file=sys.stderr,
            )

            traceback.print_exc(
                file=sys.stderr
            )

    # ------------------------------------------------------------
    # Machine-readable output
    # ------------------------------------------------------------

    print(
        json.dumps(
            {
                "generated": generated,
                "category": analysis.get(
                    "category"
                ),
            }
        )
    )

    if not generated:
        sys.exit(1)


# ============================================================================
# ENTRY POINT
# ============================================================================

if __name__ == "__main__":
    main()
