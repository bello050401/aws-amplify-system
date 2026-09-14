/**
 * `serialize.ts`とは別ロジックで書いた、検証専用の独立CSVパーサ。
 *
 * 「CP932/BOMなし、原本に合わせLF...独立CSVパーサで再読込して元値一致
 * を検証」という要件のためのもの——`serialize.ts`のクオート処理に
 * バグがあっても、同じコードで読み返したのでは検出できないため、
 * ここでは文字単位の状態機械を独立に実装する。CP932デコード後の
 * 文字列(JS string)を対象とする。LF区切りを前提とするが、セル内の
 * CRLF/LF(クオート済みの改行)も読めるようにしてある。
 */
export function parseCsvIndependent(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    row = [];
  };

  while (i < len) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endCell();
      i += 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    if (ch === "\r") {
      // CRLFのCRは無視(LFで行確定)。単独CRはそのまま次の文字へ委ねる。
      if (text[i + 1] === "\n") {
        i += 1;
        continue;
      }
      endRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }

  // 末尾に未確定セル/行があれば確定する(最終行の後ろに改行が無い場合)。
  if (cell.length > 0 || row.length > 0) {
    endRow();
  }

  // buildCsvTextは末尾に必ず"\n"を付けるため、最後に空行が1つ残ることが
  // ある(例: "a,b\n" → ["a","b"], [""])。その空行だけは捨てる。
  if (rows.length > 0) {
    const last = rows[rows.length - 1];
    if (last.length === 1 && last[0] === "") {
      rows.pop();
    }
  }

  return rows;
}
