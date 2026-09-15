# Fix: queued trending topics kept losing to map/guess videos

## What was happening

Your queued trending topics (gold prices, Venezuela) weren't broken - they
were just never getting a turn. Here's why:

Every time the Shorts pipeline runs, it first rolls the dice to decide
**what kind of video** to make:
- 32% chance: "Guess the Country"
- 33% chance: "Map Challenge"
- 35% chance: a normal topic video

Only in that last case (35% of the time) does it even look at your queued
trending topics. So when you trigger a run, there's roughly a 2-in-3 chance
it rolls "Guess" or "Map" instead - and your queued Venezuela/gold topics
just sit there waiting for a run that never comes, while map videos keep
going out. That matches exactly what you saw.

This is a real gap in how I built the priority-queue feature - it was
designed to jump the line *within* the normal-topic rotation, but nobody
told the dice roll to check the queue first.

## The fix

Now, before rolling the dice, the pipeline checks: is anything queued? If
yes, it skips the random roll entirely and forces the matching format -
your queued trending topic now goes out on the very next run, guaranteed,
instead of waiting on luck. If nothing's queued, everything works exactly
as before (32/33/35 random split).

I tested this in isolation (not just read the code): confirmed the queue
gets checked correctly, consumed one item at a time in order, and correctly
reports "empty" once both queued topics are used up.

This only affects Shorts (`generate-short.mjs`) - the long-form pipeline
doesn't have this problem since it only ever makes one kind of video, so
your queued long-form topics were always going to be used on the next run
regardless.

## How to apply

```
git apply fix-format-priority.patch
git add scripts/generate-short.mjs scripts/lib/topic-history.mjs
git commit -m "Force queued format when a trending topic is waiting, instead of rolling the dice"
git pull --no-edit
git push
```

After this, your next Shorts run (scheduled or manually triggered) should
pull the Venezuela topic first, then gold prices on the run after that,
before falling back to the normal rotation.
