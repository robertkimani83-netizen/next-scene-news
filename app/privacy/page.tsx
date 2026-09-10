import Link from "next/link";

export const metadata = {
  title: "Privacy Policy – Flash254",
  description: "Privacy Policy for Flash254 (VOX254) and its related YouTube automation tools.",
};

export default function PrivacyPage() {
  const sectionHeading = {
    fontSize: "22px",
    fontWeight: 700,
    color: "#111111",
    margin: "32px 0 12px",
  } as const;
  const paragraph = {
    fontSize: "16px",
    color: "#333333",
    marginBottom: "14px",
    lineHeight: 1.7,
  } as const;

  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "48px 24px" }}>
      <Link href="/" style={{ fontSize: "14px", color: "#666666" }}>← Back to Flash254</Link>

      <h1 style={{ fontSize: "32px", fontWeight: 800, color: "#111111", margin: "24px 0 8px" }}>
        Privacy Policy
      </h1>
      <p style={{ fontSize: "14px", color: "#777777", marginBottom: "24px" }}>
        Last updated: September 2026
      </p>

      <p style={paragraph}>
        This Privacy Policy explains how Flash254 (also published as VOX254) and its related
        automated video tools — including the NEXTSCENE TV YouTube channel and video-generation
        pipeline — collect, use, and protect information. This policy applies to the website at{" "}
        <a href="https://next-scene-news-897q.vercel.app" style={{ color: "#b8860b", fontWeight: 600 }}>
          next-scene-news-897q.vercel.app
        </a>{" "}
        and to the software that publishes content to our YouTube channels.
      </p>

      <h2 style={sectionHeading}>Who we are</h2>
      <p style={paragraph}>
        Flash254 / VOX254 / NEXTSCENE TV are independently operated media projects run by a single
        individual publisher. We are not a company collecting data on behalf of third parties — the
        tools described below exist solely to research, produce, and publish our own news and video
        content.
      </p>

      <h2 style={sectionHeading}>Information we collect on this website</h2>
      <p style={paragraph}>
        We do not require visitors to create an account, and we do not knowingly collect names,
        addresses, or other directly identifying information through this website. Standard web
        server logs (such as IP address, browser type, and pages visited) may be recorded temporarily
        for security and performance purposes.
      </p>

      <h2 style={sectionHeading}>Advertising and cookies</h2>
      <p style={paragraph}>
        This site displays advertising served by Google AdSense. Google and its partners may use
        cookies or similar technologies to serve ads based on a visitor&apos;s prior visits to this or
        other websites. Visitors can learn more about how Google uses this information, and opt out
        of personalized advertising, at{" "}
        <a
          href="https://policies.google.com/technologies/partner-sites"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#b8860b", fontWeight: 600 }}
        >
          Google&apos;s Partner Sites policy
        </a>{" "}
        and{" "}
        <a
          href="https://adssettings.google.com"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#b8860b", fontWeight: 600 }}
        >
          Google Ads Settings
        </a>
        .
      </p>

      <h2 style={sectionHeading}>Use of Google APIs and YouTube data</h2>
      <p style={paragraph}>
        Our video-production tools use Google&apos;s APIs, including the YouTube Data API, solely to
        upload videos, thumbnails, and metadata that we ourselves create to YouTube channels that we
        ourselves own and operate (including NEXTSCENE TV). This access is used only for automated
        publishing of our own content — it is never used to read, collect, or share the personal data
        of other YouTube users, channel owners, or viewers.
      </p>
      <p style={paragraph}>
        Flash254/VOX254/NEXTSCENE TV&apos;s use and transfer of information received from Google APIs
        adheres to the{" "}
        <a
          href="https://developers.google.com/terms/api-services-user-data-policy"
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "#b8860b", fontWeight: 600 }}
        >
          Google API Services User Data Policy
        </a>
        , including the Limited Use requirements.
      </p>

      <h2 style={sectionHeading}>Third-party news sources</h2>
      <p style={paragraph}>
        Flash254 aggregates and rewrites breaking news from trusted Kenyan sources, always crediting
        the original publisher with a link back to their reporting. We do not collect personal data
        from those source websites.
      </p>

      <h2 style={sectionHeading}>Children&apos;s privacy</h2>
      <p style={paragraph}>
        Our services are not directed at children under 13, and we do not knowingly collect personal
        information from children.
      </p>

      <h2 style={sectionHeading}>Changes to this policy</h2>
      <p style={paragraph}>
        We may update this Privacy Policy from time to time to reflect changes in our practices. Any
        changes will be posted on this page with an updated revision date.
      </p>

      <h2 style={sectionHeading}>Contact us</h2>
      <p style={paragraph}>
        Questions about this Privacy Policy can be sent to{" "}
        <a href="mailto:robertkimani83@gmail.com" style={{ color: "#b8860b", fontWeight: 600 }}>
          robertkimani83@gmail.com
        </a>
        .
      </p>
    </main>
  );
}
