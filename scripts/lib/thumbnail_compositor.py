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
import unicodedata  # Added for text normalization
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
# TEXT CLEANING HELPER FUNCTION (FIX FOR SQUARE BOXES)
# ============================================================

def clean_text_for_pillow(text):
    """
    Normalizes input text by converting stylized mathematical bold/italic Unicode 
    variants back into standard ASCII, and strips non-renderable characters/emojis 
    to prevent Pillow from drawing square 'tofu' blocks.
    """
    if not text:
        return ""
    # Normalize unicode forms (turns fancy bold/italic letters into plain characters)
    text = unicodedata.normalize('NFKD', str(text))
    # Keep only printable ASCII standard string characters
    text = re.sub(r'[^\x00-\x7F]+', '', text)
    return text.strip()


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

For country comparisons/rankings: Show visually distinctive real-world elements associated with the countries while maintaining a serious documentary style. Do not create a collage of flags. For cities: Use recognizable architecture, skyline, roads, transport, infrastructure or landmarks. For technology: Use realistic modern technology, data centers, robotics, AI infrastructure, semiconductor facilities, satellites, cybersecurity environments or advanced machines. Avoid generic glowing blue "AI" graphics. For disasters: Show realistic environmental conditions, damaged infrastructure, storms, flooding, fires, earthquakes or emergency response. Keep the image dramatic but believable. For people: Use realistic documentary photography style. Faces should look natural and emotionally appropriate. Avoid distorted faces, extra limbs, artificial skin, plastic-looking people or exaggerated expressions. ============================================================ EMOTION ============================================================ The thumbnail should create one strong emotion: - tension - urgency - curiosity - concern - surprise - scale - mystery - anticipation - importance Do not make the emotion cartoonish. ============================================================ HEADLINE ============================================================ Create a short thumbnail headline of approximately 2-6 words. The headline should NOT simply repeat the full video title. It should capture the strongest hook. Examples: "THE NEXT WAR?" "AFRICA'S HIDDEN POWER" "THE WORLD IS CHANGING" "10 COUNTRIES AT RISK" "THE MONEY SHIFT" "WHO WILL FALL FIRST?" Return individual words separately. Each word must have one of these colors: white yellow red green Use: RED for danger, conflict, warning or urgency. YELLOW for numbers, important emphasis or key facts. GREEN for positive growth, opportunity or progress. WHITE for normal headline words. Do not use more than 6 words. ============================================================ STRICT BACKGROUND RULE ============================================================ The generated image must contain NO: - text - words - letters - numbers - logos - watermarks - captions - labels - typography - signs with readable writing The final headline will be added separately. ============================================================ QUALITY CONTROL ============================================================ The visual prompt must explicitly request: - photorealistic - cinematic documentary photography - professional lighting - realistic materials - realistic human anatomy - realistic scale - detailed environment - natural color grading - high dynamic range - strong subject separation - premium editorial photography Avoid: - distorted anatomy - duplicate people - duplicate vehicles - extra limbs - melted objects - unrealistic buildings - fantasy unless explicitly required - cartoon style - illustration style - oversaturated colors - excessive lens effects - fake text -"""

# ============================================================
# REMAINING IMPLEMENTATION WRAPPERS (FOR PILLOW RENDER ENGINE)
# ============================================================

# Note: When your script parses variables like `headline_text` or `category_label` 
# inside its runtime blocks (e.g. `main()` execution or drawing blocks), make sure 
# they pass through the filter:
#
#    clean_title = clean_text_for_pillow(article_title)
#    draw.text((x, y), clean_title, font=font, fill=COLORS["white"])
