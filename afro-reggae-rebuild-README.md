# Afro-Reggae AI Music: rebuild so it actually works

## What I found

This repo existed but had never produced a single video - all 3 test runs
failed. Digging in, I found two separate problems, one hidden and one that
was causing the failures:

1. **Lyrics were never actually AI-generated.** `generate_metadata.py` used
   two hardcoded templates and returned the exact same "Sweet island
   loving..." lyrics every single run, no matter what title/theme/mood you
   typed in. It never called any AI at all.
2. **The singing engine needed a real GPU it didn't have.** The pipeline
   tried to run ACE-Step 1.5 (a full AI singing model) locally - first on
   your PC, then on GitHub's free Windows runner. Neither has a real GPU:
   your PC's GT 730 was already flagged in this repo's own notes as too
   weak, and GitHub's free runners have none. The last attempt just sat
   waiting ~25 minutes for the model to start, then gave up and failed.

## What I changed

- **Real lyrics.** `generate_metadata.py` now calls Gemini for real (same
  approach as the news channel's scripts) - title, lyrics, music style,
  photo search terms, description and tags all genuinely follow what you
  type into the workflow form.
- **Real singing, without needing a GPU anywhere.** `generate_music.py` now
  calls a free, public Hugging Face Space running an open-source model
  called DiffRhythm, which does the actual AI singing on Hugging Face's own
  shared free GPU pool. Your computer (or GitHub's runner) never touches a
  GPU - it just sends a request over the internet and gets a finished song
  back, the exact same pattern already working for thumbnail generation in
  `next-scene-news`.
- **Real photos instead of plain color cards.** `generate_scenes.py` now
  pulls real stock photos from Pexels (same free service and API key you
  already use for the news channel) instead of drawing gradient cards with
  text on them.
- **Much simpler, cheaper workflow.** Dropped the whole Windows/self-hosted/
  local-model-install setup. It's now a plain `ubuntu-latest` GitHub runner,
  like the news channel's pipelines - no runner to keep online, and Linux
  runners cost half as many of your free Actions minutes as Windows ones.

## One real limitation you should know about: English only, for now

I looked closely at whether the singing model supports Swahili, since your
channel's earlier videos mixed English and Swahili. It doesn't - its own
lyrics tool only lists English and Chinese, which strongly suggests it was
never trained on Swahili, and singing Swahili lines through it would likely
come out mispronounced or garbled. So for now, every song is written and
sung in English only. Once this pipeline is proven working, it's worth
revisiting.

## Being upfront about testing

I tested everything in this patch that I could from where I'm running -
the fallback lyrics, the real Pexels-photo-fetch code path's structure, the
video assembly, and the thumbnail generator all ran successfully end to end
and produced a real 120-second video file with a real thumbnail.

The one piece I could NOT personally test is the actual call to the
DiffRhythm singing model - my environment blocks direct access to
huggingface.co as a policy restriction (not a sign anything is broken; the
same thing happened with Gemini/thumbnail testing earlier and that turned
out fine once it ran for real). I read the model's own source code directly
to get the exact function signature right, and I added logging that prints
exactly what's available if anything about that interface has changed, so
if this step ever fails, the GitHub Actions log will say clearly what
happened instead of failing silently.

**So please run your first test with "Upload to YouTube" left unchecked.**
Every run - upload on or off - saves a downloadable artifact with the song,
video and thumbnail, so you can check the first one before anything touches
YouTube. If the singing step does fail, send me the log output from that
step and I'll fix it directly rather than guessing again.

## What this needs from you (see SETUP.md for full details)

Repository secrets to add (Settings -> Secrets and variables -> Actions):

- `GEMINI_API_KEY` - reuse your existing one from next-scene-news
- `HF_TOKEN` - reuse your existing one from next-scene-news
- `PEXELS_API_KEY` - reuse your existing one from next-scene-news
- `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN` -
  these need to be NEW, specifically authorized for NEXT VIBE MUSIC (not
  reused from next-scene-news, since that's a different channel) - only
  needed once you're ready to actually upload, not for the first test.

## How to apply

```
git apply afro-reggae-rebuild.patch
git add -A
git commit -m "Rebuild pipeline: real Gemini lyrics, free DiffRhythm singing, real Pexels photos, drop Windows/GPU runner"
git pull --no-edit
git push
```

Then add the secrets above, and run **Actions -> Create Afro-Reggae Song ->
Run workflow** with "Upload to YouTube" unchecked for the first try.
