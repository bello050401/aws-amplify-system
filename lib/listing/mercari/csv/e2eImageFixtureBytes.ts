/**
 * Mercari CSV画像受渡し(2026-09-14、P2レビュー修正/task_f712cf24a9fe2308cd是正)
 * のE2E専用フィクスチャ。
 *
 * 【なぜ必要か】画像まとめダウンロード(browserImageZip.ts)は**ブラウザが
 * 直接**署名URLへ`fetch()`して画像バイトそのものを読む(task_f712cf24a9fe2308cd
 * 是正——旧実装はサーバー側で`fetch(署名URL)`していたが、Amplify Hosting
 * の応答上限に抵触するため撤去した。lib/listing/mercari/csv/imageBundle.ts
 * のコメント参照)。lib/inventory/e2eFixtures.tsの`"e2e-fixture:"`接頭辞
 * (ブラウザ側のuseInventoryImageUrl.tsだけが解決する、クライアント限定
 * の合成URL)とは別に、**Playwrightが操作する実ブラウザが実際にHTTPで
 * 取得できるバイト列**が要る。実S3が無いこのsandboxでは、Next.js自身が
 * 配信するローカルRoute Handler(app/e2e-fixtures/mercari-image/[variant]/
 * route.ts)をfetch先にする——実ネットワーク・実AWSには一切到達しない
 * (同一オリジンなのでCORSの実配線検証にはならない点は完了報告に明記する)。
 *
 * 【純粋関数にしてある理由】この関数はRoute Handler(サーバー)と
 * Playwright specファイル(Node、ブラウザ外)の両方から個別にimportして
 * 呼ぶ。どちらも同じ入力から同じバイト列を独立に再現できることが
 * 「画像バイト一致」検証の前提(scripts/verify-mercari-csv-export.tsの
 * ZIPエントリCRC一致試験と同じ考え方——比較対象はモック関数の戻り値
 * ではなく、双方が独立に計算した実バイト列そのもの)。
 */

export const MERCARI_IMG_E2E_PREFIX = "e2e-mercari-img:";

/** storageKeyの残り(接頭辞を除いた部分)を「実際にHTTPで取得を試みる」対象として扱ってよいかどうか。 */
export function isMercariImgE2EKey(storageKey: string): boolean {
  return storageKey.startsWith(MERCARI_IMG_E2E_PREFIX);
}

export function mercariImgE2EVariant(storageKey: string): string {
  return storageKey.slice(MERCARI_IMG_E2E_PREFIX.length);
}

/**
 * 取得そのものが失敗すべきvariant名の一覧。imageBundle.tsの
 * `fetched.ok`判定にそのまま乗る(理由の文言はHTTPステータスのみ由来
 * ——403の中で「期限切れ」と「権限なし」を区別する追加情報は現状の
 * 実装に無い、既知の粒度上の限界。完了報告にそのまま明記する)。
 */
export const MERCARI_IMG_E2E_FAILURE_STATUS: Record<string, number> = {
  expired: 403, // 署名URL期限切れの模擬(実運用のgetInventoryImageDownloadUrlは1時間有効——期限切れると同じ403系)
  forbidden: 403, // 権限なし(対象storageKeyに対するIAM/バケットポリシー拒否)の模擬
  missing: 404, // 削除済み/存在しないオブジェクトの模擬
};

/**
 * MAX_ZIP_FILE_BYTES(imageTransferLimits.ts)を意図的に1MB超える長さ。
 * "toolarge" variant専用——ブラウザ側(browserImageZip.ts)がストリーム
 * 受信中に1枚あたりの上限超過を検出して打ち切ることを、実ブラウザ・
 * 実ダウンロードイベントで検証する(task_f712cf24a9fe2308cd、2026-09-14是正)。
 */
const TOO_LARGE_VARIANT_BYTES = 16 * 1024 * 1024;

/**
 * variant名から決定的なバイト列を生成する(サーバー・テスト双方が
 * 同じ入力から独立に計算する——ネットワーク越しに転送されたバイト列
 * 自体を比較することで「表示だけでなく実バイトが一致する」ことを保証する)。
 * 内容に意味は無い——variant名をUTF-8化して指定長まで繰り返すだけ。
 * variantごとに長さを変えているのは、異なる画像が偶然同じバイト列に
 * ならないようにするため(コピー漏れ/誤配線があれば長さの不一致でも検出できる)。
 */
export function mercariImgFixtureBytes(variant: string): Uint8Array {
  const seed = Buffer.from(`bello-e2e-mercari-image:${variant}`, "utf8");
  // 200 + variant文字列長*7 バイト程度の適当な長さ(実画像よりずっと小さいが、
  // 0バイト・1バイトの退化ケースを避けるための下限を持たせてある)。
  // "toolarge"だけは例外——1枚あたりの上限超過を実ブラウザで検証するため、
  // 意図的に上限(15MB)を超える固定長にする。
  const length = variant === "toolarge" ? TOO_LARGE_VARIANT_BYTES : 200 + seed.length * 7;
  const out = Buffer.alloc(length);
  for (let i = 0; i < length; i++) out[i] = seed[i % seed.length];
  return out;
}
