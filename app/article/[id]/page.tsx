import { getArticleById } from "@/lib/store";
import { notFound } from "next/navigation";
import Link from "next/link";
import ArticleImage from "@/components/ArticleImage";

export const dynamic = "force-dynamic";

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diffMs / 3600000);
  if (hrs < 1) return "moments ago";
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function ArticlePage({ params }: { params: { id: string } }) {
  const article = await getArticleById(params.id);
  if (!article) return notFound();

  const bodyText = article.article ?? (article as any).summary ?? "";
  const paragraphs = bodyText.split(/\n\n+/).filter(Boolean);

  return (
    <main>
      <header className="site-header">
        <Link href="/" style={{ textDecoration: "none" }}>
          <div className="wordmark">
            <img src="/vox254_logo.png" alt="VOX254 - The Voice of 254" style={{ height: "40px", width: "auto" }} />
          </div>
        </Link>
      </header>

      <article className="article-page">
      <div className="eyebrow">VOX254</div>
        <h1 className="article-title">{article.headline}</h1>
        <div className="byline">{timeAgo(article.publishedAt)}</div>

        <div className="article-photo">
          <ArticleImage photo={article.photo} alt={article.headline} aspectRatio="16/9" watermarkSize="large" />
        </div>
        {article.photo &&
          !article.photo.isFallback &&
          (article.photo.source === "Wikimedia Commons" ||
            article.photo.source === "Openverse") && (
            <div className="photo-credit">{article.photo.credit}</div>
          )}

        <div className="article-body">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        <div className="article-credit">
          Originally reported by {article.sourceName}.{" "}
          <a href={article.link} target="_blank" rel="noopener noreferrer">
            View original source →
          </a>
        </div>

        <Link href="/" className="back-link">
          ← Back to VOX254
        </Link>
      </article>
    </main>
  );
}
