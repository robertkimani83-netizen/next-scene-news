#!/usr/bin/env python3
"""NEXT SCENE TV thumbnail compositor.

Replaces the old Gemini-image-generation thumbnail path with:
  title -> Gemini analyzes it (image prompt + colored keyword breakdown)
        -> FLUX.1-schnell (Hugging Face Inference Providers) paints the
           background -- NO text/logos, ever asked of it
        -> this script burns in the real headline, outlines, glow, number
           emphasis, category tag and the channel's own logo with Pillow

Called by scripts/lib/thumbnail-gen.mjs (one variation, wired into the real
video pipelines) and directly by the standalone
.github/workflows/generate-thumbnail.yml (N variations, on-demand by title).

Environment variables (GitHub Secrets in CI):
  HF_TOKEN        - Hugging Face token with Inference Providers access
  GEMINI_API_KEY  - same key already used for script generation (script-gen.mjs)

Never logs either token. On total failure for one variation, prints a clear
error to stderr and continues with the remaining variations rather than
producing a corrupt/partial image.
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

from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

try:
    import requests
except ImportError:
    print("[thumbnail] fatal: the 'requests' package is not installed (pip install requests)", file=sys.stderr)
    raise

try:
    from huggingface_hub import InferenceClient
except ImportError:
    print("[thumbnail] fatal: the 'huggingface_hub' package is not installed (pip install huggingface_hub)", file=sys.stderr)
    raise

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent
FONT_PATH = REPO_ROOT / "assets" / "fonts" / "Anton-Regular.ttf"
LOGO_PATH = REPO_ROOT / "assets" / "logo.png"

OUT_WIDTH, OUT_HEIGHT = 1280, 720
GEN_WIDTH, GEN_HEIGHT = 1344, 768  # 16:9, multiple of 16 -- generous crop margin for the 1280x720 final crop

HF_TOKEN = os.environ.get("HF_TOKEN")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.5-flash-lite"]
FLUX_MODEL = "black-forest-labs/FLUX.1-schnell"

COLORS = {
    "white": (255, 255, 255),
    "yellow": (255, 214, 10),
    "red": (237, 28, 36),
    "green": (60, 220, 90),
}
OUTLINE_COLOR = (0, 0, 0)

# ---------------------------------------------------------------------------
# Title analysis: Gemini first (genuinely adapts to ANY title), a rule-based
# keyword classifier as the non-fatal fallback if every Gemini model fails.
# ---------------------------------------------------------------------------

ANALYZE_PROMPT_TMPL = """You are the thumbnail designer for a YouTube documentary/news channel called
NEXT SCENE TV - THE FUTURE UNCOVERED. Given a video title, plan a bold,
high-CTR YouTube thumbnail in the style of professional geopolitics/news
channels: dramatic, cinematic, high contrast, dark rich backgrounds.

Video title: "{title}"

Return ONLY valid JSON, no markdown fences, in this exact shape:
{{
  "image_prompt": "a single English sentence describing ONLY the visual scene for an AI image generator - dramatic, cinematic, photo-realistic, documentary/news aesthetic, specific to this title's subject (real places/objects/subjects implied by the title, e.g. cracked earth and burning skylines for a collapse story, military hardware and battlefield atmosphere for a war story, skyscrapers and currency for an economy story, a recognizable landscape/city for a place). The prompt MUST explicitly demand a clean image with NO text, NO words, NO letters, NO numbers, NO logos, NO watermarks anywhere in the image - only a photographic/cinematic scene, since headline text is added separately afterward. Leave a plausible clear/dark area suitable for overlaid text.",
  "category": "one of: war, africa, economy, countries, cities, technology, disaster, people, other - whichever best matches the title's subject",
  "category_label": "a short 1-3 word ALL CAPS tag for a small corner banner, e.g. GLOBAL CRISIS, TOP RANKING, EXCLUSIVE REPORT - pick something that fits this specific title",
  "words": [
    {{"text": "ONE", "color": "white|yellow|red|green"}}
  ]
}}
"words" must be the ENTIRE title broken into individual word/short-phrase tokens, in reading order, ALL CAPS, together spelling out essentially the original title (numbers and year ranges kept as their own tokens). Color rules - apply sparingly and only to truly important words, most words should be white:
- white: the default for most words
- yellow: numbers, rankings, dates/year ranges, and positive/attention-grabbing words
- red: dramatic, negative, alarming, or high-stakes words (collapse, war, crisis, danger, attack, dying, worst, secret, exposed, etc.)
- green: positive/uplifting emphasis words (beautiful, richest, best, safest, etc.) - use rarely
Do not color every word - most of the title should stay white with only the 2-4 most important words highlighted."""


def _clean_json(raw: str) -> str:
    raw = raw.strip()
    raw = re.sub(r"^```json\s*", "", raw, flags=re.IGNORECASE)
    raw = re.sub(r"^```\s*", "", raw)
    raw = re.sub(r"```\s*$", "", raw)
    return raw.strip()


def analyze_title_with_gemini(title: str):
    if not GEMINI_API_KEY:
        return None
    prompt = ANALYZE_PROMPT_TMPL.format(title=title.replace('"', "'"))
    last_err = None
    for model in GEMINI_MODELS:
        try:
            # Auth via the x-goog-api-key HEADER rather than a ?key= query
            # param: a query-param key can end up echoed back inside a
            # requests/urllib3 exception's own string repr (the connection
            # error message includes the request URL) - which would then
            # land in our own [thumbnail] log line. The header keeps the key
            # out of the URL entirely, so it can never leak that way.
            res = requests.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json"},
                json={"contents": [{"parts": [{"text": prompt}]}]},
                timeout=30,
            )
            if not res.ok:
                raise RuntimeError(f"{model} responded {res.status_code}")
            data = res.json()
            raw = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(_clean_json(raw))
            words = parsed.get("words") or []
            if not words:
                raise RuntimeError("no words returned")
            for w in words:
                if w.get("color") not in COLORS:
                    w["color"] = "white"
            return {
                "image_prompt": parsed.get("image_prompt") or _fallback_prompt(title, "other"),
                "category": parsed.get("category") or "other",
                "category_label": (parsed.get("category_label") or "").upper()[:24],
                "words": [{"text": str(w["text"]).upper(), "color": w["color"]} for w in words],
            }
        except Exception as err:  # noqa: BLE001 - genuinely want to try every model
            last_err = err
            print(f"[thumbnail] title analysis via {model} failed: {err}, trying next model...", file=sys.stderr)
    print(f"[thumbnail] all Gemini analysis models failed ({last_err}), using rule-based fallback", file=sys.stderr)
    return None


# --- rule-based fallback (no network dependency beyond nothing) ------------

CATEGORY_KEYWORDS = {
    "war": ["war", "wars", "conflict", "conflicts", "military", "army", "invasion", "battle", "soldier", "weapon", "missile", "nuclear"],
    "africa": ["africa", "african", "nigeria", "kenya", "ethiopia", "egypt", "sahara", "congo", "rwanda"],
    "economy": ["economy", "economic", "gdp", "money", "billionaire", "billionaires", "richest", "poorest", "trade", "market", "currency", "debt", "wealth"],
    "countries": ["countries", "country", "nations", "nation", "world"],
    "cities": ["city", "cities", "skyline", "megacity", "urban"],
    "technology": ["technology", "tech", "ai", "artificial intelligence", "robot", "robots", "chip", "chips", "digital", "cyber"],
    "disaster": ["collapse", "crisis", "disaster", "flood", "earthquake", "famine", "drought", "pandemic"],
    "people": ["women", "men", "people", "population"],
}

RED_WORDS = {
    "collapse", "collapsing", "war", "wars", "crisis", "danger", "dangerous", "attack", "dying", "death", "dead",
    "warning", "threat", "invasion", "disaster", "doom", "fall", "falling", "poorest", "worst", "secret", "hidden",
    "banned", "exposed", "conflict", "conflicts", "nuclear", "famine", "collapsed",
}
GREEN_WORDS = {
    "beautiful", "richest", "best", "winning", "success", "successful", "safest", "happiest", "strongest",
}
YEAR_RE = re.compile(r"^\d{4}([-–]\d{2,4})?$")
NUM_RE = re.compile(r"^\d+([.,]\d+)?$")


def _fallback_prompt(title: str, category: str) -> str:
    scene_by_category = {
        "war": f"dramatic cinematic documentary photo of military vehicles, soldiers and battlefield atmosphere, smoke and dramatic lighting, evoking the story of '{title}'",
        "africa": f"dramatic cinematic documentary photo of an African landscape and city skyline at golden hour, evoking the story of '{title}'",
        "economy": f"dramatic cinematic documentary photo of a financial district skyline, currency and stock charts reflected in glass towers at night, evoking the story of '{title}'",
        "countries": f"dramatic cinematic documentary photo of a glowing world map or globe from space with dramatic lighting, evoking the story of '{title}'",
        "cities": f"dramatic cinematic documentary photo of a massive futuristic city skyline at night with dense traffic light trails, evoking the story of '{title}'",
        "technology": f"dramatic cinematic documentary photo of futuristic servers, glowing digital interfaces and robotics in a dark high-tech facility, evoking the story of '{title}'",
        "disaster": f"dramatic cinematic documentary photo of a city under environmental and economic stress, storm clouds and distant fire and smoke, evoking the story of '{title}'",
        "people": f"dramatic cinematic documentary portrait-style photo of people in an evocative real-world setting, evoking the story of '{title}'",
        "other": f"dramatic cinematic documentary photo evoking the story of '{title}', strong central focal point",
    }
    base = scene_by_category.get(category, scene_by_category["other"])
    return (
        f"{base}, strong depth, highly detailed, professional television documentary aesthetic, "
        "intense atmosphere, composition optimized for a YouTube thumbnail with a clear dark area for "
        "headline typography. Absolutely NO text, NO words, NO letters, NO numbers, NO logos, NO watermarks "
        "anywhere in the image - a clean photographic scene only."
    )


def analyze_title_rule_based(title: str):
    lower = title.lower()
    category = "other"
    for cat, keywords in CATEGORY_KEYWORDS.items():
        if any(kw in lower for kw in keywords):
            category = cat
            break

    words = []
    for raw_word in title.split():
        token = raw_word.strip()
        if not token:
            continue
        stripped = re.sub(r"[^\w.–-]", "", token).lower()
        if YEAR_RE.match(stripped) or NUM_RE.match(stripped):
            color = "yellow"
        elif stripped in RED_WORDS:
            color = "red"
        elif stripped in GREEN_WORDS:
            color = "green"
        else:
            color = "white"
        words.append({"text": token.upper(), "color": color})

    label_by_category = {
        "war": "CONFLICT WATCH", "africa": "AFRICA REPORT", "economy": "ECONOMIC OUTLOOK",
        "countries": "GLOBAL RANKING", "cities": "URBAN FUTURE", "technology": "TECH FRONTIER",
        "disaster": "BREAKING ANALYSIS", "people": "SPOTLIGHT", "other": "NEXT SCENE TV",
    }
    return {
        "image_prompt": _fallback_prompt(title, category),
        "category": category,
        "category_label": label_by_category.get(category, "NEXT SCENE TV"),
        "words": words,
    }


def analyze_title(title: str):
    return analyze_title_with_gemini(title) or analyze_title_rule_based(title)


# ---------------------------------------------------------------------------
# FLUX.1-schnell background generation via Hugging Face Inference Providers
# ---------------------------------------------------------------------------

def generate_background(prompt: str, seed: int | None = None, max_attempts: int = 3) -> Image.Image:
    if not HF_TOKEN:
        raise RuntimeError("HF_TOKEN is not set")
    client = InferenceClient(provider="auto", api_key=HF_TOKEN)

    last_err = None
    for attempt in range(1, max_attempts + 1):
        try:
            image = client.text_to_image(
                prompt,
                model=FLUX_MODEL,
                width=GEN_WIDTH,
                height=GEN_HEIGHT,
                seed=seed,
            )
            return image.convert("RGB")
        except Exception as err:  # noqa: BLE001
            last_err = err
            # A provider that rejects our width/height (or seed) still deserves
            # a real attempt without them before we give up on this attempt.
            try:
                image = client.text_to_image(prompt, model=FLUX_MODEL)
                return image.convert("RGB")
            except Exception as err2:  # noqa: BLE001
                last_err = err2
            if attempt < max_attempts:
                delay = 2 ** attempt
                print(f"[thumbnail] FLUX generation attempt {attempt} failed: {last_err} - retrying in {delay}s...", file=sys.stderr)
                time.sleep(delay)
    raise RuntimeError(f"FLUX.1-schnell generation failed after {max_attempts} attempts: {last_err}")


# ---------------------------------------------------------------------------
# Compositing
# ---------------------------------------------------------------------------

def cover_crop(im: Image.Image, target_w: int, target_h: int) -> Image.Image:
    return ImageOps.fit(im, (target_w, target_h), method=Image.LANCZOS, centering=(0.5, 0.45))


def darken_band(im: Image.Image, top_frac: float, bottom_frac: float, opacity: float = 0.62) -> Image.Image:
    """Alpha-blends a black gradient band (denser at the bottom) behind the
    headline so bold text stays readable over a busy AI photo."""
    w, h = im.size
    overlay = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    grad = ImageDraw.Draw(overlay)
    y0, y1 = int(h * top_frac), int(h * bottom_frac)
    for y in range(y0, y1):
        t = (y - y0) / max(1, (y1 - y0))
        alpha = int(255 * opacity * t)
        grad.line([(0, y), (w, y)], fill=(0, 0, 0, alpha))
    if y1 < h:
        grad.rectangle([0, y1, w, h], fill=(0, 0, 0, int(255 * opacity)))
    base = im.convert("RGBA")
    return Image.alpha_composite(base, overlay).convert("RGB")


def fit_words_to_lines(draw: ImageDraw.ImageDraw, words, max_width: int, max_lines: int, max_height: int, font_path: Path):
    """Greedy-wraps colored word tokens into lines using REAL glyph metrics
    (not an estimate), auto-shrinking the font until the block satisfies BOTH
    max_lines AND max_height -- checking line count alone isn't enough: a
    short zone can still overflow past the frame edge at a font size that
    technically wraps into few enough lines (caught by rendering real test
    thumbnails, where a 4-line headline ran off the bottom of the canvas
    entirely at the first font size that satisfied line-count alone).
    Returns (font, lines, space_w)."""

    def measure(font, text):
        return draw.textlength(text, font=font)

    def wrap_at(size):
        font = ImageFont.truetype(str(font_path), size)
        space_w = measure(font, "  ")
        lines, current, current_w = [], [], 0.0
        for w in words:
            ww = measure(font, w["text"])
            add_w = ww + (space_w if current else 0)
            if current and current_w + add_w > max_width:
                lines.append(current)
                current, current_w = [w], ww
            else:
                current.append(w)
                current_w += add_w
        if current:
            lines.append(current)
        return font, lines, space_w

    sizes = [116, 100, 88, 76, 66, 58, 50, 44, 38, 32, 28]
    best = None
    for size in sizes:
        font, lines, space_w = wrap_at(size)
        total_h = int(font.size * 1.22) * len(lines)
        best = (font, lines, space_w)  # always keep the smallest-so-far as a fallback
        if len(lines) <= max_lines and total_h <= max_height:
            return font, lines, space_w
    return best


def draw_headline(base: Image.Image, words, zone, font_path: Path):
    """Draws the headline centered within `zone` = (x0, y0, x1, y1), each
    word in its analyzed color, thick black outline + soft drop shadow."""
    draw = ImageDraw.Draw(base)
    zone_w = zone[2] - zone[0]
    zone_h = zone[3] - zone[1]
    font, lines, space_w = fit_words_to_lines(
        draw, words, int(zone_w * 0.94), max_lines=4, max_height=int(zone_h * 0.96), font_path=font_path
    )

    line_height = int(font.size * 1.22)
    total_h = line_height * len(lines)
    start_y = zone[1] + max(0, (zone_h - total_h) // 2)
    outline_w = max(3, font.size // 14)

    # soft glow/shadow layer, blurred then composited beneath the crisp text
    shadow_layer = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_layer)

    for i, line in enumerate(lines):
        line_w = sum(draw.textlength(w["text"], font=font) for w in line) + space_w * (len(line) - 1)
        x = zone[0] + (zone_w - line_w) / 2
        y = start_y + i * line_height
        for w in line:
            shadow_draw.text((x + 4, y + 6), w["text"], font=font, fill=(0, 0, 0, 160))
            x += draw.textlength(w["text"], font=font) + space_w

    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(6))
    base_rgba = base.convert("RGBA")
    base_rgba = Image.alpha_composite(base_rgba, shadow_layer)
    draw = ImageDraw.Draw(base_rgba)

    for i, line in enumerate(lines):
        line_w = sum(draw.textlength(w["text"], font=font) for w in line) + space_w * (len(line) - 1)
        x = zone[0] + (zone_w - line_w) / 2
        y = start_y + i * line_height
        for w in line:
            color = COLORS.get(w["color"], COLORS["white"])
            draw.text((x, y), w["text"], font=font, fill=color, stroke_width=outline_w, stroke_fill=OUTLINE_COLOR)
            x += draw.textlength(w["text"], font=font) + space_w

    return base_rgba.convert("RGB")


def draw_category_banner(base: Image.Image, label: str, font_path: Path, accent=(237, 28, 36)):
    if not label:
        return base
    draw = ImageDraw.Draw(base)
    font = ImageFont.truetype(str(font_path), 30)
    pad_x, pad_y = 22, 12
    text_w = draw.textlength(label, font=font)
    box_w, box_h = int(text_w + pad_x * 2), int(font.size + pad_y * 2)
    draw.rectangle([0, 34, box_w, 34 + box_h], fill=accent)
    draw.text((pad_x, 34 + pad_y - 2), label, font=font, fill=(255, 255, 255), stroke_width=2, stroke_fill=(0, 0, 0))
    return base


def paste_logo(base: Image.Image, logo_path: Path, corner: str = "bottom-right"):
    if not logo_path.exists():
        return base
    logo = Image.open(logo_path).convert("RGBA")
    target_h = int(base.height * 0.155)
    scale = target_h / logo.height
    logo = logo.resize((int(logo.width * scale), target_h), Image.LANCZOS)

    margin = 22
    if corner == "bottom-right":
        pos = (base.width - logo.width - margin, base.height - logo.height - margin)
    else:  # top-right
        pos = (base.width - logo.width - margin, margin)

    # subtle drop shadow so the badge stands out against any background
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    shadow_alpha = logo.split()[3].point(lambda a: min(a, 140))
    shadow_layer = Image.new("RGBA", logo.size, (0, 0, 0, 255))
    shadow_layer.putalpha(shadow_alpha)
    shadow.paste(shadow_layer, (pos[0] + 3, pos[1] + 5), shadow_layer)
    shadow = shadow.filter(ImageFilter.GaussianBlur(4))

    base_rgba = base.convert("RGBA")
    base_rgba = Image.alpha_composite(base_rgba, shadow)
    base_rgba.paste(logo, pos, logo)
    return base_rgba.convert("RGB")


LAYOUTS = [
    # (headline_zone_top_frac, headline_zone_bottom_frac, band_top_frac, logo_corner, show_banner)
    (0.32, 0.95, 0.24, "bottom-right", True),
    (0.03, 0.62, 0.00, "bottom-right", False),
    (0.36, 0.92, 0.28, "top-right", True),
]


def compose_thumbnail(bg: Image.Image, analysis: dict, variation_index: int) -> Image.Image:
    im = cover_crop(bg, OUT_WIDTH, OUT_HEIGHT)
    # cinematic contrast/saturation nudge so an AI photo reads as bold TV-doc footage
    im = ImageOps.autocontrast(im, cutoff=1)

    top_frac, bottom_frac, band_top, logo_corner, show_banner = LAYOUTS[variation_index % len(LAYOUTS)]
    im = darken_band(im, band_top, 1.0 if bottom_frac > 0.9 else bottom_frac, opacity=0.60)

    zone = (48, int(OUT_HEIGHT * top_frac), OUT_WIDTH - 48, int(OUT_HEIGHT * bottom_frac))
    im = draw_headline(im, analysis["words"], zone, FONT_PATH)

    if show_banner:
        im = draw_category_banner(im, analysis.get("category_label", ""), FONT_PATH)

    im = paste_logo(im, LOGO_PATH, corner=logo_corner)
    return im


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="NEXT SCENE TV thumbnail compositor")
    parser.add_argument("--title", required=True)
    parser.add_argument("--variations", type=int, default=1)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--style", default=None, help="optional extra style hint appended to the image prompt")
    args = parser.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    analysis = analyze_title(args.title)
    if args.style:
        analysis["image_prompt"] = f"{analysis['image_prompt']} Additional style: {args.style}."

    generated = []
    for i in range(1, max(1, args.variations) + 1):
        seed = random.randint(1, 2_147_483_647)
        try:
            bg = generate_background(analysis["image_prompt"], seed=seed)
            thumb = compose_thumbnail(bg, analysis, variation_index=i - 1)
            out_path = out_dir / f"thumbnail_{i:02d}.jpg"
            thumb.save(out_path, "JPEG", quality=95)
            generated.append(str(out_path))
            print(f"[thumbnail] variation {i}/{args.variations} ready: {out_path}", file=sys.stderr)
        except Exception as err:  # noqa: BLE001 - one bad variation must not stop the rest
            print(f"[thumbnail] variation {i}/{args.variations} failed, skipping: {err}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    # machine-readable summary on its own stdout line for the Node wrapper to parse
    print(json.dumps({"generated": generated, "category": analysis.get("category")}))

    if not generated:
        sys.exit(1)


if __name__ == "__main__":
    main()
