import Link from "next/link";

export const metadata = {
  title: "Contact – Flash254",
  description: "Get in touch with Flash254.",
};

export default function ContactPage() {
  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "48px 24px" }}>
      <Link href="/" style={{ fontSize: "14px", color: "#666666" }}>← Back to Flash254</Link>

      <h1 style={{ fontSize: "32px", fontWeight: 800, color: "#111111", margin: "24px 0 24px" }}>
        Contact Flash254
      </h1>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        Got a tip, question, or feedback? We&apos;d love to hear from you.
      </p>

      <p style={{ fontSize: "16px", color: "#333333", marginBottom: "18px", lineHeight: 1.7 }}>
        Email: <a href="mailto:flash254news@gmail.com" style={{ color: "#b8860b", fontWeight: 600 }}>flash254news@gmail.com</a>
      </p>

      <p style={{ fontSize: "16px", color: "#333333", lineHeight: 1.7 }}>
        Website: <a href="https://next-scene-news-897q.vercel.app" style={{ color: "#b8860b", fontWeight: 600 }}>flash254 online</a>
      </p>
    </main>
  );
}
