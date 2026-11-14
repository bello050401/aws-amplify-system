"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * 追加仕様「売上画面の年月移動UIを改善する」— 現在の年月表示自体を
 * クリック可能にし、年一覧+1〜12月を1クリックずつ選べるポップアップを
 * 開く。これにより「2026年8月 → 2023年 → 5月」のように2〜3操作で
 * 数年前へ直接ジャンプできる(前月/翌月ボタンを何十回も押す必要がない)。
 *
 * 既存の前月/翌月/今月/先月ボタン(page.tsx側、`<Link>`によるURL遷移)は
 * そのまま維持し、このコンポーネントは「年月表示」部分だけをクライアント
 * コンポーネント化して追加する — 既存の年月状態管理(`?y=&m=`クエリ
 * パラメータ、サーバーコンポーネントでの集計)は一切変更しない。選択後は
 * router.push でURLを更新するだけなので、ブラウザの戻る/進むでも
 * 年月状態が破綻しない(既存方式をそのまま踏襲)。
 *
 * 年一覧は「現在年を含む前後の範囲」を動的に生成する — ハードコードした
 * 年リストにしない(来年以降もメンテ不要にするため)。既存データが無い
 * 年月を選んでも売上集計自体は0件として安全に表示されるだけなので、
 * 表示可能な年の範囲を厳密にバリデーションする必要はない。
 */
export function YearMonthPicker({ year, month, currentYear }: { year: number; month: number; currentYear: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pickerYear, setPickerYear] = useState(year);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setPickerYear(year);
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, year]);

  function selectMonth(m: number) {
    setOpen(false);
    router.push(`/inventory/sales?y=${pickerYear}&m=${m}`);
  }

  // 現在年から過去10年・未来2年を候補にする — 「2023年など数年前へ
  // 2〜3操作で移動」という要件を満たしつつ、無制限リストにはしない。
  const yearCandidates: number[] = [];
  for (let y = currentYear + 2; y >= currentYear - 10; y--) yearCandidates.push(y);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="min-w-[110px] border border-gray-200 bg-gray-50 px-3 py-1 text-center text-[14px] font-bold text-gray-900 hover:bg-gray-100"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {year}年{month}月 <span className="text-gray-400">▼</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-64 border border-gray-300 bg-white p-2 shadow-md">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-bold text-gray-400">年を選択</span>
          </div>
          <div className="mb-2 grid max-h-32 grid-cols-4 gap-1 overflow-y-auto">
            {yearCandidates.map((y) => (
              <button
                key={y}
                type="button"
                onClick={() => setPickerYear(y)}
                className={`border px-1 py-1 text-[12px] ${
                  y === pickerYear ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-700 hover:bg-gray-50"
                }`}
              >
                {y}
              </button>
            ))}
          </div>
          <div className="mb-2 text-[11px] font-bold text-gray-400">{pickerYear}年 - 月を選択</div>
          <div className="grid grid-cols-4 gap-1">
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => selectMonth(m)}
                className={`border px-1 py-1.5 text-[12px] ${
                  pickerYear === year && m === month ? "border-gray-900 bg-gray-900 text-white" : "border-gray-200 text-gray-700 hover:bg-gray-50"
                }`}
              >
                {m}月
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
