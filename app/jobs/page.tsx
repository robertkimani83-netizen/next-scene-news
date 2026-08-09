import { fetchAllJobs } from "@/lib/rss";
import Link from "next/link";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Jobs – Flash254",
  description: "Local and international job openings for Kenyans, updated regularly.",
};

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diffMs / 3600000);
  if (hrs < 1) return "moments ago";
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function JobsPage() {
  const jobs = await fetchAllJobs();

  return (
   <main>
      <div style={{ padding: "24px", maxWidth: "900px", margin: "0 auto" }}>
        <Link href="/" style={{ fontSize: "14px", color: "#666666" }}>← Back to Flash254</Link>

        <h1 style={{ fontSize: "30px", fontWeight: 800, color: "#111111", margin: "16px 0 8px" }}>
          Jobs in Kenya
        </h1>
        <p style={{ fontSize: "15px", color: "#666666", marginBottom: "28px" }}>
          Local and international opportunities, updated regularly.
        </p>

        {jobs.length === 0 && (
          <p style={{ color: "#888888" }}>No job listings available right now. Check back soon.</p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          {jobs.map((job, i) => (
            
             <a key={i}
              href={job.link}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "block",
                border: "1px solid #e5e5e5",
                borderRadius: "8px",
                padding: "16px 20px",
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div style={{ fontSize: "12px", fontWeight: 700, color: "#b8860b", textTransform: "uppercase", marginBottom: "6px" }}>
                {job.sourceName} · {timeAgo(job.publishedAt)}
              </div>
              <h3 style={{ fontSize: "17px", fontWeight: 700, color: "#111111", marginBottom: "6px" }}>
                {job.title}
              </h3>
              <p style={{ fontSize: "14px", color: "#666666" }}>
                {job.description.slice(0, 160)}...
              </p>
            </a>
          ))}
        </div>
      </div>
    </main>
  );
}
