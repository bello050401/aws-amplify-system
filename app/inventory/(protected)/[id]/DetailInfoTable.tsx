export interface DetailInfoRow {
  label: string;
  value: React.ReactNode;
}

/**
 * The one dense "項目名 | 値" row renderer every section of the detail
 * page uses (基本情報's hand-built rows and every ExtendedFieldsSummary
 * section) — ZAICO-style information density (spec §14: "表形式・定義
 * リスト形式で詰めて表示"), not the airier card-grid layout this page
 * used before. A plain Server Component; nothing here is interactive.
 */
export function DetailInfoTable({ rows }: { rows: DetailInfoRow[] }) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-gray-100 last:border-b-0">
            <th className="w-[150px] shrink-0 py-1.5 pr-3 text-left align-top text-[11px] font-normal text-gray-400">{row.label}</th>
            <td className="whitespace-pre-wrap py-1.5 align-top text-gray-900">{row.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
