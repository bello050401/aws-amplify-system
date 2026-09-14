import { encodeCp932Strict } from "./cp932";

/**
 * RFC4180準拠のセルクオート。カンマ・改行(LF/CR)・二重引用符を含む場合
 * のみクオートし、二重引用符は`""`に二重化する。数式起点文字
 * (`=`,`+`,`-`,`@`,タブ,CR)は「クオートだけではExcel対策にならない」
 * ため、ここでは変更せず`validate.ts`側で警告/明示修正の対象にする
 * (商品文言を黙って変えないという指示のため)。
 */
export function csvQuoteCell(value: string): string {
  const needsQuote = /[",\n\r]/.test(value);
  if (!needsQuote) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** ヘッダー+データ行からCSVテキスト(LF区切り)を組み立てる。 */
export function buildCsvText(header: readonly string[], rows: readonly string[][]): string {
  const lines = [header, ...rows].map((cols) => cols.map(csvQuoteCell).join(","));
  return lines.join("\n") + "\n";
}

export interface CsvEncodeError {
  /** 0 = ヘッダー行、1以降 = データ行(1始まり)。 */
  rowIndex: number;
  columnIndex: number;
  columnName: string;
  invalidChar: string;
  charIndex: number;
}

export interface CsvEncodeSuccess {
  ok: true;
  buffer: Buffer;
  text: string;
}

export interface CsvEncodeFailure {
  ok: false;
  errors: CsvEncodeError[];
}

/**
 * ヘッダー+行をCP932バイト列へエンコードする。1セルでも表現不能文字が
 * あれば、その位置と文字を全て集めて停止する(黙った?置換/削除はしない)。
 */
export function encodeMercariCsv(header: readonly string[], rows: readonly string[][]): CsvEncodeSuccess | CsvEncodeFailure {
  const errors: CsvEncodeError[] = [];
  const allRows = [header, ...rows];
  allRows.forEach((cols, rowIndex) => {
    cols.forEach((cell, columnIndex) => {
      const result = encodeCp932Strict(cell);
      if (!result.ok) {
        errors.push({
          rowIndex,
          columnIndex,
          columnName: header[columnIndex] ?? `column_${columnIndex}`,
          invalidChar: result.invalidChar,
          charIndex: result.charIndex,
        });
      }
    });
  });
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  const text = buildCsvText(header, rows);
  const encoded = encodeCp932Strict(text);
  if (!encoded.ok) {
    // buildCsvTextはセル単位で既にOKだったものを連結しただけなので
    // ここに来るのは理論上ない。保険として一件だけ返す。
    return {
      ok: false,
      errors: [
        {
          rowIndex: -1,
          columnIndex: -1,
          columnName: "(joined text)",
          invalidChar: encoded.invalidChar,
          charIndex: encoded.charIndex,
        },
      ],
    };
  }
  return { ok: true, buffer: encoded.buffer, text };
}
