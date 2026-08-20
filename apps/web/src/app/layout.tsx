import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';
import { Providers } from './providers';

export const metadata: Metadata = {
  title: '项目运营中心',
  description: '内部项目运营管理平台',
};

type RootLayoutProps = Readonly<{
  children: ReactNode;
}>;

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="zh-CN">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
