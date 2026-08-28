#!/usr/bin/env node
/**
 * ZAICO API 検証スクリプト（単一在庫のみ・本番移行ロジックなし）
 * ---------------------------------------------------------------
 * 目的:
 *   ZAICO在庫ID → ZAICO API → 商品画像情報取得 が可能かどうかを検証する。
 *   併せて GET /api/v1/inventory_attachments/{id} を呼び出し、複数画像・
 *   画像以外の添付ファイルが取得できるか、item_image.url との同一性も確認する。
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
import { createHash } from "node:crypto";

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
  return downloadUrl(url, destPath, null);
}

/**
 * URLの実ファイルダウンロードを試みる。
 * まず認証ヘッダなしで取得を試み(=公開URLかどうかの確認)、失敗した場合のみ
 * Bearer認証付きで再試行する(そのURLが認証必須かどうかを区別するため)。
 */
async function downloadUrl(url, destPath, token) {
  try {
    const unauthRes = await fetch(url);
    let res = unauthRes;
    let requiredAuth = false;

    if (!unauthRes.ok && token) {
      const authRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (authRes.ok) {
        res = authRes;
        requiredAuth = true;
      }
    }

    if (!res.ok) {
      return {
        attempted: true,
        unauthenticatedAccessOk: false,
        requiredAuth: false,
        status: res.status,
      };
    }

    const buf = Buffer.from(await res.arrayBuffer());
    await writeFile(destPath, buf);
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return {
      attempted: true,
      unauthenticatedAccessOk: !requiredAuth,
      requiredAuth,
      status: res.status,
      contentType: res.headers.get("content-type"),
      byteLength: buf.byteLength,
      sha256,
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
    attachments: null,
    itemImageVsAttachmentsComparison: null,
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

  // --- 添付ファイル一覧 (GET /api/v1/inventory_attachments/{id}) ---
  // 複数画像・画像以外の添付ファイルがすべて取得できるかを確認する。
  const MAX_ATTACHMENTS_TO_DOWNLOAD = 20; // 単一在庫の検証なので十分な上限
  const attachmentsResp = await callEndpoint(
    "v1 inventory_attachments",
    `https://web.zaico.co.jp/api/v1/inventory_attachments/${INVENTORY_ID}`,
    token
  );
  report.attachments = { response: attachmentsResp, items: [] };

  console.log(`\n[attachments] ${attachmentsResp.url}`);
  console.log(`[attachments] HTTP ${attachmentsResp.status ?? "N/A"} (${attachmentsResp.elapsedMs ?? "-"}ms) ok=${attachmentsResp.ok}`);
  if (attachmentsResp.error) console.log(`[attachments] エラー: ${attachmentsResp.error}`);

  let attachmentList = [];
  if (attachmentsResp.ok && attachmentsResp.json) {
    if (Array.isArray(attachmentsResp.json)) {
      attachmentList = attachmentsResp.json;
    } else if (typeof attachmentsResp.json === "object") {
      // レスポンスが {inventory_attachments: [...]} 等でラップされている場合に対応
      const arrayProp = Object.values(attachmentsResp.json).find((v) => Array.isArray(v));
      attachmentList = arrayProp || [];
    }
  }
  console.log(`[attachments] 添付件数: ${attachmentList.length}`);

  for (const [idx, att] of attachmentList.entries()) {
    const url = att.url || att.file_url || att.download_url || null;
    const filename = att.original_filename || att.filename || att.name || null;
    console.log(`\n  [attachment #${idx + 1}]`);
    console.log(`    id: ${att.id ?? "(なし)"}`);
    console.log(`    original_filename: ${filename ?? "(なし)"}`);
    console.log(`    url: ${url ?? "(なし)"}`);
    console.log(`    created_at: ${att.created_at ?? "(なし)"}`);
    console.log(`    (レスポンスの全キー: ${Object.keys(att).join(", ")})`);

    const entry = { index: idx, raw: att, download: null };

    if (url && idx < MAX_ATTACHMENTS_TO_DOWNLOAD) {
      const ext = (filename && filename.match(/\.[a-zA-Z0-9]+$/)?.[0]) ||
        (url.match(/\.(png|jpe?g|gif|webp|bmp|pdf|zip|csv)(\?|$)/i)?.[0]?.replace(/\?.*$/, "")) ||
        ".bin";
      const destPath = path.join(OUTPUT_DIR, `inventory-${INVENTORY_ID}-attachment-${idx + 1}${ext}`);
      entry.download = await downloadUrl(url, destPath, token);
      console.log(`    ダウンロード結果:`, entry.download);
    } else if (!url) {
      console.log(`    -> urlフィールドが見つからないため、ダウンロードをスキップしました。`);
    }

    report.attachments.items.push(entry);
  }

  // item_image.url と inventory_attachments 先頭要素が同一画像かを比較
  const itemImageUrl = primary?.json?.item_image?.url || null;
  report.itemImageVsAttachmentsComparison = null;
  if (itemImageUrl) {
    const itemImageHashDl = report.imageDownload?.sha256 || null;
    const firstAttachmentHash = report.attachments.items[0]?.download?.sha256 || null;
    const firstAttachmentUrl = report.attachments.items[0]?.raw?.url || null;

    const comparison = {
      itemImageUrl,
      firstAttachmentUrl,
      urlsMatchExactly: firstAttachmentUrl === itemImageUrl,
      itemImageSha256: itemImageHashDl,
      firstAttachmentSha256: firstAttachmentHash,
      sameImageBytes:
        itemImageHashDl && firstAttachmentHash ? itemImageHashDl === firstAttachmentHash : null,
    };
    report.itemImageVsAttachmentsComparison = comparison;
    console.log(`\n[item_image vs inventory_attachments[0]] 比較結果:`, comparison);
  } else {
    console.log(`\n[item_image vs inventory_attachments[0]] item_image.url が見つからないため比較をスキップしました。`);
  }

  // 添付ファイルの内訳(画像 / 非画像)
  const contentTypes = report.attachments.items
    .map((e) => e.download?.contentType)
    .filter(Boolean);
  const nonImageTypes = contentTypes.filter((ct) => !/^image\//i.test(ct));
  console.log(`\n[添付ファイル内訳] 合計${report.attachments.items.length}件 / Content-Type取得できた${contentTypes.length}件中、画像以外: ${nonImageTypes.length}件`);
  if (nonImageTypes.length) console.log(`  非画像Content-Type: ${[...new Set(nonImageTypes)].join(", ")}`);

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
