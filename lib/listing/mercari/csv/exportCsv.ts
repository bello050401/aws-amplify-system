import { loadMercariCsvHeader, isHeaderVerified, MERCARI_CSV_COLUMN_COUNT } from "./header";
import { validateMercariCsvRow } from "./validate";
import { mapRowToCells } from "./mapRowToCells";
import { encodeMercariCsv } from "./serialize";
import { decodeCp932 } from "./cp932";
import { parseCsvIndependent } from "./independentParse";
import type { MercariCsvRowFields, MercariCsvRowValidation } from "./types";

export const MAX_EXPORT_ROWS = 10000;

export interface MercariCsvExportBlockedRow {
  inventoryId: string;
  displayId: string;
  reasons: string[];
}

export interface MercariCsvExportResult {
  ok: boolean;
  requestedCount: number;
  outputCount: number;
  headerSource: "official-file" | "fallback-reconstruction";
  headerVerified: boolean;
  /** ok=falseの理由。重大エラー行を黙って除外して成功扱いにはしない。 */
  blockedRows: MercariCsvExportBlockedRow[];
  /** エンコード段(CP932表現不能文字)の失敗。 */
  encodingErrors?: string[];
  csv?: {
    buffer: Buffer;
    text: string;
    filename: string;
  };
}

function reasonsFromValidation(validation: MercariCsvRowValidation): string[] {
  return validation.errors.map((e) => `[${String(e.field)}] ${e.message}`);
}

/**
 * 選択された行(MercariCsvRowFields[])からMercari Shops CSVを生成する。
 * - 0件/10000件超はエラー(呼び出し側で件数チェック後にここへ渡す想定
 *   だが、二重チェックとしてここでも弾く)。
 * - 1行でも重大エラーがあれば`ok:false`で全体を止める(部分成功で
 *   ダウンロードさせない)。
 * - 生成できた場合も、独立パーサで再読込し元セル値と一致するか検証
 *   してから返す(不一致ならok:falseにする——ここに来ること自体が
 *   serialize.tsのバグを意味する)。
 */
export function buildMercariCsvExport(rows: MercariCsvRowFields[]): MercariCsvExportResult {
  const header = loadMercariCsvHeader();
  const headerVerified = isHeaderVerified(header);

  // header.tsの設計コメント通り、原本(product_import_template.csv)が
  // 読めていない環境では列名/列順を捏造したfallbackしか無く、実際の
  // Mercari取込へ使えるCSVを生成してはならない(「本番CSV生成は
  // official-fileが無い限りブロックする」)。
  if (!headerVerified) {
    return {
      ok: false,
      requestedCount: rows.length,
      outputCount: 0,
      headerSource: header.source,
      headerVerified,
      blockedRows: [],
      encodingErrors: [
        "原本ヘッダー(data/mercari-masters/product_import_template.csv)が読み込めないため、CSV生成をブロックしています。再構成ヘッダーは列名を捏造した保険であり、そのまま出力すると実際のMercari取込形式と一致しない可能性があります。",
      ],
    };
  }

  if (rows.length === 0) {
    return {
      ok: false,
      requestedCount: 0,
      outputCount: 0,
      headerSource: header.source,
      headerVerified,
      blockedRows: [],
      encodingErrors: ["対象商品が0件です。1件以上選択してください"],
    };
  }
  if (rows.length > MAX_EXPORT_ROWS) {
    return {
      ok: false,
      requestedCount: rows.length,
      outputCount: 0,
      headerSource: header.source,
      headerVerified,
      blockedRows: [],
      encodingErrors: [`一度に生成できるのは最大${MAX_EXPORT_ROWS}商品です(選択${rows.length}件)`],
    };
  }

  const blockedRows: MercariCsvExportBlockedRow[] = [];
  for (const fields of rows) {
    const validation = validateMercariCsvRow(fields);
    if (!validation.ok) {
      blockedRows.push({
        inventoryId: fields.inventoryId,
        displayId: fields.displayId,
        reasons: reasonsFromValidation(validation),
      });
    }
  }

  if (blockedRows.length > 0) {
    return {
      ok: false,
      requestedCount: rows.length,
      outputCount: 0,
      headerSource: header.source,
      headerVerified,
      blockedRows,
    };
  }

  const cellRows = rows.map(mapRowToCells);
  cellRows.forEach((cells, idx) => {
    if (cells.length !== MERCARI_CSV_COLUMN_COUNT) {
      throw new Error(
        `internal error: row ${idx} (${rows[idx]?.inventoryId}) produced ${cells.length} cells, expected ${MERCARI_CSV_COLUMN_COUNT}`,
      );
    }
  });

  const encoded = encodeMercariCsv(header.columns, cellRows);
  if (!encoded.ok) {
    return {
      ok: false,
      requestedCount: rows.length,
      outputCount: 0,
      headerSource: header.source,
      headerVerified,
      blockedRows: [],
      encodingErrors: encoded.errors.map(
        (e) =>
          `行${e.rowIndex}列「${e.columnName}」の${e.charIndex}文字目 "${e.invalidChar}" はCP932で表現できません`,
      ),
    };
  }

  // 独立パーサでの再読込検証。
  const roundTripText = decodeCp932(encoded.buffer);
  const reparsed = parseCsvIndependent(roundTripText);
  const expected = [Array.from(header.columns), ...cellRows];
  const matches =
    reparsed.length === expected.length && reparsed.every((row, i) => row.length === expected[i].length && row.every((cell, j) => cell === expected[i][j]));
  if (!matches) {
    return {
      ok: false,
      requestedCount: rows.length,
      outputCount: 0,
      headerSource: header.source,
      headerVerified,
      blockedRows: [],
      encodingErrors: ["独立CSVパーサでの再読込結果が元の値と一致しませんでした(生成ロジックの不具合の可能性)"],
    };
  }

  const filename = `mercari_shops_import_${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  return {
    ok: true,
    requestedCount: rows.length,
    outputCount: rows.length,
    headerSource: header.source,
    headerVerified,
    blockedRows: [],
    csv: { buffer: encoded.buffer, text: encoded.text, filename },
  };
}
