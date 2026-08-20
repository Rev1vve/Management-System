import type { NextConfig } from 'next';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  async rewrites() {
    // Same-origin proxy: the browser only ever talks to the web origin, so
    // the httpOnly session cookie is set for the web host (and via Caddy the
    // private Tailscale HTTPS origin in production).
    return [
      {
        source: '/api/:path*',
        destination: `${API_ORIGIN}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
