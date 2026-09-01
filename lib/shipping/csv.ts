import type { ShippingRank } from "./rank";

/**
 * 送料マスタのCSV入出力(純粋関数のみ。AWSに触らない)。
 *
 * ## 何のためにあるか
 *
 * 450件(9ランク × 50地域)を画面から1件ずつ直すのは現実的ではない。
 * 料金改定のように一度に多くが変わる場面のために、書き出して直して
 * 戻せるようにする。
 *
 * ## 壊さないための設計
 *
 * - **既存行の削除は絶対にしない。** CSVに載っていない組合せは
 *   「変更なし」であって「削除」ではない。450件を守る要件があるので、
 *   ここで削除を表現できないようにしておく(そもそも削除の意図を
 *   受け取る型が無い)。
 * - **1行でも壊れていたら、何も適用しない。** 途中まで適用して
 *   止まると、どこまで反映されたのか分からない状態になる。
 *   検証を全部通してから書き込みへ進む。
 * - 「配送不可」は 0円ではなく **price を空** にして表す。0円は
 *   「無料」という別の事実で、混ぜると送料回答が嘘になる。
 */

export const CSV_HEADERS = [
  "発送先都道府県",
  "地域",
  "ランク",
  "料金",
  "配送不可",
  "備考",
  "最終更新日時",
] as const;

export interface ShippingCsvRow {
  destinationPrefecture: string;
  destinationArea: string | null;
  rank: ShippingRank;
  /** 配送不可の場合はnull(0ではない)。 */
  price: number | null;
  unavailable: boolean;
  sourceReference: string | null;
}

export interface CsvParseError {
  /** 1始まりの行番号(ヘッダ行を1とする、利用者が表計算で見る番号と揃える)。 */
  line: number;
  message: string;
}

export type CsvParseResult =
  | { ok: true; rows: ShippingCsvRow[] }
  | { ok: false; errors: CsvParseError[] };

const VALID_RANKS = new Set<string>(["SS", "S", "A", "B", "C", "D", "E", "F", "G", "OVERSIZE"]);

/** ダブルクォートを含む値も扱える最小限のCSV分解。Excelの書き出し形式に合わせる。 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        // "" はエスケープされた1個の "
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.map((v) => v.trim());
}

function quote(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildShippingCsv(
  rows: {
    destinationPrefecture: string;
    destinationArea?: string | null;
    rank: string;
    price?: number | null;
    sourceReference?: string | null;
    updatedAt?: string | null;
  }[],
): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of rows) {
    lines.push(
      [
        quote(r.destinationPrefecture),
        quote(r.destinationArea ?? ""),
        quote(r.rank),
        // 配送不可(price無し)は空欄。0を書くと「無料」と読めてしまう。
        r.price === null || r.price === undefined ? "" : String(r.price),
        r.price === null || r.price === undefined ? "1" : "",
        quote(r.sourceReference ?? ""),
        quote(r.updatedAt ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/**
 * CSVを読む。1行でも問題があれば全体を拒否する。
 * 「最終更新日時」列は書き出しの参考情報なので読み飛ばす(入力しても無視)。
 */
export function parseShippingCsv(text: string): CsvParseResult {
  const errors: CsvParseError[] = [];
  const rows: ShippingCsvRow[] = [];

  const rawLines = String(text ?? "")
    .replace(/^﻿/, "") // Excelが付けるBOM
    .split(/\r?\n/);

  const nonEmpty = rawLines.map((l, i) => ({ line: i + 1, text: l })).filter((l) => l.text.trim().length > 0);
  if (nonEmpty.length === 0) return { ok: false, errors: [{ line: 1, message: "CSVが空です。" }] };

  const header = splitCsvLine(nonEmpty[0].text);
  const required = ["発送先都道府県", "ランク"];
  for (const col of required) {
    if (!header.includes(col)) {
      errors.push({ line: 1, message: `見出し行に「${col}」の列がありません。` });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const idx = (name: string) => header.indexOf(name);
  const seen = new Set<string>();

  for (const { line, text: raw } of nonEmpty.slice(1)) {
    const cells = splitCsvLine(raw);
    const prefecture = cells[idx("発送先都道府県")] ?? "";
    const rank = (cells[idx("ランク")] ?? "").toUpperCase();
    const area = idx("地域") >= 0 ? cells[idx("地域")] ?? "" : "";
    const priceRaw = idx("料金") >= 0 ? cells[idx("料金")] ?? "" : "";
    const unavailableRaw = idx("配送不可") >= 0 ? (cells[idx("配送不可")] ?? "").trim() : "";
    const note = idx("備考") >= 0 ? cells[idx("備考")] ?? "" : "";

    if (!prefecture) {
      errors.push({ line, message: "発送先都道府県が空です。" });
      continue;
    }
    if (!VALID_RANKS.has(rank)) {
      errors.push({ line, message: `ランク「${rank || "(空)"}」は使用できません(SS/S/A/B/C/D/E/F/G/OVERSIZE)。` });
      continue;
    }

    const key = `${prefecture}|${area}|${rank}`;
    if (seen.has(key)) {
      errors.push({ line, message: `同じ組合せ(${prefecture} ${area} ${rank})が複数行にあります。` });
      continue;
    }
    seen.add(key);

    const unavailable = unavailableRaw === "1" || unavailableRaw.toLowerCase() === "true" || unavailableRaw === "配送不可";

    let price: number | null = null;
    if (!unavailable) {
      if (priceRaw.trim() === "") {
        errors.push({ line, message: "料金が空です。配送不可の場合は「配送不可」列に1を入れてください。" });
        continue;
      }
      const parsed = Number(priceRaw.replace(/[,\s¥￥]/g, ""));
      if (!Number.isFinite(parsed) || parsed < 0) {
        errors.push({ line, message: `料金「${priceRaw}」を数値として読めません。` });
        continue;
      }
      if (!Number.isInteger(parsed)) {
        errors.push({ line, message: `料金「${priceRaw}」は整数で入力してください。` });
        continue;
      }
      price = parsed;
    } else if (priceRaw.trim() !== "") {
      // 配送不可なのに金額がある。どちらが正しいか決められないので拒否する。
      errors.push({ line, message: "配送不可の行に料金が入っています。どちらか一方にしてください。" });
      continue;
    }

    rows.push({
      destinationPrefecture: prefecture,
      destinationArea: area || null,
      rank: rank as ShippingRank,
      price,
      unavailable,
      sourceReference: note || null,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, rows };
}

/**
 * 取り込む行のうち、実際に値が変わるものだけを返す。
 *
 * 同じ値を書き直すと updatedAt と version だけが動いて履歴が汚れ、
 * 「いつ何が変わったのか」が追えなくなる。
 */
export function selectChangedRows(
  incoming: ShippingCsvRow[],
  existing: { destinationPrefecture: string; destinationArea: string | null; rank: string; price: number | null }[],
): ShippingCsvRow[] {
  const key = (p: string, a: string | null, r: string) => `${p}|${a ?? ""}|${r}`;
  const current = new Map(existing.map((e) => [key(e.destinationPrefecture, e.destinationArea, e.rank), e.price ?? null]));
  return incoming.filter((row) => {
    const k = key(row.destinationPrefecture, row.destinationArea, row.rank);
    if (!current.has(k)) return true; // 新しい組合せ
    return current.get(k) !== row.price;
  });
}
