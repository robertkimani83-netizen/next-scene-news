import "./globals.css";

export const metadata = {
  title: "VOX254 - The Voice of 254",
  description: "AI-curated Kenyan news, updated around the clock.",
  verification: {
    google: "ZTZTto1zIxSwEeQOPpFU6zHQs02iqqY-m14a3sDOfNU",
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
