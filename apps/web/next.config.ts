import type { NextConfig } from 'next';

const API_ORIGIN = process.env.API_ORIGIN ?? 'http://127.0.0.1:3001';

const nextConfig: NextConfig = {
  // 生产镜像用 standalone 产物（见 apps/web/Dockerfile）。
  // 只在构建镜像时开启：Windows/OneDrive 上 standalone 会创建符号链接并失败（EPERM）。
  ...(process.env.NEXT_OUTPUT_STANDALONE === 'true'
    ? {
        output: 'standalone' as const,
        // 镜像内没有 e2e 目录所需的 prisma client，构建时用排除 e2e 的 tsconfig。
        typescript: { tsconfigPath: 'tsconfig.build.json' },
      }
    : {}),
  agentRules: false,
  devIndicators: false,
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
