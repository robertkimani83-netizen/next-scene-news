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
      '/api/og/**': ['./assets/fonts/**', './public/vox254_icon.png'],
    },
  },
};
module.exports = nextConfig;
