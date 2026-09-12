#!/usr/bin/env python3
"""
NEXT SCENE TV premium thumbnail compositor.

Pipeline:
    title
      ↓
    Gemini visual concept / art direction
      ↓
    FLUX.1-schnell cinematic background
      ↓
    Pillow composition
      ↓
    Real headline + category label + logo
      ↓
    1280x720 JPEG

The generated background is NEVER asked to contain:
- text
- words
- letters
- numbers
- logos
- watermarks
- captions
- typography

All important thumbnail text is added locally with Pillow.
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
    requests = None

try:
    from huggingface_hub import InferenceClient
except ImportError:
    InferenceClient = None


# ============================================================
# PATHS / CONFIG
# ============================================================

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

FONT_PATH = REPO_ROOT / "assets" / "fonts" / "Anton-Regular.ttf"
LOGO_PATH = REPO_ROOT / "assets" / "logo.png"

OUT_WIDTH = 1280
OUT_HEIGHT = 720

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


# ============================================================
# COLORS
# ============================================================

COLORS = {
    "white": (255, 255, 255),
    "yellow": (255, 214, 10),
    "red": (237, 28, 36),
    "green": (60, 220, 90),
}

OUTLINE_COLOR = (0, 0, 0)


# ============================================================
# GEMINI ART-DIRECTION PROMPT
# ============================================================

ANALYZE_PROMPT_TMPL = r"""
You are the senior visual director and thumbnail art director for
NEXT SCENE TV, a premium documentary and world-news YouTube channel.

Analyze this video title:

"{title}"

Your job is to create a highly clickable but sophisticated YouTube
thumbnail concept.

IMPORTANT:
The thumbnail must feel like premium documentary journalism,
not a cheap clickbait thumbnail.

CORE VISUAL RULES:

1. Create ONE dominant visual idea.
2. Use a strong cinematic photographic composition.
3. Use one main hero subject whenever appropriate.
4. Put the main subject generally on the left or right third.
5. Leave the opposite side visually cleaner and darker so that the
   headline can be placed there.
6. Use realistic photography rather than cartoon or illustration.
7. Use cinematic lighting and realistic depth.
8. Make the image immediately understandable on a phone screen.
9. Avoid clutter.
10. Avoid unnecessary small objects.
11. Avoid generic stock-photo appearance.
12. Make the visual directly connected to the title.
13. The image should create curiosity without misleading the viewer.
14. Prefer dramatic composition, scale, depth, atmosphere and emotion.
15. Keep faces realistic and natural whenever people appear.
16. Use sophisticated colors and lighting.
17. Preserve enough dark/clean negative space for large typography.

STORY-SPECIFIC VISUAL LANGUAGE:

GEOPOLITICS / WAR / CONFLICT:
- Use powerful environments, military silhouettes, maps-like geography
  only when visually natural, borders, political buildings, leaders,
  soldiers, strategic landscapes, tension, smoke, dramatic skies.
- Avoid excessive explosions unless the title specifically concerns war
  or destruction.
- Do not make the scene look like a video game.

AFRICA:
- Use authentic African environments, cities, landscapes, infrastructure,
  people, wildlife, resources or economic activity depending on the title.
- Avoid stereotypical poverty imagery unless the story specifically
  concerns poverty.
- Favor modern, cinematic and visually powerful African imagery.

ECONOMY / BUSINESS:
- Use realistic financial districts, factories, ports, energy facilities,
  money-related visual symbolism, markets, technology or infrastructure.
- Avoid literal floating money unless strongly relevant.

COUNTRIES / RANKINGS:
- Use recognizable geography, skyline, infrastructure, landscape,
  national symbolism or a powerful visual representation of the subject.
- Do not fill the image with flags.

CITIES:
- Use recognizable skyline, streets, landmarks, transportation,
  architecture and atmosphere.

TECHNOLOGY:
- Use realistic futuristic technology, AI systems, robotics, chips,
  data centers, satellites, computers or advanced infrastructure.
- Avoid generic glowing blue "AI" backgrounds.

DISASTERS:
- Use realistic environmental or infrastructure consequences:
  storms, floods, fires, earthquakes, damaged buildings, drought,
  volcanic activity, etc., depending on the title.
- Maintain documentary realism.

PEOPLE:
- Use realistic human expressions and cinematic portraits.
- Avoid distorted faces, extra fingers or unnatural anatomy.

FUTURE / PREDICTIONS:
- Make the image feel cinematic and forward-looking.
- Use realistic future infrastructure, technology, cities or environments.
- Do not make it look like fantasy.

EMOTIONAL RESPONSE:

Choose one dominant emotional response appropriate to the story:
- concern
- curiosity
- surprise
- urgency
- awe
- hope
- tension
- anticipation

HEADLINE STRATEGY:

The YouTube thumbnail headline must NOT simply repeat the entire
video title.

Create a short thumbnail headline of approximately 3–8 words.

Use powerful words.

Prioritize:
- clarity
- curiosity
- emotional impact
- mobile readability

The headline will be rendered separately by Pillow.

Do NOT include text inside the generated image.

VERY IMPORTANT:

The image_prompt must describe ONLY the visual scene.

Do NOT ask the image generator to render:
- text
- words
- letters
- numbers
- logos
- watermarks
- captions
- labels
- typography

The generated background should look like a clean cinematic photograph.

Return ONLY valid JSON.

Use exactly this structure:

{{
  "image_prompt": "A detailed English prompt describing ONLY the cinematic photographic scene.",
  "category": "one of: war, africa, economy, countries, cities, technology, disaster, people, other",
  "category_label": "short 1-3 word ALL CAPS label",
  "words": [
    {{"text": "WORD", "color": "white"}}
  ]
}}

For "words", use only these colors:
- white
- yellow
- red
- green

The words should be short and powerful.

Do not include markdown.
Do not include ```json.
Do not explain your answer.
"""


# ============================================================
# GENERAL HELPERS
# ============================================================

def _clean_json(text: str) -> str:
    """
    Remove markdown fences and surrounding whitespace from Gemini output.
    """
    if not text:
        return ""

    text = text.strip()

    text = re.sub(
        r"^```(?:json)?\s*",
        "",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"\s*```$",
        "",
        text,
        flags=re.IGNORECASE,
    )

    return text.strip()


def _fallback_prompt(title: str, category: str) -> str:
    """
    Safe fallback visual prompt if Gemini fails.
    """

    prompts = {
        "war": (
            "A cinematic documentary photograph related to the story, "
            "showing a tense geopolitical or military environment with "
            "realistic people, vehicles or strategic infrastructure, "
            "dramatic natural lighting, atmospheric depth, realistic "
            "photography, strong composition, subject positioned to one "
            "side with clean darker negative space on the opposite side"
        ),

        "africa": (
            "A premium documentary photograph connected to the African "
            "story, showing an authentic modern African environment, "
            "city, landscape, infrastructure or people relevant to the "
            "story, cinematic natural lighting, realistic photography, "
            "strong depth and composition, with clean darker negative "
            "space for headline text"
        ),

        "economy": (
            "A cinematic documentary photograph representing the economic "
            "story through realistic modern infrastructure, business "
            "districts, industry, energy, transportation or financial "
            "activity, sophisticated lighting, realistic photography, "
            "strong depth and clean negative space for headline text"
        ),

        "countries": (
            "A cinematic documentary photograph representing the country "
            "or countries in the story using recognizable landscapes, "
            "architecture, infrastructure or urban environments, "
            "realistic photography, dramatic cinematic lighting and "
            "clean darker negative space for headline text"
        ),

        "cities": (
            "A cinematic documentary photograph of a major city environment "
            "connected to the story, recognizable architecture and urban "
            "infrastructure, realistic people and vehicles where useful, "
            "dramatic cinematic lighting, realistic photography and clean "
            "negative space for headline text"
        ),

        "technology": (
            "A premium cinematic documentary photograph showing realistic "
            "advanced technology connected to the story, such as AI, "
            "robotics, data centers, chips, satellites or advanced "
            "infrastructure, sophisticated lighting, realistic materials, "
            "deep perspective and clean negative space for headline text"
        ),

        "disaster": (
            "A realistic cinematic documentary photograph showing the "
            "environmental or infrastructure consequences of the story, "
            "such as flooding, wildfire, storm, earthquake, drought or "
            "damaged infrastructure, dramatic natural lighting, realistic "
            "scale and clean darker negative space for headline text"
        ),

        "people": (
            "A cinematic documentary photograph focused on realistic "
            "human subjects relevant to the story, natural expressions, "
            "authentic environment, sophisticated cinematic lighting, "
            "realistic skin and anatomy, strong depth and clean negative "
            "space for headline text"
        ),

        "other": (
            "A cinematic premium documentary photograph directly connected "
            "to the story, realistic photography, strong visual storytelling, "
            "dramatic but natural lighting, realistic depth and one dominant "
            "subject positioned to leave clean darker negative space for "
            "headline text"
        ),
    }

    base = prompts.get(category, prompts["other"])

    return (
        f"{base}. "
        f"The story concerns: {title}. "
        "No text, no words, no letters, no numbers, no logos, "
        "no watermarks, no captions, no typography."
    )


# ============================================================
# GEMINI TITLE ANALYSIS
# ============================================================

def analyze_title_with_gemini(title: str):
    if not GEMINI_API_KEY:
        return None

    if requests is None:
        print(
            "[thumbnail] requests is not installed",
            file=sys.stderr,
        )
        return None

    safe_title = title.replace('"', "'")

    prompt = ANALYZE_PROMPT_TMPL.format(
        title=safe_title
    )

    last_err = None

    for model in GEMINI_MODELS:
        try:
            print(
                f"[thumbnail] asking Gemini model: {model}"
            )

            res = requests.post(
                (
                    "https://generativelanguage.googleapis.com/"
                    f"v1beta/models/{model}:generateContent"
                ),
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
                    f"{model} responded {res.status_code}: "
                    f"{res.text[:500]}"
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

                color = w.get(
                    "color",
                    "white"
                )

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
                (
                    f"[thumbnail] title analysis via {model} failed: "
                    f"{err}, trying next model..."
                ),
                file=sys.stderr,
            )

    print(
        (
            "[thumbnail] all Gemini analysis models failed "
            f"({last_err}), using rule-based fallback"
        ),
        file=sys.stderr,
    )

    return None


# ============================================================
# RULE-BASED FALLBACK ANALYSIS
# ============================================================

def analyze_title_fallback(title: str):
    """
    Backup analysis if Gemini is unavailable.
    """

    lower = title.lower()

    category = "other"

    if any(
        word in lower
        for word in [
            "war",
            "military",
            "army",
            "soldier",
            "conflict",
            "missile",
            "weapon",
            "battle",
            "attack",
            "invasion",
        ]
    ):
        category = "war"

    elif any(
        word in lower
        for word in [
            "africa",
            "african",
            "kenya",
            "nigeria",
            "ghana",
            "ethiopia",
            "tanzania",
            "uganda",
            "south africa",
            "rwanda",
        ]
    ):
        category = "africa"

    elif any(
        word in lower
        for word in [
            "economy",
            "economic",
            "money",
            "market",
            "business",
            "trade",
            "bank",
            "finance",
            "oil",
            "gold",
            "currency",
        ]
    ):
        category = "economy"

    elif any(
        word in lower
        for word in [
            "country",
            "countries",
            "nation",
            "nations",
            "ranking",
            "ranked",
            "richest",
            "poorest",
            "largest",
            "smallest",
        ]
    ):
        category = "countries"

    elif any(
        word in lower
        for word in [
            "city",
            "cities",
            "capital",
            "urban",
            "skyline",
        ]
    ):
        category = "cities"

    elif any(
        word in lower
        for word in [
            "ai",
            "artificial intelligence",
            "robot",
            "robotics",
            "technology",
            "tech",
            "chip",
            "computer",
            "satellite",
            "future",
        ]
    ):
        category = "technology"

    elif any(
        word in lower
        for word in [
            "flood",
            "fire",
            "earthquake",
            "storm",
            "disaster",
            "drought",
            "volcano",
            "hurricane",
            "tornado",
        ]
    ):
        category = "disaster"

    elif any(
        word in lower
        for word in [
            "people",
            "population",
            "president",
            "leader",
            "person",
            "human",
        ]
    ):
        category = "people"

    words_raw = re.findall(
        r"[A-Za-z0-9]+",
        title
    )

    dramatic = {
        "war",
        "collapse",
        "crisis",
        "danger",
        "attack",
        "deadly",
        "disaster",
        "destroyed",
        "threat",
        "shock",
        "warning",
        "fear",
    }

    positive = {
        "growth",
        "rise",
        "rising",
        "success",
        "future",
        "power",
        "strong",
        "boom",
        "opportunity",
    }

    result_words = []

    for word in words_raw[:8]:
        lw = word.lower()

        if lw in dramatic:
            color = "red"

        elif lw in positive:
            color = "green"

        elif re.fullmatch(
            r"\d+(?:-\d+)?",
            word
        ):
            color = "yellow"

        else:
            color = "white"

        result_words.append(
            {
                "text": word.upper(),
                "color": color,
            }
        )

    if not result_words:
        result_words = [
            {
                "text": "THE FUTURE",
                "color": "white",
            }
        ]

    labels = {
        "war": "GLOBAL CONFLICT",
        "africa": "AFRICA",
        "economy": "ECONOMY",
        "countries": "COUNTRIES",
        "cities": "CITIES",
        "technology": "TECHNOLOGY",
        "disaster": "BREAKING",
        "people": "PEOPLE",
        "other": "WORLD",
    }

    return {
        "image_prompt": _fallback_prompt(
            title,
            category,
        ),
        "category": category,
        "category_label": labels.get(
            category,
            "WORLD",
        ),
        "words": result_words[:8],
    }


def analyze_title(title: str):
    """
    Gemini first, rule-based fallback second.
    """

    print("[thumbnail] analyzing title...")

    result = analyze_title_with_gemini(
        title
    )

    if result:
        return result

    print(
        "[thumbnail] using rule-based title analysis"
    )

    return analyze_title_fallback(
        title
    )


# ============================================================
# FLUX BACKGROUND GENERATION
# ============================================================

def generate_background(
    prompt: str,
    seed: int | None = None,
):
    if InferenceClient is None:
        raise RuntimeError(
            "huggingface_hub is not installed"
        )

    if not HF_TOKEN:
        raise RuntimeError(
            "HF_TOKEN is not configured"
        )

    if seed is None:
        seed = random.randint(
            1,
            2_147_483_647,
        )

    print(
        f"[thumbnail] generating FLUX background "
        f"(seed={seed})..."
    )

    client = InferenceClient(
        provider="auto",
        api_key=HF_TOKEN,
    )

    try:
        image = client.text_to_image(
            prompt=prompt,
            model=FLUX_MODEL,
            width=GEN_WIDTH,
            height=GEN_HEIGHT,
            seed=seed,
        )
    except Exception as first_error:
        print(
            (
                "[thumbnail] FLUX dimension request failed: "
                f"{first_error}"
            ),
            file=sys.stderr,
        )

        print(
            "[thumbnail] retrying FLUX without explicit dimensions..."
        )

        image = client.text_to_image(
            prompt=prompt,
            model=FLUX_MODEL,
        )

    if not isinstance(image, Image.Image):
        raise RuntimeError(
            "FLUX did not return a PIL image"
        )

    return image.convert("RGB")


# ============================================================
# IMAGE PROCESSING
# ============================================================

def crop_to_cover(
    image: Image.Image,
    width: int,
    height: int,
):
    """
    Crop an image to fill the requested dimensions.
    """

    image = image.convert("RGB")

    source_ratio = (
        image.width / image.height
    )

    target_ratio = (
        width / height
    )

    if source_ratio > target_ratio:
        # Source is wider.
        new_height = height
        new_width = int(
            height * source_ratio
        )

    else:
        # Source is taller.
        new_width = width
        new_height = int(
            width / source_ratio
        )

    image = image.resize(
        (new_width, new_height),
        Image.Resampling.LANCZOS,
    )

    left = (
        new_width - width
    ) // 2

    top = (
        new_height - height
    ) // 2

    return image.crop(
        (
            left,
            top,
            left + width,
            top + height,
        )
    )


def cinematic_grade(
    image: Image.Image,
):
    """
    Premium documentary-style grade.
    """

    image = image.convert("RGB")

    image = ImageEnhance.Contrast(
        image
    ).enhance(1.14)

    image = ImageEnhance.Color(
        image
    ).enhance(1.08)

    image = ImageEnhance.Sharpness(
        image
    ).enhance(1.12)

    return image


def add_vignette(
    image: Image.Image,
    strength: float = 0.32,
):
    """
    Add subtle cinematic vignette.
    """

    width, height = image.size

    vignette = Image.new(
        "L",
        (width, height),
        255,
    )

    draw = ImageDraw.Draw(
        vignette
    )

    cx = width / 2
    cy = height / 2

    max_radius = math.sqrt(
        cx * cx + cy * cy
    )

    for y in range(height):
        for x in range(width):
            dx = x - cx
            dy = y - cy

            distance = math.sqrt(
                dx * dx + dy * dy
            )

            normalized = min(
                1.0,
                distance / max_radius
            )

            value = int(
                255
                * (
                    1
                    - strength
                    * normalized
                    * normalized
                )
            )

            draw.point(
                (x, y),
                fill=value,
            )

    return Image.composite(
        image,
        Image.new(
            "RGB",
            image.size,
            (0, 0, 0),
        ),
        vignette,
    )


def darken_headline_area(
    image: Image.Image,
    side: str = "left",
):
    """
    Add a gradient darkening to the headline side.
    """

    overlay = Image.new(
        "RGBA",
        image.size,
        (0, 0, 0, 0),
    )

    width, height = image.size

    pixels = overlay.load()

    for x in range(width):
        if side == "left":
            distance = x / max(
                1,
                width - 1,
            )
        else:
            distance = (
                width - 1 - x
            ) / max(
                1,
                width - 1,
            )

        alpha = int(
            145
            * max(
                0,
                1 - distance * 1.7,
            )
        )

        for y in range(height):
            pixels[x, y] = (
                0,
                0,
                0,
                alpha,
            )

    return Image.alpha_composite(
        image.convert("RGBA"),
        overlay,
    ).convert("RGB")


# ============================================================
# FONT HELPERS
# ============================================================

def load_font(size: int):
    """
    Load Anton if available, otherwise use a system fallback.
    """

    if FONT_PATH.exists():
        return ImageFont.truetype(
            str(FONT_PATH),
            size,
        )

    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ]

    for path in candidates:
        if os.path.exists(path):
            return ImageFont.truetype(
                path,
                size,
            )

    return ImageFont.load_default()


def text_bbox(
    draw,
    text,
    font,
    stroke_width=0,
):
    return draw.textbbox(
        (0, 0),
        text,
        font=font,
        stroke_width=stroke_width,
    )


def text_size(
    draw,
    text,
    font,
    stroke_width=0,
):
    box = text_bbox(
        draw,
        text,
        font,
        stroke_width,
    )

    return (
        box[2] - box[0],
        box[3] - box[1],
    )


# ============================================================
# HEADLINE LAYOUT
# ============================================================

def wrap_headline_words(
    words,
    max_chars=16,
):
    """
    Turn individual headline words into 2–4 balanced lines.
    """

    if not words:
        return []

    lines = []
    current = []

    for word in words:
        proposed = (
            current + [word]
        )

        length = len(
            " ".join(proposed)
        )

        if (
            current
            and length > max_chars
        ):
            lines.append(
                current
            )
            current = [word]

        else:
            current = proposed

    if current:
        lines.append(
            current
        )

    return lines


def fit_headline(
    draw,
    words,
    max_width,
    max_height,
):
    """
    Find the largest usable font size.
    """

    if not words:
        return (
            [],
            load_font(70),
        )

    for size in range(
        112,
        42,
        -2,
    ):
        font = load_font(size)

        lines = wrap_headline_words(
            words,
            max_chars=18,
        )

        max_line_width = 0
        total_height = 0

        for line in lines:
            text = " ".join(
                item["text"]
                for item in line
            )

            w, h = text_size(
                draw,
                text,
                font,
                stroke_width=max(
                    2,
                    size // 22,
                ),
            )

            max_line_width = max(
                max_line_width,
                w,
            )

            total_height += (
                h + int(size * 0.08)
            )

        if (
            max_line_width <= max_width
            and total_height <= max_height
        ):
            return (
                lines,
                font,
            )

    return (
        wrap_headline_words(
            words,
            max_chars=14,
        ),
        load_font(48),
    )


# ============================================================
# DRAW HEADLINE
# ============================================================

def draw_headline(
    image: Image.Image,
    words,
    side: str = "left",
):
    """
    Draw premium mobile-readable headline.
    """

    draw = ImageDraw.Draw(
        image
    )

    max_width = int(
        image.width * 0.47
    )

    max_height = int(
        image.height * 0.72
    )

    lines, font = fit_headline(
        draw,
        words,
        max_width,
        max_height,
    )

    if side == "left":
        x = int(
            image.width * 0.055
        )
    else:
        x = int(
            image.width * 0.52
        )

    y = int(
        image.height * 0.16
    )

    stroke_width = max(
        3,
        font.size // 22,
    )

    line_gap = int(
        font.size * 0.08
    )

    for line in lines:
        text = " ".join(
            item["text"]
            for item in line
        )

        # Calculate total line width.
        widths = []

        for item in line:
            w, _ = text_size(
                draw,
                item["text"],
                font,
                stroke_width,
            )

            widths.append(w)

        spacing = int(
            font.size * 0.16
        )

        total_width = (
            sum(widths)
            + spacing * max(
                0,
                len(line) - 1,
            )
        )

        current_x = x

        # Draw each word separately so
        # Gemini color decisions are preserved.
        for index, item in enumerate(
            line
        ):
            color = COLORS.get(
                item["color"],
                COLORS["white"],
            )

            draw.text(
                (
                    current_x,
                    y,
                ),
                item["text"],
                font=font,
                fill=color,
                stroke_width=stroke_width,
                stroke_fill=OUTLINE_COLOR,
            )

            current_x += (
                widths[index]
                + spacing
            )

        line_height = int(
            font.size * 0.88
        )

        y += (
            line_height
            + line_gap
        )

    return image


# ============================================================
# CATEGORY LABEL
# ============================================================

def draw_category_label(
    image: Image.Image,
    label: str,
):
    if not label:
        return image

    draw = ImageDraw.Draw(
        image
    )

    font = load_font(27)

    padding_x = 18
    padding_y = 9

    text_w, text_h = text_size(
        draw,
        label,
        font,
    )

    x = 36
    y = 30

    rect = (
        x,
        y,
        x
        + text_w
        + padding_x * 2,
        y
        + text_h
        + padding_y * 2,
    )

    draw.rounded_rectangle(
        rect,
        radius=6,
        fill=COLORS["red"],
    )

    draw.text(
        (
            x + padding_x,
            y + padding_y - 2,
        ),
        label,
        font=font,
        fill=COLORS["white"],
    )

    return image


# ============================================================
# LOGO
# ============================================================

def draw_logo(
    image: Image.Image,
):
    if not LOGO_PATH.exists():
        print(
            f"[thumbnail] logo not found: {LOGO_PATH}",
            file=sys.stderr,
        )
        return image

    try:
        logo = Image.open(
            LOGO_PATH
        ).convert("RGBA")

        max_width = int(
            image.width * 0.18
        )

        max_height = int(
            image.height * 0.12
        )

        logo.thumbnail(
            (
                max_width,
                max_height,
            ),
            Image.Resampling.LANCZOS,
        )

        margin = 28

        x = (
            image.width
            - logo.width
            - margin
        )

        y = (
            image.height
            - logo.height
            - margin
        )

        image = image.convert(
            "RGBA"
        )

        image.alpha_composite(
            logo,
            (
                x,
                y,
            ),
        )

        return image.convert(
            "RGB"
        )

    except Exception as err:
        print(
            f"[thumbnail] logo error: {err}",
            file=sys.stderr,
        )

        return image


# ============================================================
# COMPOSITION
# ============================================================

def choose_layout(
    variation_index: int,
):
    """
    Three controlled compositions.
    """

    layouts = [
        {
            "headline_side": "left",
        },
        {
            "headline_side": "right",
        },
        {
            "headline_side": "left",
        },
    ]

    return layouts[
        variation_index
        % len(layouts)
    ]


def compose_thumbnail(
    background: Image.Image,
    analysis: dict,
    variation_index: int,
):
    """
    Final premium thumbnail composition.
    """

    layout = choose_layout(
        variation_index
    )

    headline_side = layout[
        "headline_side"
    ]

    image = crop_to_cover(
        background,
        OUT_WIDTH,
        OUT_HEIGHT,
    )

    image = cinematic_grade(
        image
    )

    image = darken_headline_area(
        image,
        side=headline_side,
    )

    image = add_vignette(
        image,
        strength=0.28,
    )

    image = draw_category_label(
        image,
        analysis.get(
            "category_label",
            "",
        ),
    )

    image = draw_headline(
        image,
        analysis.get(
            "words",
            [],
        ),
        side=headline_side,
    )

    image = draw_logo(
        image
    )

    return image


# ============================================================
# SAVE
# ============================================================

def save_thumbnail(
    image: Image.Image,
    path: Path,
):
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    image = image.convert(
        "RGB"
    )

    image.save(
        path,
        "JPEG",
        quality=95,
        optimize=True,
        progressive=True,
    )

    print(
        f"[thumbnail] saved: {path}"
    )


# ============================================================
# MAIN
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description=(
            "Generate premium NEXT SCENE TV thumbnails"
        )
    )

    parser.add_argument(
        "--title",
        required=True,
        help=(
            "Video title exactly as it should be analyzed"
        ),
    )

    parser.add_argument(
        "--variations",
        type=int,
        default=1,
        help=(
            "Number of thumbnail variations"
        ),
    )

    parser.add_argument(
        "--out-dir",
        required=True,
        help=(
            "Output directory"
        ),
    )

    parser.add_argument(
        "--style",
        default=None,
        help=(
            "Optional additional style hint"
        ),
    )

    args = parser.parse_args()

    title = args.title.strip()

    if not title:
        raise RuntimeError(
            "Title cannot be empty"
        )

    variations = max(
        1,
        int(args.variations),
    )

    out_dir = Path(
        args.out_dir
    )

    out_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    # --------------------------------------------------------
    # TITLE ANALYSIS
    # --------------------------------------------------------

    analysis = analyze_title(
        title
    )

    # --------------------------------------------------------
    # OPTIONAL STYLE
    # --------------------------------------------------------

    image_prompt = analysis[
        "image_prompt"
    ]

    if args.style:
        image_prompt = (
            f"{image_prompt}. "
            f"Additional style direction: {args.style}."
        )

    # Absolute protection against text
    # appearing in generated background.
    image_prompt = (
        f"{image_prompt}. "
        "The image must contain absolutely no text, "
        "words, letters, numbers, logos, watermarks, "
        "captions, labels or typography."
    )

    print(
        "[thumbnail] category:",
        analysis.get(
            "category",
            "other",
        ),
    )

    print(
        "[thumbnail] headline:",
        " ".join(
            w["text"]
            for w in analysis.get(
                "words",
                [],
            )
        ),
    )

    # --------------------------------------------------------
    # GENERATE VARIATIONS
    # --------------------------------------------------------

    for i in range(
        variations
    ):
        print(
            (
                f"[thumbnail] variation "
                f"{i + 1}/{variations}"
            )
        )

        # Different deterministic seed
        # for every variation.
        seed = (
            int(
                time.time()
                * 1000
            )
            + i * 7919
        ) % 2_147_483_647

        try:
            background = generate_background(
                image_prompt,
                seed=seed,
            )

            final_image = compose_thumbnail(
                background,
                analysis,
                i,
            )

            output_path = (
                out_dir
                / f"thumbnail_{i + 1:02d}.jpg"
            )

            save_thumbnail(
                final_image,
                output_path,
            )

        except Exception as err:
            print(
                (
                    f"[thumbnail] variation "
                    f"{i + 1} failed: {err}"
                ),
                file=sys.stderr,
            )

            traceback.print_exc()

    print(
        "[thumbnail] generation complete."
    )


if __name__ == "__main__":
    main()
