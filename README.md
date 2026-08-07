# Next Scene News

An AI news site that:
1. Pulls Kenyan headlines from RSS feeds
2. Rewrites them with AI into original summaries + social captions
3. Finds a matching stock photo for each story
4. Posts automatically to Facebook, Instagram, and TikTok
5. Puts the article link in the **comment** on Facebook/Instagram (better reach than a link in the caption), and in the caption on TikTok (its API doesn't support auto-commenting yet)

Runs on a schedule with zero manual work once it's set up.

---

## 1. Deploy the site (free)

1. Create a free account at [vercel.com](https://vercel.com) (sign in with GitHub).
2. Push this folder to a new GitHub repo.
3. In Vercel: **New Project → Import your repo → Deploy**.
4. That's it — you'll get a free URL like `next-scene-news.vercel.app`.

## 2. Get your API keys

You need five sets of credentials in total, but the first two are enough to get the site itself fully working — no card, no business verification. Add the social posting ones later once Facebook/Instagram/TikTok are sorted.

**Start here (free, no card, no review):**

| Service | Where | Cost | Notes |
|---|---|---|---|
| Google Gemini (AI rewriting) | aistudio.google.com → Get API Key | Free, no card | Sign in with any Google account, instant |
| Pexels (photos) | pexels.com/api | Free, no card | Instant, no review |

**Add later, once ready for autoposting:**

| Service | Where | Cost | Notes |
|---|---|---|---|
| Facebook Page | developers.facebook.com | Free | Create a Business app, get a Page Access Token for your Page |
| Instagram | Same Facebook app | Free | Your Instagram must be a **Business or Creator account** linked to that Facebook Page |
| TikTok | developers.tiktok.com | Free | Requires an app review before it can post publicly — apply early, it can take days |

Once you have a value, go to your Vercel project → **Settings → Environment Variables** and add it. The pipeline is built to skip any platform whose keys aren't set yet — it won't break, it'll just leave that platform's post undone until you add the key.

## 3. Turn on autoposting

The `vercel.json` file already schedules the pipeline to run 3 times a day (6am, 12pm, 5pm Nairobi-ish time — adjust the cron string if you want different times). Vercel automatically sends your `CRON_SECRET` as a Bearer token, so nothing else to configure.

To run it manually and test:
```
curl https://your-site.vercel.app/api/cron -H "Authorization: Bearer YOUR_CRON_SECRET"
```

## 4. Adjust what it pulls

Open `lib/rss.ts` — the `KENYA_FEEDS` list is the only thing you need to touch to add or remove news sources.

To change how many stories get posted per run, edit `MAX_POSTS_PER_RUN` in `app/api/cron/route.ts`. Start low (2-3) — free tiers and follower patience both run out fast if you post too often.

## 5. Known limitations (read this before you rely on it)

- **TikTok comments**: TikTok's public API has no endpoint yet for posting a comment on your own content, so the link goes in the caption there instead of a comment.
- **Photos are stock images, not real event photos.** Pexels/free photo APIs return generic matching imagery (e.g. a photo of a courtroom for a court story), not the actual photo from the actual event. For real event photos you'd need the original article's image under its own usage rights, which is a separate, harder problem.
- **The article store is a JSON file** (`data/articles.json`). This is fine for testing, but Vercel's filesystem resets between deploys and isn't shared across function calls reliably at higher traffic. If the site starts acting like it's "forgetting" articles, swap `lib/store.ts` for a real free-tier database (Vercel KV, Supabase, and Turso all have free tiers) — nothing else in the codebase needs to change.
- **Copyright**: the AI rewrite step is there specifically so you're not republishing another outlet's exact text. Don't remove that step even to save API costs.
- **TikTok app review**: until TikTok approves your app, it can only post to your own test account, not go fully live.

## 6. Local development

```
npm install
cp .env.example .env.local   # fill in your keys
npm run dev
```
