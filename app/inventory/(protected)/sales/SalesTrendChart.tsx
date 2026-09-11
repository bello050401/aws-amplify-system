"use client";

import { useState } from "react";
import type { SalesTrendPoint } from "@/lib/inventory/salesView";

const WIDTH = 640;
const HEIGHT = 220;
const PADDING = { top: 16, right: 16, bottom: 24, left: 8 };

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §20/§21: 売上画面の
 * 12ヶ月推移グラフ(売上高・粗利益、レスポンシブ、ツールチップ)。
 *
 * チャート専用ライブラリ(recharts等)を新規導入せず、素のSVGで実装
 * している — package.jsonにチャートライブラリが一つも入っておらず、
 * このアプリ全体がここまで一貫して「小さな要件にはライブラリを足さず
 * 自前で書く」判断をしてきている(サムネイル表示・ページング・日付欄
 * 等、すべて自前実装)ことに合わせた。データ点は12点のみ・折れ線2本
 * だけなので、専用ライブラリが要るほどの複雑さではない。
 *
 * ── 2026-09-11 追加修正: 未集計/取得エラーの月を0円と混同しない ────
 *
 * 各点は`status`("ok"/"missing"/"error")を持つ(lib/inventory/salesView.ts
 * のloadSalesSummary参照、Inventoryを読まずに集計テーブルだけから
 * 作った推移データ)。"ok"でない月は折れ線をそこで途切れさせ(0円の
 * 位置に線をつながない)、塗りつぶさない輪(missingは灰色、errorは赤)
 * で「値を持たない」ことを示す——0円の実績と区別できないまま線を
 * つなぐと、未集計の月がグラフ上だけ「売上ゼロだった月」に見えて
 * しまうため。
 */
export function SalesTrendChart({ points }: { points: SalesTrendPoint[] }) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const okPoints = points.filter((p) => p.status === "ok");
  const maxValue = Math.max(1, ...okPoints.map((p) => Math.max(p.totalSales, p.totalGrossProfit)));
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;

  const xFor = (i: number) => PADDING.left + (points.length <= 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth);
  const yFor = (value: number) => PADDING.top + plotHeight - (value / maxValue) * plotHeight;

  /** "ok"の点だけをつないだ折れ線。連続していない("ok"でない点を挟む)区間は別のセグメントとして描き、その間に線を引かない(0円へ落とさない)。 */
  function buildPath(valueOf: (p: SalesTrendPoint) => number): string {
    const segments: string[] = [];
    let drawing = false;
    points.forEach((p, i) => {
      if (p.status !== "ok") {
        drawing = false;
        return;
      }
      segments.push(`${drawing ? "L" : "M"} ${xFor(i)} ${yFor(valueOf(p))}`);
      drawing = true;
    });
    return segments.join(" ");
  }

  const salesPath = buildPath((p) => p.totalSales);
  const profitPath = buildPath((p) => p.totalGrossProfit);

  const hovered = hoverIndex != null ? points[hoverIndex] : null;
  const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
  const statusLabel = (status: SalesTrendPoint["status"]) => (status === "missing" ? "未集計" : status === "error" ? "取得エラー" : null);

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-4 text-[11px] text-gray-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-gray-900" aria-hidden />
          売上高
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3 bg-emerald-500" aria-hidden />
          粗利益
        </span>
        {hovered && (
          <span className="ml-auto font-bold text-gray-700">
            {hovered.year}年{hovered.month}月:{" "}
            {hovered.status === "ok"
              ? `売上高 ${yen(hovered.totalSales)} / 粗利益 ${yen(hovered.totalGrossProfit)}`
              : statusLabel(hovered.status)}
          </span>
        )}
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="直近12ヶ月の売上高・粗利益推移">
        {/* 横軸ラベル(年またぎが分かるよう、1月は「2026/1」、それ以外は「3」のように表示) */}
        {points.map((p, i) => (
          <text key={`x-${i}`} x={xFor(i)} y={HEIGHT - 6} textAnchor="middle" className="fill-gray-400" style={{ fontSize: 9 }}>
            {p.month === 1 ? `${p.year}/${p.month}` : p.month}
          </text>
        ))}

        <path d={salesPath} fill="none" stroke="#111827" strokeWidth={2} />
        <path d={profitPath} fill="none" stroke="#10b981" strokeWidth={2} />

        {points.map((p, i) => {
          const label = statusLabel(p.status);
          const ringColor = p.status === "error" ? "#dc2626" : "#9ca3af";
          return (
            <g key={`pt-${i}`}>
              {p.status === "ok" ? (
                <>
                  <circle cx={xFor(i)} cy={yFor(p.totalSales)} r={3} fill="#111827" />
                  <circle cx={xFor(i)} cy={yFor(p.totalGrossProfit)} r={3} fill="#10b981" />
                </>
              ) : (
                // 値を持たない月は塗りつぶさない輪1つだけ(0円の位置に点を打たない)。
                <circle cx={xFor(i)} cy={yFor(0)} r={3} fill="white" stroke={ringColor} strokeWidth={1.5} />
              )}
              {/* ホバー/フォーカス用の透明な当たり判定列 — 点そのものは小さいため、月ごとに縦に細長い矩形を敷いて操作しやすくする。 */}
              <rect
                x={xFor(i) - plotWidth / Math.max(points.length, 1) / 2}
                y={PADDING.top}
                width={plotWidth / Math.max(points.length, 1)}
                height={plotHeight}
                fill="transparent"
                tabIndex={0}
                role="button"
                aria-label={
                  p.status === "ok"
                    ? `${p.year}年${p.month}月: 売上高 ${yen(p.totalSales)}, 粗利益 ${yen(p.totalGrossProfit)}`
                    : `${p.year}年${p.month}月: ${label}`
                }
                onMouseEnter={() => setHoverIndex(i)}
                onMouseLeave={() => setHoverIndex(null)}
                onFocus={() => setHoverIndex(i)}
                onBlur={() => setHoverIndex(null)}
              >
                {/* 中身は必ず「式ひとつ」にする。複数の式を並べるとReactは
                    サーバー側で text ノードの間に `<!-- -->` を挟むが、
                    `<title>`はHTMLのRCDATA要素でコメントが解釈されず生の
                    文字列になるため、hydrationがテキストノードを見つけられず
                    「Hydration failed」で落ちる(実際に売上画面で発生していた)。 */}
                <title>{`${p.year}年${p.month}月: ${p.status === "ok" ? `売上高 ${yen(p.totalSales)} / 粗利益 ${yen(p.totalGrossProfit)}` : label}`}</title>
              </rect>
            </g>
          );
        })}

        {hoverIndex != null && (
          <line x1={xFor(hoverIndex)} x2={xFor(hoverIndex)} y1={PADDING.top} y2={PADDING.top + plotHeight} stroke="#d1d5db" strokeWidth={1} />
        )}
      </svg>
    </div>
  );
}
