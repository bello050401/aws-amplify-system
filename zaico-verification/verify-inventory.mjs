#!/usr/bin/env node
/**
 * ZAICO API 検証スクリプト（単一在庫のみ・本番移行ロジックなし）
 * ---------------------------------------------------------------
 * 目的:
 *   ZAICO在庫ID → ZAICO API → 商品画像情報取得 が可能かどうかを検証する。
 *   実データの一括取得・BELLO側への書き込みは一切行わない（読み取り専用）。
 *
 * トークンの扱い:
 *   - このスクリプトはトークンを一切ログ出力しない。
 *   - 優先順位: 環境変数 ZAICO_API_TOKEN > リポジトリ直下の .env.local の
 *     ZAICO_API_TOKEN= 行。どちらにも無ければエラーで停止し、設定方法を案内する。
 *   - .env.local は .gitignore 済み（本リポジトリのルートに設定済み）。
 *
 * 使い方 (Windows PowerShell / ローカル Claude Code CLI 側):
 *   node zaico-verification/verify-inventory.mjs 73638418
 *   # 第1引数省略時は 73638418 を使用
 *
 * 出力:
 *   - コンソールに検証サマリーを表示
 *   - 生レスポンス(トークン等の機微情報を除く)を
 *     zaico-verification/output/inventory-<ID>.json に保存(.gitignore対象)
 *   - 画像が取得できた場合、同ディレクトリに画像ファイルも保存(.gitignore対象)
 */

import { writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const OUTPUT_DIR = path.join(__dirname, "output");

const INVENTORY_ID = process.argv[2] || "73638418";

// ---------------------------------------------------------------------------
// トークン取得（環境変数 → .env.local の順。値は絶対にログに出さない）
// ---------------------------------------------------------------------------
async function resolveToken() {
  if (process.env.ZAICO_API_TOKEN && process.env.ZAICO_API_TOKEN.trim()) {
    return { token: process.env.ZAICO_API_TOKEN.trim(), source: "環境変数 ZAICO_API_TOKEN" };
  }

  const envLocalPath = path.join(REPO_ROOT, ".env.local");
  if (existsSync(envLocalPath)) {
    const content = await readFile(envLocalPath, "utf8");
    for (const line of content.split("\n")) {
      const m = line.match(/^\s*ZAICO_API_TOKEN\s*=\s*(.+?)\s*$/);
      if (m) {
        let value = m[1];
        // クォート囲みを除去
        value = value.replace(/^["']|["']$/g, "");
        if (value) return { token: value, source: ".env.local の ZAICO_API_TOKEN" };
      }
    }
  }

  return { token: null, source: null };
}

function printSetupGuidance() {
  console.log(`
ZAICO_API_TOKEN が見つかりませんでした。

【ローカル(Windows PowerShell)に既に設定済みの場合】
  - PowerShellプロファイルやシステム環境変数に ZAICO_API_TOKEN を
    設定済みであれば、新しいPowerShellウィンドウ/ターミナルを開き直してから
    再実行してください（現在のセッションに反映されていない可能性があります）。

【まだ設定していない場合のみ】以下のいずれかを実行してください。

  1) このターミナルセッションだけに一時設定する場合:
     $env:ZAICO_API_TOKEN = "ここにご自身のZAICOトークンを貼り付け"
     node zaico-verification/verify-inventory.mjs ${INVENTORY_ID}

  2) 永続的にWindowsユーザー環境変数として設定する場合(要ターミナル再起動):
     [System.Environment]::SetEnvironmentVariable("ZAICO_API_TOKEN", "ここにご自身のZAICOトークンを貼り付け", "User")

  3) .env.local を使う場合(リポジトリ直下、.gitignore対象であることは設定済み):
     "ZAICO_API_TOKEN=ここにご自身のZAICOトークンを貼り付け" | Out-File -FilePath .env.local -Encoding utf8 -Append

  ※ トークンは上記コマンドのプレースホルダー部分をご自身の手元で置き換えて
     実行してください。トークンの値自体をClaude Codeのチャットに貼り付ける
     必要はありません。
`);
}

// ---------------------------------------------------------------------------
// 画像/添付ファイルらしいフィールドを再帰的に探索
// ---------------------------------------------------------------------------
const IMAGE_KEY_RE = /image|photo|thumbnail|attachment|file|picture/i;
const URL_RE = /^https?:\/\//i;

function findImageLikeFields(obj, pathPrefix = "", results = []) {
  if (obj === null || obj === undefined) return results;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findImageLikeFields(v, `${pathPrefix}[${i}]`, results));
    return results;
  }
  if (typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (IMAGE_KEY_RE.test(key)) {
        results.push({ path: fullPath, key, value });
      }
      findImageLikeFields(value, fullPath, results);
    }
    return results;
  }
  if (typeof obj === "string" && URL_RE.test(obj) && /\.(png|jpe?g|gif|webp|bmp)(\?|$)/i.test(obj)) {
    results.push({ path: pathPrefix, key: "(url-shaped string)", value: obj });
  }
  return results;
}

function collectUrls(fields) {
  const urls = new Set();
  for (const f of fields) {
    if (typeof f.value === "string" && URL_RE.test(f.value)) urls.add(f.value);
    if (f.value && typeof f.value === "object") {
      for (const v of Object.values(f.value)) {
        if (typeof v === "string" && URL_RE.test(v)) urls.add(v);
      }
    }
  }
  return [...urls];
}

// ---------------------------------------------------------------------------
// API呼び出し
// ---------------------------------------------------------------------------
async function callEndpoint(label, url, token) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    const elapsedMs = Date.now() - started;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }

    const rateHeaders = {};
    for (const [k, v] of res.headers.entries()) {
      if (/rate|retry|limit/i.test(k)) rateHeaders[k] = v;
    }

    return {
      label,
      url,
      ok: res.ok,
      status: res.status,
      elapsedMs,
      rateHeaders,
      json,
      rawTextSnippet: json ? null : text.slice(0, 500),
    };
  } catch (err) {
    return { label, url, ok: false, status: null, error: String(err) };
  }
}

async function tryDownloadImage(url, destPath) {
  try {
    const res = await fetch(url); // 認証ヘッダなしで取得できるか(=公開URLかどうか)を確認
    if (!res.ok) {
      return { attempted: true, unauthenticatedAccessOk: false, status: res.status };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
    return {
      attempted: true,
      unauthenticatedAccessOk: true,
      status: res.status,
      contentType: res.headers.get("content-type"),
      byteLength: buf.byteLength,
      savedTo: destPath,
    };
  } catch (err) {
    return { attempted: true, unauthenticatedAccessOk: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n=== ZAICO API 検証: 在庫ID ${INVENTORY_ID} ===\n`);

  const { token, source } = await resolveToken();
  if (!token) {
    printSetupGuidance();
    process.exitCode = 1;
    return;
  }
  console.log(`[OK] トークンを取得しました (取得元: ${source})。値はログに出力しません。\n`);

  await mkdir(OUTPUT_DIR, { recursive: true });

  const report = {
    inventoryId: INVENTORY_ID,
    v1: null,
    v2: null,
    imageFields: [],
    imageDownload: null,
    timestamp: new Date().toISOString(),
  };

  // --- v1 (確認済み仕様: GET /api/v1/inventories/{id}, Bearer認証) ---
  const v1 = await callEndpoint(
    "v1 single inventory",
    `https://web.zaico.co.jp/api/v1/inventories/${INVENTORY_ID}`,
    token
  );
  report.v1 = v1;

  console.log(`[v1] ${v1.url}`);
  console.log(`[v1] HTTP ${v1.status ?? "N/A"} (${v1.elapsedMs ?? "-"}ms) ok=${v1.ok}`);
  if (v1.rateHeaders && Object.keys(v1.rateHeaders).length) {
    console.log(`[v1] レート関連ヘッダー:`, v1.rateHeaders);
  }
  if (v1.error) console.log(`[v1] エラー: ${v1.error}`);

  // --- v2 (ベストエフォート: 公式ドキュメントを直接参照できなかったため、
  //          複数の候補エンドポイントを試す。ネットワーク制限のため本セッションでは
  //          事前にv2の正式仕様を確認できていない。実行結果を見て要確認。) ---
  const v2Candidates = [
    `https://web.zaico.co.jp/api/v2/inventories/${INVENTORY_ID}`,
    `https://api.zaico.co.jp/v2/inventories/${INVENTORY_ID}`,
  ];
  for (const candidate of v2Candidates) {
    const attempt = await callEndpoint("v2 candidate", candidate, token);
    console.log(`[v2 candidate] ${candidate} -> HTTP ${attempt.status ?? "N/A"} (${attempt.error ?? "no error"})`);
    if (attempt.ok) {
      report.v2 = attempt;
      break;
    } else if (!report.v2) {
      report.v2 = attempt; // 最後の失敗結果を記録(全滅した場合の記録用)
    }
  }

  // --- 画像フィールド探索(v1が成功していればv1、なければv2を対象) ---
  const primary = v1.ok && v1.json ? v1 : report.v2 && report.v2.ok ? report.v2 : null;
  if (primary && primary.json) {
    report.imageFields = findImageLikeFields(primary.json);
    console.log(`\n[画像関連フィールド] ${report.imageFields.length} 件検出 (対象: ${primary.label})`);
    for (const f of report.imageFields) {
      const preview =
        typeof f.value === "string" ? f.value : JSON.stringify(f.value).slice(0, 200);
      console.log(`  - ${f.path}: ${preview}`);
    }

    const urls = collectUrls(report.imageFields);
    if (urls.length) {
      console.log(`\n[画像URL候補] ${urls.length} 件`);
      urls.forEach((u) => console.log(`  - ${u}`));

      const firstUrl = urls[0];
      const ext = (firstUrl.match(/\.(png|jpe?g|gif|webp|bmp)(\?|$)/i) || [, "bin"])[1];
      const destPath = path.join(OUTPUT_DIR, `inventory-${INVENTORY_ID}-image-1.${ext}`);
      console.log(`\n[画像ダウンロード試行] ${firstUrl}`);
      report.imageDownload = await tryDownloadImage(firstUrl, destPath);
      console.log(`[画像ダウンロード結果]`, report.imageDownload);
    } else {
      console.log(`\n[画像URL候補] 0件(URL形式の値が見つかりませんでした)`);
    }
  } else {
    console.log(`\n[画像関連フィールド] 取得成功したレスポンスが無いため探索をスキップしました。`);
  }

  // --- 生データ保存(トークンは含まれない。business dataのため.gitignore対象) ---
  const outFile = path.join(OUTPUT_DIR, `inventory-${INVENTORY_ID}.json`);
  await writeFile(outFile, JSON.stringify(report, null, 2), "utf8");
  console.log(`\n[保存] 検証結果を ${path.relative(REPO_ROOT, outFile)} に保存しました(.gitignore対象、Gitには含まれません)。`);

  console.log(`\n=== 検証完了 ===\n`);
}

main().catch((err) => {
  console.error("予期しないエラー:", err);
  process.exitCode = 1;
});
