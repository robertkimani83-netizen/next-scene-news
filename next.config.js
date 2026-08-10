/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { hostname: "images.pexels.com" },
    ],
  },
  experimental: {
    outputFileTracingIncludes: {
      '/api/youtube/**': ['./node_modules/ffmpeg-static/**'],
    },
  },
};
module.exports = nextConfig;
