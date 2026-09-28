import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "拾音 · 音频批量下载",
  description: "批量下载公开网页音频，读取哔哩哔哩独立音轨，或从视频提取完整声音，一次打包下载。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="antialiased">{children}</body>
    </html>
  );
}
