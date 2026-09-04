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
  /**
   * **先読みしない**（2026-09-04 実ブラウザ計測で判明）。
   *
   * 既定の `preload: true` だと、next/font はこの書体の**全サブセット**に
   * 対して `<link rel="preload" as="font">` をHTMLへ書き出す。日本語の
   * 書体はGoogle Fontsが unicode-range で百数十個に分割しており、
   * それが4ウェイトぶん並ぶ。実測(Staging・ログイン画面):
   *
   *   preload リンク 353本 / フォント取得 358ファイル / 約4.5MB
   *   HTML自体も 88KB（大半がこのlinkタグ）
   *
   * `preload` は「これは必ず要る」という指示なので、unicode-range による
   * 出し分けが**効かない**。実際に使う文字は数百字なので、ほぼ全部が無駄。
   * しかもこれはルートレイアウトなので**全画面**で毎回起きる。
   *
   * false にすると、next/font は @font-face（unicode-range 付き）だけを
   * 出し、ブラウザが**実際に必要なサブセットだけ**を取りに行く。
   * `display: "swap"` を既に指定してあるので、文字はフォールバックで
   * すぐ表示され、読み込み後に差し替わる —— 見た目の最終形は変わらない。
   */
  preload: false,
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
