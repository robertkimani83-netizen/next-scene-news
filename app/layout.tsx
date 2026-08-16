import "./globals.css";

export const metadata = {
  title: "VOX254 - The Voice of 254",
  description: "AI-curated Kenyan news, updated around the clock.",
  verification: {
  google: "6Dl4AogANlyfZpuXypF7zKID-6F2SZ4ZlpOUMTKJHHY",
},
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-7244574512843335"
          crossOrigin="anonymous"></script>
      </head>
      <body>{children}</body>
    </html>
  );
}
