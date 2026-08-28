/**
 * Small, dependency-free RFC4180-ish CSV reader/writer — hand-rolled
 * rather than pulling in a library, since correct CSV quoting/escaping
 * (commas, quotes, and embedded newlines inside a Japanese 備考/管理メ
 * モ field are all realistic here) is a genuinely small amount of code,
 * and the only external dependency this import/export feature actually
 * needs is exceljs, for the one format (.xlsx) plain text truly can't
 * express. Not `server-only` — pure string processing, no Amplify/Data
 * access, usable from either side if ever needed.
 */

/** `,` `"` or a newline anywhere in the value forces quoting; an embedded `"` is doubled per RFC4180. */
export function csvEscapeCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function toCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(csvEscapeCell).join(",")];
  for (const row of rows) lines.push(row.map(csvEscapeCell).join(","));
  // ﻿ (UTF-8 BOM): without it, Excel on Windows — by far the most
  // common opener for a downloaded .csv — guesses a non-UTF-8 encoding
  // for a file with no BOM and renders every Japanese character as
  // mojibake. \r\n line endings match what Excel itself writes.
  return `﻿${lines.join("\r\n")}`;
}

/**
 * Parses one full CSV text into rows of cells, honoring RFC4180 quoting
 * (a quoted field can contain commas/newlines; `""` inside a quoted
 * field is a literal `"`). Strips a leading BOM if present (a file this
 * app itself exported, or many others', will have one). A trailing
 * empty line (common after a spreadsheet app's own export) is dropped
 * rather than surfacing as a bogus final all-blank row.
 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;

  function endCell() {
    row.push(cell);
    cell = "";
  }
  function endRow() {
    endCell();
    rows.push(row);
    row = [];
  }

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
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
    if (ch === "\r") {
      // Bare \r or \r\n — either way, one row boundary; skip a following \n.
      endRow();
      i += src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    if (ch === "\n") {
      endRow();
      i += 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  // Final row: only flush if anything was actually accumulated (a file
  // ending in a newline must not produce one spurious empty trailing row).
  if (cell !== "" || row.length > 0) endRow();

  return rows;
}
