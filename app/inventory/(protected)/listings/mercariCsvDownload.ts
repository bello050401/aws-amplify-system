import type { MercariCsvExportActionResult } from "@/app/actions/listing";

/** ListingsOverviewTable.tsxのCSV出力パネルが使う結果型(そのまま再エクスポート)。 */
export type MercariCsvExportOutcome = MercariCsvExportActionResult;

/**
 * Server Actionから受け取ったCP932バイト列(base64)を、そのままの
 * バイト列でブラウザにダウンロードさせる。
 *
 * `atob`でbase64→バイナリ文字列に戻し、1文字=1バイトとしてUint8Arrayへ
 * 詰め直す(TextEncoder等でUTF-8化するとCP932バイト列が壊れる)。
 * これによりexportCsv.tsが検証済みのバイト列(独立パーサでの再読込一致
 * まで確認済み)をそのままファイルへ渡せる。
 */
export function downloadCsvFromBase64(base64: string, filename: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
