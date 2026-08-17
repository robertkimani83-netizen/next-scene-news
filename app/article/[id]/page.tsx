import { getArticleById } from "@/lib/store";
import { notFound } from "next/navigation";
import Link from "next/link";
import ArticleImage from "@/components/ArticleImage";
import type { Metadata } from "next";

const BASE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://next-scene-news-897q.vercel.app";

type Props = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const article = await getArticleById(id);

  if (!article) {
    return {
      title: "Article Not Found | VOX254",
      description: "The requested VOX254 article could not be found.",
    };
  }

  const description =
    article.teaser ||
    article.article?.slice(0, 160) ||
    "Read the latest news from VOX254 - The Voice of 254.";

  const articleUrl = `${BASE_URL}/article/${article.id}`;

  const imageUrl =
    article.photo && !article.photo.isFallback
      ? article.photo.url
      : `${BASE_URL}/vox254_logo.png`;

  return {
    title: `${article.headline} | VOX254`,
    description: description.slice(0, 160),

    alternates: {
      canonical: articleUrl,
    },

    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
      },
    },

    openGraph: {
      type: "article",
      url: articleUrl,
      title: article.headline,
      description: description.slice(0, 160),
      siteName: "VOX254",
      locale: "en_KE",
      publishedTime: article.publishedAt,
      images: [
        {
          url: imageUrl,
          width: 1200,
          height: 675,
          alt: article.headline,
        },
      ],
    },

    twitter: {
      card: "summary_large_image",
      title: article.headline,
      description: description.slice(0, 160),
      images: [imageUrl],
    },
  };
}

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diffMs / 3600000);

  if (hrs < 1) return "moments ago";
  if (hrs < 24) return `${hrs}h ago`;

  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function ArticlePage({ params }: Props) {
  const { id } = await params;

  const article = await getArticleById(id);

  if (!article) return notFound();

  const bodyText = article.article ?? article.teaser ?? "";
  const paragraphs = bodyText.split(/\n\n+/).filter(Boolean);

  const articleUrl = `${BASE_URL}/article/${article.id}`;

  const imageUrl =
    article.photo && !article.photo.isFallback
      ? article.photo.url
      : `${BASE_URL}/vox254_logo.png`;

  const structuredData = {
    "@context": "https://schema.org",
    "@type": "NewsArticle",

    mainEntityOfPage: {
      "@type": "WebPage",
      "@id": articleUrl,
    },

    headline: article.headline,

    description:
      article.teaser ||
      article.article?.slice(0, 160) ||
      "",

    datePublished: article.publishedAt,
    dateModified: article.publishedAt,

    image: [imageUrl],

    author: {
      "@type": "Organization",
      name: "VOX254",
      url: BASE_URL,
    },

    publisher: {
      "@type": "Organization",
      name: "VOX254",
      url: BASE_URL,

      logo: {
        "@type": "ImageObject",
        url: `${BASE_URL}/vox254_logo.png`,
      },
    },

    isAccessibleForFree: true,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData),
        }}
      />

      <main>
        <header className="site-header">
          <Link href="/" style={{ textDecoration: "none" }}>
            <div className="wordmark">
              <img
                src="/vox254_logo.png"
                alt="VOX254 - The Voice of 254"
                style={{
                  height: "40px",
                  width: "auto",
                }}
              />
            </div>
          </Link>
        </header>

        <article className="article-page">
          <div className="eyebrow">VOX254</div>

          <h1 className="article-title">
            {article.headline}
          </h1>

          <div className="byline">
            {timeAgo(article.publishedAt)}
          </div>

          <div className="article-photo">
            <ArticleImage
              photo={article.photo}
              alt={article.headline}
              aspectRatio="16/9"
              watermarkSize="large"
            />
          </div>

          {article.photo &&
            !article.photo.isFallback &&
            (article.photo.source === "Wikimedia Commons" ||
              article.photo.source === "Openverse") && (
              <div className="photo-credit">
                {article.photo.credit}
              </div>
            )}

          <div className="article-body">
            {paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </div>

          <div className="article-credit">
            Originally reported by {article.sourceName}.{" "}
            <a
              href={article.link}
              target="_blank"
              rel="noopener noreferrer"
            >
              View original source →
            </a>
          </div>

          <Link href="/" className="back-link">
            ← Back to VOX254
          </Link>
        </article>
      </main>
    </>
  );
}
