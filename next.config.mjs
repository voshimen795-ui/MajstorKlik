/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Playwright se NIKAD ne bandluje u Next build — koristi se samo u
  // Node worker procesu (scripts/harvest.ts, Railway/Render), ne u serverless funkciji.
  experimental: {
    serverComponentsExternalPackages: ['playwright', 'playwright-core'],
  },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
