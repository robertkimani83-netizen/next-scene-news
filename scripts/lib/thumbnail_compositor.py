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
    ImageFont,
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

ANALYZE_PROMPT_TMPL = """
You are the Chief Visual Director and Senior YouTube Thumbnail Strategist
for NEXT SCENE TV, a premium international documentary and world-news channel.

Your job is to turn the video title below into ONE powerful visual concept
for a high-performing YouTube thumbnail.

VIDEO TITLE:
"{title}"

The thumbnail should feel like a combination of:

- BBC World News
- Reuters / AP visual journalism
- Netflix documentary artwork
- premium international news television
- modern investigative documentary photography

The result must look PROFESSIONAL, CINEMATIC, EXPENSIVE and REAL.

DO NOT create generic AI artwork.
DO NOT create cheap clickbait.
DO NOT create a stock-photo collage.
DO NOT create a video-game image.
DO NOT create a movie poster.
DO NOT create an infographic.
DO NOT create a children's illustration.
DO NOT overload the image with many unrelated objects.

============================================================
CORE VISUAL RULE
============================================================

Choose ONE dominant visual idea.

The viewer should immediately understand the story from the image
without needing to read the full title.

Use:

- one dominant subject
- strong depth
- cinematic perspective
- realistic photography
- dramatic but believable lighting
- professional composition
- clear foreground / middle-ground / background separation
- strong contrast
- realistic atmospheric effects

The image must feel like a frame from a major international documentary.

============================================================
COMPOSITION
============================================================

Reserve approximately 35-45% of the image for the headline.

The headline will be added later by Pillow.

Therefore:

DO NOT place important faces, vehicles, buildings, weapons,
flags, landmarks or other important subjects in the headline area.

The main visual subject should be positioned intelligently on the
opposite side of the headline.

Use strong visual hierarchy.

Prefer:

- wide cinematic framing
- slightly low camera angles
- dramatic perspective
- foreground objects
- atmospheric depth
- realistic scale

Avoid flat compositions.

============================================================
SUBJECT SELECTION
============================================================

Choose the most visually powerful interpretation of the title.

For geopolitical or military stories:

Use realistic military equipment, aircraft, ships, soldiers,
government buildings, borders, maps represented visually,
satellite-style landscapes, command centers, or tense international
scenes.

Avoid excessive explosions unless the title specifically concerns war,
attack or destruction.

For Africa stories:

Use realistic African locations, cities, people, landscapes,
infrastructure, markets, ports, technology, government buildings,
mining areas or other relevant subjects.

Avoid stereotypical poverty imagery unless the story is specifically
about poverty.

For economy/business stories:

Use financial districts, factories, ports, oil infrastructure,
currency, trading environments, shipping containers,
business executives, industrial production or economic infrastructure.

Avoid cheesy floating money graphics.

For country comparisons/rankings:

Show visually distinctive real-world elements associated with the
countries while maintaining a serious documentary style.

Do not create a collage of flags.

For cities:

Use recognizable architecture, skyline, roads, transport,
infrastructure or landmarks.

For technology:

Use realistic modern technology, data centers, robotics,
AI infrastructure, semiconductor facilities, satellites,
cybersecurity environments or advanced machines.

Avoid generic glowing blue "AI" graphics.

For disasters:

Show realistic environmental conditions, damaged infrastructure,
storms, flooding, fires, earthquakes or emergency response.

Keep the image dramatic but believable.

For people:

Use realistic documentary photography style.

Faces should look natural and emotionally appropriate.

Avoid distorted faces, extra fingers, artificial skin,
plastic-looking people or exaggerated expressions.

============================================================
EMOTION
============================================================

The thumbnail should create one strong emotion:

- tension
- urgency
- curiosity
- concern
- surprise
- scale
- mystery
- anticipation
- importance

Do not make the emotion cartoonish.

============================================================
HEADLINE
============================================================

Create a short thumbnail headline of approximately 2-6 words.

The headline should NOT simply repeat the full video title.

It should capture the strongest hook.

Examples:

"THE NEXT WAR?"
"AFRICA'S HIDDEN POWER"
"THE WORLD IS CHANGING"
"10 COUNTRIES AT RISK"
"THE MONEY SHIFT"
"WHO WILL FALL FIRST?"

Return individual words separately.

Each word must have one of these colors:

white
yellow
red
green

Use:

RED for danger, conflict, warning or urgency.

YELLOW for numbers, important emphasis or key facts.

GREEN for positive growth, opportunity or progress.

WHITE for normal headline words.

Do not use more than 6 words.

============================================================
STRICT BACKGROUND RULE
============================================================

The generated image must contain NO:

- text
- words
- letters
- numbers
- logos
- watermarks
- captions
- labels
- typography
- signs with readable writing

The final headline will be added separately.

============================================================
QUALITY CONTROL
============================================================

The visual prompt must explicitly request:

- photorealistic
- cinematic documentary photography
- professional lighting
- realistic materials
- realistic human anatomy
- realistic scale
- detailed environment
- natural color grading
- high dynamic range
- strong subject separation
- premium editorial photography

Avoid:

- distorted anatomy
- duplicate people
- duplicate vehicles
- extra limbs
- melted objects
- unrealistic buildings
- fantasy unless explicitly required
- cartoon style
- illustration style
- oversaturated colors
- excessive lens effects
- fake text
- watermarks
- logos
- captions
- typography

============================================================
OUTPUT
============================================================

Return ONLY valid JSON.

Use exactly this structure:

{{
  "image_prompt": "detailed cinematic visual prompt",
  "category": "war|africa|economy|countries|cities|technology|disaster|people|other",
  "category_label": "short uppercase label",
  "words": [
    {{
      "text": "WORD",
      "color": "white"
    }}
  ]
}}

The image_prompt should be detailed enough for FLUX to generate a
premium documentary-quality background.

The image_prompt must NOT request text or typography.
"""


# ============================================================
# JSON CLEANING
# ============================================================

def _clean_json(text: str) -> str:
    """
    Clean Gemini output and extract the JSON object.
    """
    if not text:
        return ""

    text = text.strip()

    # Remove Markdown code fences.
    text = re.sub(r"^```json\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^```\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    # Extract the first JSON object if Gemini added extra text.
    start = text.find("{")
    end = text.rfind("}")

    if start != -1 and end != -1 and end > start:
        text = text[start:end + 1]

    return text.strip()


# ============================================================
# FALLBACK IMAGE PROMPTS
# ============================================================

def _fallback_prompt(title: str, category: str) -> str:

    prompts = {
        "war": (
            "A tense cinematic international security scene, "
            "realistic military infrastructure and equipment, "
            "dramatic atmospheric sky, subtle smoke and haze, "
            "strong depth, serious geopolitical documentary photography, "
            "realistic materials and lighting, premium editorial photography"
        ),

        "africa": (
            "A powerful cinematic documentary scene in modern Africa, "
            "realistic African city or infrastructure, "
            "dramatic natural lighting, realistic people and environment, "
            "strong depth and scale, premium international documentary photography"
        ),

        "economy": (
            "A cinematic global economic scene showing modern industry, "
            "ports, shipping infrastructure, financial districts and commerce, "
            "dramatic realistic lighting, premium business documentary photography"
        ),

        "countries": (
            "A cinematic international geopolitical landscape showing "
            "distinctive national environments, major infrastructure and "
            "global scale, realistic documentary photography, "
            "dramatic lighting and atmospheric depth"
        ),

        "cities": (
            "A dramatic cinematic cityscape with recognizable modern "
            "architecture, roads, infrastructure and urban activity, "
            "realistic documentary photography, atmospheric depth, "
            "professional editorial lighting"
        ),

        "technology": (
            "A realistic futuristic technology facility with advanced "
            "computing infrastructure, robotics, data centers and modern "
            "engineering equipment, cinematic documentary photography, "
            "realistic materials and professional lighting"
        ),

        "disaster": (
            "A dramatic realistic disaster-response documentary scene, "
            "damaged infrastructure and emergency conditions, "
            "professional responders, atmospheric weather, "
            "cinematic lighting and realistic scale"
        ),

        "people": (
            "A powerful realistic documentary portrait scene with "
            "natural human expressions, cinematic lighting, "
            "realistic skin and anatomy, environmental context, "
            "premium editorial photography"
        ),

        "other": (
            "A powerful cinematic international documentary scene "
            "related directly to the story, realistic photography, "
            "strong visual hierarchy, dramatic lighting, "
            "professional editorial composition"
        ),
    }

    base = prompts.get(category, prompts["other"])

    return (
        f"{base}. "
        f"The story concerns: {title}. "
        "Photorealistic, cinematic documentary photography, "
        "high dynamic range, realistic materials, natural colors, "
        "strong subject separation, professional composition. "
        "No text, no words, no letters, no numbers, no logos, "
        "no watermarks, no captions, no labels, no typography."
    )


# ============================================================
# GEMINI TITLE ANALYSIS
# ============================================================

def analyze_title_with_gemini(title: str):

    if not GEMINI_API_KEY:
        print("[thumbnail] GEMINI_API_KEY not available")
        return None

    if requests is None:
        print("[thumbnail] requests package not available")
        return None

    safe_title = title.replace('"', "'")

    prompt = ANALYZE_PROMPT_TMPL.format(title=safe_title)

    for model in GEMINI_MODELS:

        url = (
            "https://generativelanguage.googleapis.com/"
            f"v1beta/models/{model}:generateContent"
        )

        headers = {
            "x-goog-api-key": GEMINI_API_KEY,
            "Content-Type": "application/json",
        }

        payload = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": prompt
                        }
                    ]
                }
            ]
        }

        try:

            print(
                f"[thumbnail] asking Gemini for visual direction: {model}"
            )

            response = requests.post(
                url,
                headers=headers,
                json=payload,
                timeout=60,
            )

            if response.status_code != 200:
                print(
                    f"[thumbnail] Gemini {model} returned "
                    f"{response.status_code}: {response.text[:500]}"
                )
                continue

            data = response.json()

            candidates = data.get("candidates", [])

            if not candidates:
                print(
                    f"[thumbnail] Gemini {model} returned no candidates"
                )
                continue

            parts = (
                candidates[0]
                .get("content", {})
                .get("parts", [])
            )

            raw = ""

            for part in parts:
                if isinstance(part, dict) and part.get("text"):
                    raw += part["text"]

            if not raw:
                print(
                    f"[thumbnail] Gemini {model} returned empty text"
                )
                continue

            cleaned = _clean_json(raw)

            result = json.loads(cleaned)

            if not isinstance(result, dict):
                raise ValueError("Gemini response was not a JSON object")

            category = str(
                result.get("category", "other")
            ).lower().strip()

            valid_categories = {
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

            if category not in valid_categories:
                category = "other"

            category_label = str(
                result.get(
                    "category_label",
                    "WORLD",
                )
            ).strip().upper()

            image_prompt = str(
                result.get("image_prompt", "")
            ).strip()

            if not image_prompt:
                image_prompt = _fallback_prompt(
                    title,
                    category,
                )

            # Force the no-text rule.
            image_prompt += (
                "\n\nSTRICT NEGATIVE REQUIREMENT: "
                "No text, no words, no letters, no numbers, "
                "no logos, no watermarks, no captions, "
                "no labels, no typography, no readable signs."
            )

            words = result.get("words", [])

            cleaned_words = []

            if isinstance(words, list):

                for word in words[:6]:

                    if not isinstance(word, dict):
                        continue

                    text = str(
                        word.get("text", "")
                    ).strip()

                    color = str(
                        word.get("color", "white")
                    ).lower().strip()

                    if not text:
                        continue

                    if color not in COLORS:
                        color = "white"

                    cleaned_words.append(
                        {
                            "text": text,
                            "color": color,
                        }
                    )

            if not cleaned_words:
                fallback = analyze_title_fallback(title)

                cleaned_words = fallback["words"]

                if category == "other":
                    category = fallback["category"]

                if category_label == "WORLD":
                    category_label = fallback["category_label"]

            result = {
                "image_prompt": image_prompt,
                "category": category,
                "category_label": category_label,
                "words": cleaned_words[:6],
            }

            print(
                "[thumbnail] Gemini direction received: "
                f"{result['category']} / "
                f"{result['category_label']}"
            )

            return result

        except Exception as exc:

            print(
                f"[thumbnail] Gemini {model} failed: {exc}"
            )

    print(
        "[thumbnail] all Gemini models failed; "
        "using local fallback"
    )

    return None


# ============================================================
# LOCAL TITLE ANALYSIS FALLBACK
# ============================================================

def analyze_title_fallback(title: str):

    lower = title.lower()

    if any(
        word in lower
        for word in [
            "war",
            "warfare",
            "military",
            "weapon",
            "weapons",
            "conflict",
            "attack",
            "army",
            "missile",
            "nuclear",
            "invasion",
            "battle",
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
            "ethiopia",
            "ghana",
            "tanzania",
            "uganda",
            "south africa",
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
            "markets",
            "business",
            "trade",
            "finance",
            "financial",
            "dollar",
            "currency",
            "investment",
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
            "top ",
            "best ",
            "worst ",
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
            "town",
        ]
    ):
        category = "cities"

    elif any(
        word in lower
        for word in [
            "technology",
            "tech",
            "ai",
            "artificial intelligence",
            "robot",
            "robots",
            "computer",
            "chip",
            "chips",
            "data center",
            "satellite",
        ]
    ):
        category = "technology"

    elif any(
        word in lower
        for word in [
            "disaster",
            "earthquake",
            "flood",
            "flooding",
            "fire",
            "storm",
            "hurricane",
            "collapse",
            "crisis",
        ]
    ):
        category = "disaster"

    elif any(
        word in lower
        for word in [
            "people",
            "person",
            "leader",
            "president",
            "population",
            "women",
            "men",
        ]
    ):
        category = "people"

    else:
        category = "other"

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

    category_label = labels.get(
        category,
        "WORLD",
    )

    dramatic_words = {
        "war",
        "attack",
        "danger",
        "crisis",
        "collapse",
        "threat",
        "conflict",
        "weapon",
        "weapons",
        "nuclear",
        "warning",
        "risk",
        "dead",
        "death",
        "disaster",
        "explosion",
        "invasion",
        "battle",
        "fall",
        "falls",
        "fighting",
    }

    positive_words = {
        "growth",
        "rise",
        "rising",
        "success",
        "successfully",
        "opportunity",
        "future",
        "power",
        "strong",
        "strongest",
        "rich",
        "wealth",
        "development",
    }

    number_pattern = re.compile(
        r"\d+(?:\.\d+)?%?"
    )

    words = []

    for raw_word in title.split():

        clean = raw_word.strip(
            ".,!?;:()[]{}\"'"
        )

        if not clean:
            continue

        lower_word = clean.lower()

        if number_pattern.fullmatch(clean):
            color = "yellow"

        elif lower_word in dramatic_words:
            color = "red"

        elif lower_word in positive_words:
            color = "green"

        else:
            color = "white"

        words.append(
            {
                "text": clean,
                "color": color,
            }
        )

    # Keep the strongest first words if title is long.
    words = words[:6]

    # If no words exist, use a fallback.
    if not words:
        words = [
            {
                "text": "THE",
                "color": "white",
            },
            {
                "text": "WORLD",
                "color": "yellow",
            },
            {
                "text": "CHANGES",
                "color": "red",
            },
        ]

    return {
        "image_prompt": _fallback_prompt(
            title,
            category,
        ),
        "category": category,
        "category_label": category_label,
        "words": words,
    }


# ============================================================
# COMBINED TITLE ANALYSIS
# ============================================================

def analyze_title(title: str):

    result = analyze_title_with_gemini(title)

    if result:
        return result

    return analyze_title_fallback(title)


# ============================================================
# FLUX BACKGROUND GENERATION
# ============================================================

def generate_background(prompt: str, seed=None):

    if InferenceClient is None:
        raise RuntimeError(
            "huggingface_hub is not installed"
        )

    if not HF_TOKEN:
        raise RuntimeError(
            "HF_TOKEN is not configured"
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
            "[thumbnail] FLUX request with dimensions failed: "
            f"{first_error}"
        )

        # Retry with only the required parameters.
        image = client.text_to_image(
            prompt=prompt,
            model=FLUX_MODEL,
            seed=seed,
        )

    if not isinstance(image, Image.Image):
        raise RuntimeError(
            "FLUX did not return a PIL image"
        )

    return image


# ============================================================
# IMAGE PROCESSING
# ============================================================

def crop_to_cover(
    image: Image.Image,
    width: int,
    height: int,
) -> Image.Image:

    image = image.convert("RGB")

    src_w, src_h = image.size

    src_ratio = src_w / src_h
    target_ratio = width / height

    if src_ratio > target_ratio:

        new_w = int(src_h * target_ratio)

        left = (src_w - new_w) // 2

        image = image.crop(
            (
                left,
                0,
                left + new_w,
                src_h,
            )
        )

    else:

        new_h = int(src_w / target_ratio)

        top = (src_h - new_h) // 2

        image = image.crop(
            (
                0,
                top,
                src_w,
                top + new_h,
            )
        )

    return image.resize(
        (width, height),
        Image.Resampling.LANCZOS,
    )


def cinematic_grade(
    image: Image.Image,
) -> Image.Image:

    image = ImageEnhance.Contrast(
        image
    ).enhance(1.16)

    image = ImageEnhance.Color(
        image
    ).enhance(1.08)

    image = ImageEnhance.Sharpness(
        image
    ).enhance(1.15)

    return image


def add_vignette(
    image: Image.Image,
    strength: float = 0.28,
) -> Image.Image:

    image = image.convert("RGB")

    width, height = image.size

    overlay = Image.new(
        "RGBA",
        (width, height),
        (0, 0, 0, 0),
    )

    pixels = overlay.load()

    center_x = width / 2
    center_y = height / 2

    max_distance = math.sqrt(
        center_x ** 2 +
        center_y ** 2
    )

    for y in range(height):

        for x in range(width):

            dx = x - center_x
            dy = y - center_y

            distance = math.sqrt(
                dx * dx +
                dy * dy
            )

            normalized = min(
                1.0,
                distance / max_distance,
            )

            alpha = int(
                255 *
                strength *
                (normalized ** 1.8)
            )

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


def darken_headline_area(
    image: Image.Image,
    side: str,
) -> Image.Image:

    image = image.convert("RGB")

    width, height = image.size

    overlay = Image.new(
        "RGBA",
        (width, height),
        (0, 0, 0, 0),
    )

    pixels = overlay.load()

    for y in range(height):

        for x in range(width):

            if side == "left":
                distance = x / max(
                    1,
                    width * 0.58,
                )
            else:
                distance = (
                    width - x
                ) / max(
                    1,
                    width * 0.58,
                )

            distance = max(
                0.0,
                min(
                    1.0,
                    distance,
                ),
            )

            alpha = int(
                155 *
                (1.0 - distance) ** 1.6
            )

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

    try:

        if FONT_PATH.exists():
            return ImageFont.truetype(
                str(FONT_PATH),
                size=size,
            )

    except Exception:
        pass

    # Fallback to common DejaVu font.
    fallback_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    ]

    for path in fallback_paths:

        if os.path.exists(path):

            try:
                return ImageFont.truetype(
                    path,
                    size=size,
                )
            except Exception:
                pass

    return ImageFont.load_default()


def text_bbox(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
    stroke_width: int = 0,
):

    return draw.textbbox(
        (0, 0),
        text,
        font=font,
        stroke_width=stroke_width,
    )


def text_size(
    draw: ImageDraw.ImageDraw,
    text: str,
    font,
    stroke_width: int = 0,
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
# HEADLINE WRAPPING
# ============================================================

def wrap_headline_words(
    words,
    max_chars=18,
):

    lines = []

    current = []
    current_length = 0

    for word in words:

        text = word["text"]

        extra = (
            len(text)
            if not current
            else len(text) + 1
        )

        if (
            current
            and current_length + extra > max_chars
        ):

            lines.append(current)

            current = [word]

            current_length = len(text)

        else:

            current.append(word)

            current_length += extra

    if current:
        lines.append(current)

    return lines


# ============================================================
# FIT HEADLINE
# ============================================================

def fit_headline(
    draw,
    words,
    max_width,
    max_height,
):

    lines = wrap_headline_words(words)

    for size in range(118, 41, -2):

        font = load_font(size)

        line_sizes = []

        total_height = 0
        largest_width = 0

        for line in lines:

            text = " ".join(
                word["text"]
                for word in line
            )

            width, height = text_size(
                draw,
                text,
                font,
                stroke_width=4,
            )

            line_sizes.append(
                (width, height)
            )

            largest_width = max(
                largest_width,
                width,
            )

            total_height += height

        total_height += max(
            0,
            len(lines) - 1,
        ) * 10

        if (
            largest_width <= max_width
            and total_height <= max_height
        ):

            return (
                lines,
                font,
                total_height,
            )

    font = load_font(42)

    total_height = 0

    for line in lines:

        text = " ".join(
            word["text"]
            for word in line
        )

        _, height = text_size(
            draw,
            text,
            font,
            stroke_width=4,
        )

        total_height += height

    return (
        lines,
        font,
        total_height,
    )


# ============================================================
# DRAW HEADLINE
# ============================================================

def draw_headline(
    image: Image.Image,
    words,
    side="left",
):

    draw = ImageDraw.Draw(image)

    max_width = int(
        OUT_WIDTH * 0.45
    )

    max_height = int(
        OUT_HEIGHT * 0.70
    )

    lines, font, total_height = fit_headline(
        draw,
        words,
        max_width,
        max_height,
    )

    x_padding = int(
        OUT_WIDTH * 0.055
    )

    if side == "left":
        x = x_padding
    else:
        x = OUT_WIDTH - x_padding - max_width

    y = int(
        (OUT_HEIGHT - total_height) / 2
    )

    stroke_width = max(
        3,
        int(font.size * 0.035),
    )

    line_gap = 10

    for line in lines:

        total_line_width = 0

        for word in line:

            width, _ = text_size(
                draw,
                word["text"],
                font,
                stroke_width=stroke_width,
            )

            total_line_width += width

        total_line_width += (
            max(
                0,
                len(line) - 1,
            )
            * 10
        )

        current_x = x

        if side == "right":

            current_x = (
                OUT_WIDTH
                - x_padding
                - total_line_width
            )

        for word in line:

            text = word["text"]

            color = COLORS.get(
                word.get(
                    "color",
                    "white",
                ),
                COLORS["white"],
            )

            draw.text(
                (
                    current_x,
                    y,
                ),
                text,
                font=font,
                fill=color,
                stroke_width=stroke_width,
                stroke_fill=OUTLINE_COLOR,
            )

            width, _ = text_size(
                draw,
                text,
                font,
                stroke_width=stroke_width,
            )

            current_x += width + 10

        y += (
            font.size +
            line_gap
        )


# ============================================================
# CATEGORY LABEL
# ============================================================

def draw_category_label(
    image: Image.Image,
    label: str,
):

    draw = ImageDraw.Draw(image)

    font = load_font(27)

    padding_x = 18
    padding_y = 9

    text_width, text_height = text_size(
        draw,
        label,
        font,
    )

    x = 30
    y = 26

    box = (
        x,
        y,
        x +
        text_width +
        padding_x * 2,
        y +
        text_height +
        padding_y * 2,
    )

    radius = 8

    draw.rounded_rectangle(
        box,
        radius=radius,
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


# ============================================================
# LOGO
# ============================================================

def draw_logo(
    image: Image.Image,
):

    if not LOGO_PATH.exists():
        print(
            f"[thumbnail] logo not found: {LOGO_PATH}"
        )
        return

    try:

        logo = Image.open(
            LOGO_PATH
        ).convert("RGBA")

        max_width = int(
            OUT_WIDTH * 0.18
        )

        max_height = int(
            OUT_HEIGHT * 0.12
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
            OUT_WIDTH
            - logo.width
            - margin
        )

        y = (
            OUT_HEIGHT
            - logo.height
            - margin
        )

        image.paste(
            logo,
            (
                x,
                y,
            ),
            logo,
        )

    except Exception as exc:

        print(
            f"[thumbnail] logo rendering failed: {exc}"
        )


# ============================================================
# LAYOUT
# ============================================================

def choose_layout(
    index: int,
):

    # Alternate the headline side.
    layouts = [
        "left",
        "right",
        "left",
    ]

    return layouts[
        index % len(layouts)
    ]


# ============================================================
# COMPOSE FINAL THUMBNAIL
# ============================================================

def compose_thumbnail(
    background: Image.Image,
    analysis: dict,
    variation_index: int,
):

    image = crop_to_cover(
        background,
        OUT_WIDTH,
        OUT_HEIGHT,
    )

    image = cinematic_grade(
        image
    )

    side = choose_layout(
        variation_index
    )

    image = darken_headline_area(
        image,
        side,
    )

    image = add_vignette(
        image,
        strength=0.28,
    )

    draw_category_label(
        image,
        analysis.get(
            "category_label",
            "WORLD",
        ),
    )

    words = analysis.get(
        "words",
        [],
    )

    if words:

        draw_headline(
            image,
            words,
            side=side,
        )

    draw_logo(
        image
    )

    return image


# ============================================================
# MAIN
# ============================================================

def main():

    parser = argparse.ArgumentParser(
        description=(
            "Generate NEXT SCENE TV "
            "premium thumbnails"
        )
    )

    parser.add_argument(
        "--title",
        required=True,
        help="Video title",
    )

    parser.add_argument(
        "--variations",
        type=int,
        default=1,
        help="Number of thumbnail variations",
    )

    parser.add_argument(
        "--out-dir",
        default="thumbnail-output",
        help="Output directory",
    )

    parser.add_argument(
        "--style",
        default="",
        help="Optional additional visual style hint",
    )

    args = parser.parse_args()

    title = args.title.strip()

    if not title:
        raise SystemExit(
            "Title cannot be empty."
        )

    variations = max(
        1,
        min(
            args.variations,
            10,
        ),
    )

    out_dir = Path(
        args.out_dir
    )

    out_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    print(
        "[thumbnail] ======================================="
    )

    print(
        "[thumbnail] NEXT SCENE TV Thumbnail Generator"
    )

    print(
        "[thumbnail] ======================================="
    )

    print(
        f"[thumbnail] title: {title}"
    )

    if args.style:
        print(
            f"[thumbnail] extra style: {args.style}"
        )

    # --------------------------------------------------------
    # GEMINI
    # --------------------------------------------------------

    analysis = analyze_title(
        title
    )

    # Add optional style hint.
    if args.style:

        analysis["image_prompt"] += (
            "\n\nAdditional visual direction: "
            f"{args.style}"
        )

    # Force no-text rule again.
    analysis["image_prompt"] += (
        "\n\nABSOLUTE RULE: "
        "The generated image itself must contain "
        "NO TEXT, NO WORDS, NO LETTERS, NO NUMBERS, "
        "NO LOGOS, NO WATERMARKS, NO CAPTIONS, "
        "NO LABELS and NO TYPOGRAPHY."
    )

    print(
        "[thumbnail] category: "
        f"{analysis.get('category', 'other')}"
    )

    print(
        "[thumbnail] label: "
        f"{analysis.get('category_label', 'WORLD')}"
    )

    print(
        "[thumbnail] headline: "
        + " ".join(
            word["text"]
            for word in analysis.get(
                "words",
                [],
            )
        )
    )

    # --------------------------------------------------------
    # GENERATE VARIATIONS
    # --------------------------------------------------------

    for index in range(variations):

        print(
            f"[thumbnail] generating variation "
            f"{index + 1}/{variations}"
        )

        # Different seed for every variation.
        seed = (
            int(time.time() * 1000)
            + index
            + random.randint(
                0,
                999999,
            )
        )

        try:

            background = generate_background(
                analysis["image_prompt"],
                seed=seed,
            )

            final_image = compose_thumbnail(
                background,
                analysis,
                index,
            )

            output_path = (
                out_dir /
                f"thumbnail_{index + 1:02d}.jpg"
            )

            final_image.save(
                output_path,
                "JPEG",
                quality=95,
                optimize=True,
                progressive=True,
            )

            print(
                "[thumbnail] saved: "
                f"{output_path}"
            )

        except Exception as exc:

            print(
                "[thumbnail] variation "
                f"{index + 1} failed: {exc}"
            )

            traceback.print_exc()

    print(
        "[thumbnail] ======================================="
    )

    print(
        "[thumbnail] generation complete"
    )

    print(
        "[thumbnail] ======================================="
    )


# ============================================================
# ENTRY POINT
# ============================================================

if __name__ == "__main__":
    main()
