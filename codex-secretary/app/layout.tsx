import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '掌心助理',
  description: '你的私人 Codex 工作台',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icon-192.png', type: 'image/png' }],
    apple: [{ url: '/icon-192.png', type: 'image/png' }],
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f5f1e8',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
