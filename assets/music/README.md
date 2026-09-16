# Background music bed library

Drop MP3/M4A/WAV files directly in this folder. Every run of the pipeline
(`scripts/generate-short.mjs` and `scripts/generate-documentary.mjs`) picks
one at random via `scripts/lib/audio-library.mjs`'s `pickMusicBed()`, loops
and trims it to the video's length, and mixes it in under the narration at
low volume. Nothing else in the pipeline needs to change when you add files
here; it's picked up automatically on the next run.

**This folder is no longer required for a music bed to appear.** As of
Sep 16 2026, if this folder is empty, the pipeline automatically falls back
to searching Freesound (the same API/key already used for transition sound
effects) for a longer ambient/atmospheric track, filtered to CC0 first, then
Attribution-licensed with credit captured in the run's asset manifest. So:

- Folder has files → one is picked at random from here (best quality/
  consistency, since it's a curated source — this tier always wins when
  populated).
- Folder is empty + `FREESOUND_API_KEY` is set → an ambient track is found
  and downloaded automatically. Freesound is a general sound-sharing
  community rather than a curated music library, so hit quality is more
  variable than a hand-picked folder.
- Folder is empty + no Freesound key → no music bed, narration-only, exactly
  as the pipeline behaved before Sep 16 2026.

Populating this folder by hand (below) is still worth doing if you want more
consistent, curated music — it's just no longer the only way to get any
music at all.

## Where to get tracks (recommended: YouTube Audio Library)

This is the source recommended in the Sept 16 2026 channel-upgrade brief.
There's no official API for it — Google doesn't expose one — so this is a
one-time manual step, not something the pipeline can do for you:

1. Go to https://www.youtube.com/audiolibrary (sign in with the account
   NEXTSCENE uploads from).
2. Filter by mood — good fits for this channel: Cinematic, Dramatic,
   Corporate/Tech, Ambient.
3. Every track there is either "no attribution required" or lists the
   attribution text right next to it — pick a few of the "no attribution
   required" ones first, since those are the simplest to reuse with zero
   extra work.
4. Click the download icon on each track you want, and drop the resulting
   file straight into this folder.

A good starting set is 8-12 tracks so the same one doesn't repeat every
video. Nothing needs a specific filename — the picker just reads whatever's
in this folder.

## Alternatives

If you'd rather not use YouTube's library, Pixabay Music
(pixabay.com/music/) and Free Music Archive both offer free-for-commercial-
use tracks you can download the same way (browser, manual download, drop
the file here) — same one-time manual step either way, since neither of
those has an automation-friendly API either.

## License note

The pipeline doesn't re-verify licensing for anything in this folder — it
trusts that whatever you've put here is already cleared for commercial use
on a monetized channel (which is exactly what YouTube Audio Library's
"no attribution required" tracks, and Pixabay Music / FMA's commercial-use
tracks, are for). If a track requires attribution, add that credit to the
video's description yourself — the pipeline's asset manifest only logs
*which* file it used and when, not attribution text for local uploads.

The automatic Freesound fallback tier is different: it's filtered to CC0
first (no attribution needed), falling back to Attribution-licensed tracks
only if no CC0 match turns up — and when it does use an Attribution track,
the credit line is captured directly in the run's `asset-manifest.json`
(`role: "music"`, with a `license`/`attribution` field), same as the
transition SFX already does. Check that file after a run and copy any
`attribution` string into the video description.
