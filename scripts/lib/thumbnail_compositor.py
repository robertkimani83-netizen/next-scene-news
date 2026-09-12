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

* text
* words
* letters
* numbers
* logos
* watermarks
* captions
* typography
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

HERE = Path(**file**).resolve().parent
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
You are the CHIEF VISUAL DIRECTOR and senior YouTube thumbnail strategist for
NEXT SCENE TV, a premium international documentary and world-news channel.

Your job is NOT simply to describe an image.

Your job is to think like a professional editorial photographer, film director,
news designer and high-performing YouTube thumbnail strategist working together.

VIDEO TITLE:
"{title}"

============================================================
PRIMARY OBJECTIVE
=================

Create ONE exceptionally strong visual concept that can become a premium,
cinematic, highly clickable YouTube documentary thumbnail.

The thumbnail must immediately communicate the STORY and create curiosity
within approximately one second on a mobile phone.

The result must look expensive, realistic and editorial.

It must NOT look like:

* generic AI art
* cheap clickbait
* a stock-photo collage
* a video game
* a movie poster
* a random collection of objects
* an infographic
* a children's illustration
* an over-designed social media graphic

Think:

BBC documentary + Netflix documentary + Reuters/AP photography +
premium investigative YouTube journalism.

============================================================
VISUAL STORYTELLING
===================

First determine:

1. What is the most important subject in the story?
2. What single visual would communicate that subject immediately?
3. What emotion should the viewer feel?
4. What visual creates curiosity without misleading the viewer?
5. What should dominate the foreground?
6. What should remain secondary in the background?
7. Where should the headline be placed?

DO NOT attempt to visually represent every word in the title.

ONE STRONG IDEA IS BETTER THAN TEN WEAK IDEAS.

============================================================
SUBJECT SELECTION
=================

Choose the strongest possible visual subject based on the actual story.

Possible dominant subjects include:

* a realistic human face
* political leader
* soldier
* military vehicle
* aircraft
* missile system
* warship
* city
* skyline
* factory
* energy facility
* port
* satellite
* computer system
* robot
* landscape
* damaged infrastructure
* crowd
* border
* strategic location
* other story-specific subject

Only use people when they genuinely strengthen the story.

Only use military equipment when it genuinely relates to the story.

Do NOT add random dramatic objects simply to make the image exciting.

============================================================
COMPOSITION
===========

Design the image like a professional photograph.

Use:

* strong foreground
* clear middle ground
* atmospheric background
* realistic depth
* deliberate perspective
* strong subject separation
* cinematic framing
* natural scale
* visual hierarchy

Prefer ONE dominant hero subject.

A secondary supporting element may be used when it helps explain the story.

Never create a cluttered collage.

Avoid putting ten different countries, flags, leaders or objects into one image.

If multiple subjects are absolutely necessary, keep one clearly dominant.

============================================================
THUMBNAIL LAYOUT
================

The final image is 16:9.

Plan the composition specifically for a YouTube thumbnail.

Place the main subject approximately on the left or right third.

Reserve approximately 35–45% of the opposite side for the headline.

The headline area should have:

* darker tones
* simpler visual information
* enough contrast
* no important face
* no important object
* no critical story information

The headline must NEVER cover the main subject's face or the most important object.

Think about the image after it is reduced to approximately 15% of its original size.

It must still be understandable.

============================================================
CAMERA AND CINEMATIC PHOTOGRAPHY
================================

Describe the camera perspective when useful.

Possible approaches:

* low-angle cinematic perspective
* medium telephoto documentary shot
* wide establishing shot
* close portrait
* aerial perspective
* long-lens compressed background
* dramatic foreground perspective

Use realistic photographic characteristics:

* natural depth of field
* realistic lens perspective
* believable shadows
* physically plausible lighting
* realistic skin
* realistic materials
* realistic atmospheric haze
* subtle filmic contrast

Do NOT make everything excessively sharp.

Do NOT make everything glow.

Do NOT make everything blue.

Do NOT use excessive HDR.

============================================================
LIGHTING
========

Use sophisticated cinematic lighting appropriate to the story.

Possible lighting:

* dramatic sunset
* cold overcast daylight
* warm directional sunlight
* storm lighting
* controlled newsroom-like contrast
* dusk
* dawn
* realistic city lights
* atmospheric backlight

Use light to guide the viewer's eye toward the hero subject.

Create separation between foreground and background.

Avoid artificial neon lighting unless the story specifically concerns technology
or a futuristic environment.

============================================================
COLOR DIRECTION
===============

Use a restrained cinematic palette.

Choose colors appropriate to the story.

Possible palettes:

* charcoal + steel + muted red
* dark blue + warm skin tones
* black + amber
* cool gray + red accents
* natural earth tones
* deep green + gold
* dark navy + white

Avoid oversaturated rainbow colors.

Avoid excessive red everywhere.

Avoid artificial glowing backgrounds.

============================================================
GEOPOLITICS / WAR / CONFLICT
============================

For geopolitical stories, prioritize realism and strategic tension.

Possible visual elements:

* military formations
* realistic soldiers
* aircraft
* warships
* missile defense systems
* military vehicles
* strategic infrastructure
* political buildings
* tense borders
* satellite-style geography when genuinely useful
* leaders only when the story specifically concerns them

Create tension through:

* scale
* distance
* posture
* atmosphere
* lighting
* composition

Do NOT automatically create explosions.

Do NOT automatically create fire.

Do NOT make it look like a battlefield video game.

Do NOT cover the image with flags.

============================================================
AFRICA
======

When the story concerns Africa, use authentic and modern visual storytelling.

Possible subjects:

* modern African cities
* infrastructure
* ports
* roads
* railways
* technology
* industry
* energy
* landscapes
* wildlife
* people
* business districts

Avoid stereotypical poverty imagery unless poverty is actually the story.

Make African environments look authentic, modern and cinematic.

============================================================
ECONOMY / BUSINESS
==================

Use visual storytelling through:

* financial districts
* ports
* factories
* energy infrastructure
* logistics
* technology
* markets
* transportation
* business leaders
* industrial scale

Avoid literal floating money unless directly relevant.

============================================================
COUNTRIES / RANKINGS
====================

If the title concerns countries or rankings:

DO NOT create a collage of many flags.

Instead identify the strongest visual representation of the subject.

Use:

* recognizable landscape
* skyline
* landmark
* infrastructure
* geography
* distinctive environment
* strategic location

One strong recognizable visual is preferred over many small symbols.

============================================================
CITIES
======

Use recognizable urban environments.

Prioritize:

* skyline
* landmark
* streets
* transportation
* architecture
* atmosphere
* recognizable geography

Make the city feel alive and photographic.

============================================================
TECHNOLOGY
==========

Use realistic technology.

Possible subjects:

* AI hardware
* data centers
* semiconductor factories
* robots
* satellites
* advanced vehicles
* computers
* scientific equipment
* futuristic but believable infrastructure

Avoid the generic blue glowing "AI brain" image.

Avoid excessive holograms.

============================================================
DISASTERS
=========

Show realistic consequences.

Use:

* flooding
* damaged infrastructure
* wildfire
* storm
* earthquake damage
* drought
* volcanic activity

Show scale and human/environmental consequences where appropriate.

Avoid unrealistic Hollywood destruction.

============================================================
PEOPLE AND FACES
================

When a person is the dominant subject:

Create a realistic photographic human.

Prioritize:

* natural facial anatomy
* realistic eyes
* realistic skin
* natural expression
* believable clothing
* believable lighting

The face must communicate the story emotion.

Avoid distorted faces.

Avoid excessive beauty retouching.

Avoid exaggerated expressions.

============================================================
EMOTION
=======

Choose ONE dominant emotional response:

* tension
* urgency
* curiosity
* concern
* surprise
* anticipation
* awe
* hope

Do not mix too many emotional signals.

============================================================
HEADLINE STRATEGY
=================

The thumbnail headline must NOT repeat the full video title.

Create a short headline of approximately 2–6 words.

The headline should be:

* powerful
* easy to read
* emotionally interesting
* directly connected to the story
* understandable without the YouTube title

Prefer strong phrases rather than complete sentences.

Examples of style:

QUIETLY ARMING
THE NEXT CONFLICT
A NEW POWER
AFRICA'S BIG SHIFT
THE HIDDEN THREAT
THE WORLD IS CHANGING

Do NOT use clickbait that contradicts the story.

Use capitalization appropriate for a bold documentary thumbnail.

The headline will be added separately using Pillow.

============================================================
TEXT PROHIBITION
================

ABSOLUTELY DO NOT PLACE ANY TEXT IN THE GENERATED IMAGE.

Do not generate:

* words
* letters
* numbers
* captions
* headlines
* signs
* logos
* watermarks
* labels
* typography
* readable writing

If the scene naturally contains signs, screens or documents, make them
unreadable or positioned so that no text is visible.

The generated image must be a CLEAN CINEMATIC PHOTOGRAPH.

============================================================
NEGATIVE PROMPT / QUALITY CONTROL
=================================

The visual prompt must explicitly discourage:

* generic stock photography
* generic AI art
* illustration
* cartoon
* anime
* video game graphics
* excessive HDR
* excessive saturation
* plastic skin
* distorted faces
* extra limbs
* duplicated people
* impossible anatomy
* random objects
* clutter
* collage composition
* excessive explosions
* fake text
* logos
* watermarks
* captions
* typography
* floating symbols
* unnecessary flags
* cheesy visual effects

============================================================
FINAL IMAGE PROMPT
==================

Write a highly detailed English image prompt describing ONLY the visual scene.

The prompt should specify:

* dominant subject
* environment
* camera perspective
* composition
* foreground
* background
* lighting
* atmosphere
* color palette
* depth
* realistic photographic style
* headline negative space
* documentary realism

The prompt should be detailed enough that a professional image model can
produce a strong result without guessing.

============================================================
OUTPUT
======

Return ONLY valid JSON.

Use exactly this structure:

{{
"image_prompt": "Detailed English prompt describing ONLY the cinematic photographic scene.",
"category": "one of: war, africa, economy, countries, cities, technology, disaster, people, other",
"category_label": "short 1-3 word ALL CAPS label",
"words": [
{{"text": "WORD", "color": "white"}}
]
}}

For "words", use only:

* white
* yellow
* red
* green

Use color intentionally.

Do not use more than 6 headline words.

Do not include markdown.

Do not include ```json.

Do not explain your answer.

Return ONLY the JSON.
"""

# ============================================================

# GENERAL HELPERS

# ============================================================

def _clean_json(text: str) -> str:
if not text:
return ""

````
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
````

def _fallback_prompt(title: str, category: str) -> str:

```
prompts = {
    "war": (
        "A premium cinematic documentary photograph directly connected "
        "to the story, showing one dominant realistic geopolitical or "
        "military subject in a believable environment, dramatic but "
        "natural lighting, strong foreground and atmospheric background, "
        "realistic depth, sophisticated color grading, editorial news "
        "photography, with clean darker negative space on the opposite "
        "side for a large headline"
    ),

    "africa": (
        "A premium documentary photograph connected to the African "
        "story, showing one dominant authentic modern African subject, "
        "city, infrastructure, landscape, industry or people relevant "
        "to the story, cinematic natural lighting, realistic depth, "
        "editorial photography, sophisticated color grading and clean "
        "darker negative space for headline text"
    ),

    "economy": (
        "A premium cinematic documentary photograph representing the "
        "economic story through one dominant realistic subject such as "
        "modern infrastructure, industry, energy, transportation, "
        "business district or financial environment, sophisticated "
        "lighting, realistic photography, strong depth and clean "
        "negative space for headline text"
    ),

    "countries": (
        "A premium cinematic documentary photograph representing the "
        "country or countries in the story through one strong recognizable "
        "visual such as landscape, skyline, infrastructure, landmark or "
        "strategic environment, realistic photography, dramatic natural "
        "lighting, strong depth and clean darker negative space for "
        "headline text"
    ),

    "cities": (
        "A premium cinematic documentary photograph of a recognizable "
        "city environment connected to the story, one dominant landmark "
        "or urban subject, realistic architecture, natural people and "
        "vehicles where useful, dramatic cinematic lighting, realistic "
        "photography and clean negative space for headline text"
    ),

    "technology": (
        "A premium cinematic documentary photograph showing one dominant "
        "realistic advanced technology subject connected to the story, "
        "such as AI hardware, robotics, data centers, chips, satellites "
        "or advanced infrastructure, sophisticated realistic lighting, "
        "deep perspective and clean negative space for headline text"
    ),

    "disaster": (
        "A realistic premium cinematic documentary photograph showing "
        "one dominant environmental or infrastructure consequence of the "
        "story, realistic scale, dramatic natural lighting, authentic "
        "materials, atmospheric depth and clean darker negative space "
        "for headline text"
    ),

    "people": (
        "A premium cinematic documentary photograph focused on one "
        "realistic human subject relevant to the story, natural expression, "
        "authentic environment, sophisticated cinematic lighting, realistic "
        "skin and anatomy, strong depth and clean negative space for "
        "headline text"
    ),

    "other": (
        "A premium cinematic documentary photograph directly connected "
        "to the story, one dominant realistic subject, strong visual "
        "storytelling, dramatic but natural lighting, realistic depth, "
        "editorial news photography and clean darker negative space for "
        "headline text"
    ),
}

base = prompts.get(category, prompts["other"])

return (
    f"{base}. The story concerns: {title}. "
    "No text, no words, no letters, no numbers, no logos, "
    "no watermarks, no captions, no labels, no typography."
)
```

# ============================================================

# GEMINI TITLE ANALYSIS

# ============================================================

def analyze_title_with_gemini(title: str):

```
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

        cleaned_words = cleaned_words[:6]

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
            "NO LOGOS, NO WATERMARKS, NO CAPTIONS, "
            "NO LABELS, NO TYPOGRAPHY."
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
```

# ============================================================

# RULE-BASED FALLBACK ANALYSIS

# ============================================================

def analyze_title_fallback(title: str):

```
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
        "arming",
        "armed",
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
    "conflict",
    "arming",
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
    "words": result_words[:6],
}
```

def analyze_title(title: str):

```
print(
    "[thumbnail] analyzing title..."
)

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
```

# ============================================================

# FLUX BACKGROUND GENERATION

# ============================================================

def generate_background(
prompt: str,
seed: int | None = None,
):

```
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

if not isinstance(
    image,
    Image.Image,
):
    raise RuntimeError(
        "FLUX did not return a PIL image"
    )

return image.convert("RGB")
```

# ============================================================

# IMAGE PROCESSING

# ============================================================

def crop_to_cover(
image: Image.Image,
width: int,
height: int,
):

```
image = image.convert("RGB")

source_ratio = (
    image.width / image.height
)

target_ratio = (
    width / height
)

if source_ratio > target_ratio:

    new_height = height

    new_width = int(
        height * source_ratio
    )

else:

    new_width = width

    new_height = int(
        width / source_ratio
    )

image = image.resize(
    (
        new_width,
        new_height,
    ),
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
```

def cinematic_grade(
image: Image.Image,
):

```
image = image.convert("RGB")

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
```

def add_vignette(
image: Image.Image,
strength: float = 0.28,
):

```
width, height = image.size

vignette = Image.new(
    "L",
    (
        width,
        height,
    ),
    255,
)

pixels = vignette.load()

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
            distance / max_radius,
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

        pixels[x, y] = value

return Image.composite(
    image,
    Image.new(
        "RGB",
        image.size,
        (0, 0, 0),
    ),
    vignette,
)
```

def darken_headline_area(
image: Image.Image,
side: str = "left",
):

```
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
        155
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
```

# ============================================================

# FONT HELPERS

# ============================================================

def load_font(size: int):

```
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
```

def text_bbox(
draw,
text,
font,
stroke_width=0,
):

```
return draw.textbbox(
    (0, 0),
    text,
    font=font,
    stroke_width=stroke_width,
)
```

def text_size(
draw,
text,
font,
stroke_width=0,
):

```
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
```

# ============================================================

# HEADLINE LAYOUT

# ============================================================

def wrap_headline_words(
words,
max_chars=16,
):

```
if not words:
    return []

lines = []
current = []

for word in words:

    proposed = (
        current + [word]
    )

    length = len(
        " ".join(
            item["text"]
            for item in proposed
        )
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
```

def fit_headline(
draw,
words,
max_width,
max_height,
):

```
if not words:

    return (
        [],
        load_font(70),
    )

lines = wrap_headline_words(
    words,
    max_chars=18,
)

for size in range(
    118,
    42,
    -2,
):

    font = load_font(
        size
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
            h
            + int(
                size * 0.08
            )
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
```

# ============================================================

# DRAW HEADLINE

# ============================================================

def draw_headline(
image: Image.Image,
words,
side: str = "left",
):

```
draw = ImageDraw.Draw(
    image
)

max_width = int(
    image.width * 0.45
)

max_height = int(
    image.height * 0.70
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
    image.height * 0.18
)

stroke_width = max(
    3,
    font.size // 22,
)

line_gap = int(
    font.size * 0.10
)

for line in lines:

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
        font.size * 0.13
    )

    current_x = x

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
```

# ============================================================

# CATEGORY LABEL

# ============================================================

def draw_category_label(
image: Image.Image,
label: str,
):

```
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
    x + text_w + padding_x * 2,
    y + text_h + padding_y * 2,
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
```

# ============================================================

# LOGO

# ============================================================

def draw_logo(
image: Image.Image,
):

```
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
```

# ============================================================

# COMPOSITION

# ============================================================

def choose_layout(
variation_index: int,
):

```
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
```

def compose_thumbnail(
background: Image.Image,
analysis: dict,
variation_index: int,
):

```
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
```

# ============================================================

# SAVE

# ============================================================

def save_thumbnail(
image: Image.Image,
path: Path,
):

```
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
```

# ============================================================

# MAIN

# ============================================================

def main():

```
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
```

if **name** == "**main**":
main()
