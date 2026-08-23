import Parser from "rss-parser";

// Custom fields so we can pull an image out of whichever format each feed
// happens to use - WordPress feeds usually use <enclosure>, others use the
// Media RSS namespace (<media:content>, <media:thumbnail>).
const parser = new Parser({
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  },
  timeout: 10000,
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
    ],
  },
});

// Free, public RSS feeds from Kenyan outlets.
// Add or remove sources here any time - this list is the only thing
// you need to touch to change what the site pulls from.
export const KENYA_FEEDS = [
  { name: "Kenyans.co.ke", url: "https://www.kenyans.co.ke/feeds/news" },
  { name: "AllAfrica Kenya", url: "https://allafrica.com/tools/headlines/rdf/kenya/headlines.rdf" },
  { name: "Nairobi Wire", url: "https://nairobiwire.com/feed" },
];

export const JOB_FEEDS = [
  { name: "MyJobMag Kenya", url: "https://www.myjobmag.co.ke/jobsxml_by_categories.xml" },
];
