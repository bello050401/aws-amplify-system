import type { Metadata } from "next";
import { Zen_Kaku_Gothic_New } from "next/font/google";
import "./globals.css";

// One typeface, used only through weight and scale — the restraint itself
// is the point (spec §13: "細めのタイポグラフィ" / thin typography, no
// decorative flourish). This is the shared shell every generated feature
// page renders inside; it deliberately does not carry any one brand's
// identity so a vitra collection and a Cassina collection both feel native.
const zenKaku = Zen_Kaku_Gothic_New({
  subsets: ["latin"],
  weight: ["300", "400", "500", "700"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: "特集ページ",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja" className={zenKaku.variable}>
      <body className="bg-paper font-body text-ink antialiased">{children}</body>
    </html>
  );
}
