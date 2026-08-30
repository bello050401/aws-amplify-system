/**
 * The one section-boundary wrapper every block of the rewritten detail
 * page uses (spec C: 商品画像/基本情報/販売情報/.../更新履歴, each
 * separated by a thin horizontal rule — spec's own "────" sketch) — a
 * single definition so all nine sections read as one consistent rhythm
 * down the page rather than each block hand-rolling its own spacing.
 * ExtendedFieldsSummary renders its own matching wrapper internally (one
 * per registry section) rather than using this component directly, since
 * it needs to loop over several sections at once — same visual class
 * names, kept in sync by eye since there's only the one other call site.
 *
 * BELLO統合業務OS指示書(2026-08-30) §75/§122: モバイルでは商品詳細を
 * アコーディオン化する — native `<details>/<summary>`をそのまま使う
 * (JS状態管理不要、キーボード操作・スクリーンリーダーも標準で対応)。
 * `open`をデフォルトにしてあるので、これまでと同じく全項目が最初から
 * 見える(§155: 情報を隠すことによる縮小に見えないようにするため) —
 * 「折りたためる」機能が追加されただけで、初期表示は変わらない。
 * デスクトップ幅でも同じ<details>を使う(モバイル専用の別実装を作らず、
 * 「折りたたみ可能」という機能自体はどの画面幅でも害にならないため —
 * デスクトップで折りたたむ操作をする人はほぼいないだろうが、それは
 * ユーザーの選択に委ねる)。
 */
export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="group mt-5 border-t border-gray-100 pt-3 first:mt-0 first:border-t-0 first:pt-0" open>
      <summary className="mb-1.5 flex cursor-pointer list-none items-center gap-1 text-[11px] font-bold text-gray-400">
        <span className="inline-block transition-transform group-open:rotate-90">▶</span>
        {title}
      </summary>
      {children}
    </details>
  );
}
