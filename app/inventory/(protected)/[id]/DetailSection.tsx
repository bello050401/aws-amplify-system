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
 */
export function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 border-t border-gray-100 pt-3 first:mt-0 first:border-t-0 first:pt-0">
      <p className="mb-1.5 text-[11px] font-bold text-gray-400">{title}</p>
      {children}
    </div>
  );
}
