import { createHash } from "node:crypto";
import type { ShippingRank } from "./rank";

/**
 * 送料マスタの充足率を測るための純粋関数群。AWSに一切触れない。
 *
 * ## なぜ lib/shipping/importer.ts から分けたのか(2026-09-02)
 *
 * 元は importer.ts に、公式サイトからの自動取得(スクレイピング)と
 * 同居していた。方針変更で自動取得は廃止したが、**「9ランク × 50地域の
 * 組合せが埋まっているか」を数える処理は、取得元が何であっても要る**
 * —— 人が画面から編集する運用でも、どこが未入力かは分からないと困る。
 *
 * 取得手段(捨てた)と、充足の測り方(残す)を混ぜていたのが元の構造の
 * 弱いところで、分けたことで「公式サイトの都合」に縛られなくなった。
 */

export const ALL_SHIPPING_RANKS: ShippingRank[] = ["SS", "S", "A", "B", "C", "D", "E", "F", "G", "OVERSIZE"];

/**
 * 全destination × 全rank の期待組合せ。
 * 地域の細分(市区町村単位等)が要るようになったら、この関数だけを
 * 差し替えれば済む。
 */
export function buildExpectedMatrix(
  destinationPrefectures: string[],
  ranks: ShippingRank[] = ALL_SHIPPING_RANKS,
): { destinationPrefecture: string; rank: ShippingRank }[] {
  const cells: { destinationPrefecture: string; rank: ShippingRank }[] = [];
  for (const destinationPrefecture of destinationPrefectures) {
    for (const rank of ranks) cells.push({ destinationPrefecture, rank });
  }
  return cells;
}

export interface MatrixCompletenessResult {
  expectedCells: number;
  verifiedCells: number;
  unavailableCells: number;
  missingCells: number;
  /** (verified+unavailable)/expected —— 「結果が分かっている」割合。推測で埋めた分は分子に含めない。 */
  completenessRatio: number;
  missingCombinations: { destinationPrefecture: string; rank: ShippingRank }[];
}

/**
 * 期待matrixと実データを照合し、欠けている組合せを列挙する。
 * **欠損を0円扱いにしない** —— 0円は「無料」という別の事実であって、
 * 「まだ分かっていない」ではない。
 */
export function computeMatrixCompleteness(
  expected: { destinationPrefecture: string; rank: ShippingRank }[],
  actual: { destinationPrefecture: string; rank: ShippingRank; status: "VERIFIED" | "UNAVAILABLE" }[],
): MatrixCompletenessResult {
  const actualByKey = new Map(actual.map((a) => [`${a.destinationPrefecture}|${a.rank}`, a.status] as const));
  let verifiedCells = 0;
  let unavailableCells = 0;
  const missingCombinations: { destinationPrefecture: string; rank: ShippingRank }[] = [];
  for (const cell of expected) {
    const status = actualByKey.get(`${cell.destinationPrefecture}|${cell.rank}`);
    if (status === "VERIFIED") verifiedCells++;
    else if (status === "UNAVAILABLE") unavailableCells++;
    else missingCombinations.push(cell);
  }
  const expectedCells = expected.length;
  return {
    expectedCells,
    verifiedCells,
    unavailableCells,
    missingCells: missingCombinations.length,
    completenessRatio: expectedCells === 0 ? 0 : (verifiedCells + unavailableCells) / expectedCells,
    missingCombinations,
  };
}

/**
 * 値の差分検出用hash。CSV一括更新で「実際に変わった行だけ書く」判定に使う
 * (同じ値を書き直すと updatedAt / version だけが動いて履歴が汚れる)。
 */
export function computeRawHash(rawText: string): string {
  return createHash("sha256").update(rawText).digest("hex");
}
