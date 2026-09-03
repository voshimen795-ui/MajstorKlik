/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Playwright se NIKAD ne bandluje u Next build — koristi se samo u
  // Node worker procesu (scripts/harvest.ts, Railway/Render), ne u serverless funkciji.
  experimental: {
    // Ovi paketi se učitavaju iz node_modules u runtime-u, ne kroz webpack bundle.
    // @sparticuz/chromium nosi binarni Chromium — bundlovanje ga pokvari.
    serverComponentsExternalPackages: ['playwright', 'playwright-core', '@sparticuz/chromium'],
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
