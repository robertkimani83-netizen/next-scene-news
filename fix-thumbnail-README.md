# Fix: long-form video thumbnails

## What happened

Your `thumbnail_compositor.py` file (the script that builds the AI thumbnails
for long-form videos) got silently gutted over five commits between Sept 12
and Sept 14 - all titled just "Update thumbnail_compositor.py", with no
description of what changed:

```
638fa3e  Sept 10  - last known-good version (520 lines, fully working)
a0a2ec6  Sept 12  - 2406 lines, but crashes instantly with a Python error
0f7890f  Sept 12  - 1845 lines, broken in a different way
aeb61da  Sept 12  - 2332 lines, broken in a different way
c465cf4  Sept 12  - 1990 lines, never outputs a result the pipeline can read
109ea1c  Sept 14  - 252 lines - reduced to a stub with no actual code left
```

By Sept 14 the file had been reduced to just the imports, a text-cleanup
helper, the AI prompt text, and a comment telling "a future editor" to
finish writing the actual image-generation and compositing code - the part
that actually builds a dramatic thumbnail was just gone. There's no `main()`
function, no calls to generate the background image or draw the headline
text, nothing.

Because that script silently fails (it just prints nothing and returns
nothing), the pipeline's Node.js code treats it as "AI thumbnail generation
didn't work this time" and quietly falls back to grabbing a random frame
from the video instead - which is why every recent long-form thumbnail
looks flat and generic instead of the dramatic, styled ones you had before.
Nothing crashed or errored anywhere you'd have seen it; it just stopped
doing the interesting part.

**One thing worth checking on your end:** all five of those commits have
generic, undescriptive commit messages, unlike your other commits (e.g. the
Sept 10 one has a full description). That pattern - especially the
progressive breakage across the day - suggests these were made through
something other than a properly verified session (a direct GitHub web edit,
a different tool, or an AI session that never actually ran the code before
committing it). Worth a look at your commit history / any other tool you
might have pointed at this file, so this doesn't happen again.

## The fix

This patch restores the last version that actually worked in full (Sept 10,
`638fa3e`) - the one with real FLUX.1-schnell background generation, Gemini
art-direction, and the full Pillow text/logo compositing - and adds one
small improvement on top: a text-sanitizing step (`clean_text_for_pillow`)
that strips out stylized Unicode characters and emoji before drawing text,
so a headline word or category label never renders as a broken square box
if Gemini happens to return a fancy Unicode character instead of a plain
letter.

I tested it end-to-end (not just checked that it runs without crashing):
ran it with dummy/invalid API keys and confirmed it degrades exactly the
way it's supposed to - tries Gemini, falls back to a rule-based title
analysis if Gemini fails, tries FLUX for the background, and still prints
a valid result the rest of the pipeline can read either way. With your real
API keys and normal network access in GitHub Actions, it'll generate the
full styled thumbnail like it used to.

## How to apply

```
git apply fix-thumbnail.patch
```
```
git add scripts/lib/thumbnail_compositor.py
```
```
git commit -m "Restore working thumbnail compositor, add Unicode text safety"
```
```
git pull --no-edit
```
```
git push
```

## After this

Your next long-form video (or the next manually triggered "Generate
Documentary" run) should get a proper AI-composited thumbnail again -
cinematic background, colored headline words, category banner, logo -
instead of a plain video-frame grab.
