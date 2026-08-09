import Link from "next/link";

export const metadata = {
  title: "About – Flash254",
  description: "Learn about Flash254, Kenya's AI-powered news platform.",
};

export default function AboutPage() {
  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "48px 24px" }}>
      <Link href="/" style={{ fontSize: "14px", color: "#666666" }}>← Back to Flash254</Link>

      <h1 style={{ fontSize: "32px", fontWeight: 800, color: "#111111", margin: "24px 0 24px" }}>
        About Flash254
      </h1>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        Flash254 is an AI-powered news platform bringing you Kenya&apos;s latest headlines as they happen.
      </p>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        We aggregate breaking news from trusted Kenyan sources — including Kenyans.co.ke, Nation Africa,
        AllAfrica Kenya, Nairobi Wire, and the Kenya News Agency — and use AI to rewrite each story into
        a clear, original article, so you get the full picture without switching between a dozen different sites.
      </p>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        Every article credits its original source, with a link back for readers who want to dive deeper
        into the full reporting.
      </p>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        Flash254 updates around the clock, pulling fresh stories from multiple sources several times a day,
        so you&apos;re never far behind on what&apos;s happening in Kenya — politics, business, entertainment, and more.
      </p>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        We also feature job opportunities for Kenyans — both locally and internationally — to help connect
        job seekers with real openings and their qualifications.
      </p>

      <p style={{ fontSize: "16px", color: "#333333", lineHeight: 1.7 }}>
        Got a tip, question, or feedback? Reach out on our <Link href="/contact" style={{ color: "#b8860b", fontWeight: 600 }}>Contact page</Link>.
      </p>
    </main>
  );
}
