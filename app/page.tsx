import { loadArticles } from "@/lib/store";

function PulseLine() {
  return (
    <svg className="pulse-line" viewBox="0 0 90 20" xmlns="http://www.w3.org/2000/svg">
      <path d="M0 10 L25 10 L32 2 L40 18 L47 10 L90 10" />
    </svg>
  );
}

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diffMs / 3600000);
  if (hrs < 1) return "moments ago";
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function HomePage() {
  const articles = await loadArticles();
  const [hero, ...rest] = articles;

  return (
    <main>
      <header className="site-header">
        <div>
          <div className="wordmark">
            NEXT SCENE<span> NEWS</span>
          </div>
          <div className="tagline">Habari mpya, kila saa</div>
        </div>
      </header>

      {articles.length > 0 && (
        <div className="pulse-ticker">
          <span className="label">BREAKING</span>
          <PulseLine />
          <div className="ticker-text">
            {articles.slice(0, 5).map((a) => a.headline).join("   •   ")}
          </div>
        </div>
      )}

      {!hero ? (
        <div className="empty-state">
          <h2>No stories yet</h2>
          <p>Run the /api/cron pipeline to pull in the first batch of news.</p>
        </div>
      ) : (
        <>
          <section className="hero">
            <div className="hero-media">
              {hero.photo && <img src={hero.photo.url} alt={hero.headline} />}
            </div>
            <div className="hero-copy">
              <div className="eyebrow">{hero.sourceName}</div>
              <h1>{hero.headline}</h1>
              <p>{hero.summary}</p>
              <div className="byline">
                {timeAgo(hero.publishedAt)} · <a href={hero.link}>Read original source →</a>
              </div>
            </div>
          </section>

          <div className="section-label">More stories</div>
          <div className="story-grid">
            {rest.map((a) => (
              <article className="story-card" key={a.id}>
                <div className="thumb">{a.photo && <img src={a.photo.url} alt={a.headline} />}</div>
                <div className="body">
                  <div className="source">{a.sourceName} · {timeAgo(a.publishedAt)}</div>
                  <h3>{a.headline}</h3>
                  <p>{a.summary}</p>
                  <div className="social-status">
                    <span className={a.postedTo.facebook ? "live" : ""}>Facebook</span>
                    <span className={a.postedTo.instagram ? "live" : ""}>Instagram</span>
                    <span className={a.postedTo.tiktok ? "live" : ""}>TikTok</span>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
