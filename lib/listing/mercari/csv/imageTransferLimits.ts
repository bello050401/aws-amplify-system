/**
 * 画像まとめダウンロード(ZIP)の負荷上限・時間予算。
 *
 * task_f712cf24a9fe2308cd(2026-09-14): 旧実装はこれらの上限を
 * imageBundle.ts(server-only)の中だけに置いていたが、画像バイト自体の
 * 取得とZIP組み立てをブラウザ側(lib/listing/mercari/csv/browserImageZip.ts)
 * へ移した(理由はimageBundle.tsとbrowserImageZip.tsの冒頭コメント参照)
 * ため、同じ上限値をサーバー側(件数の事前拒否)とブラウザ側(バイト数・
 * 時間の実施)の両方が参照する必要がある。"server-only"を付けないのは
 * そのため——これは定数だけのファイルで外部I/Oを一切行わない。
 */
export const MAX_ZIP_PRODUCTS = 20;
export const MAX_ZIP_IMAGES = 100;
/** 1枚あたりのバイト上限。ブラウザ側がストリーム受信中にこの値を超えた時点で取得を中断する(全量を読み切ってから判定しない)。 */
export const MAX_ZIP_FILE_BYTES = 15 * 1024 * 1024; // 15MB
/** 合計バイト上限(ブラウザのメモリ上限、全画像の合計)。Amplify Hosting Web ComputeのHTTPレスポンス上限(5.72MB、後述)とは無関係——画像バイトはS3から直接ブラウザへ届き、こちらのSSR/Server Actionは経由しない。 */
export const MAX_ZIP_TOTAL_BYTES = 40 * 1024 * 1024; // 40MB

/**
 * 1枚あたりの取得タイムアウト(接続〜ストリーム読了まで全体)。
 * lib/http/fetchWithTimeout.tsは「応答ヘッダーが返るまで」しかカバー
 * しない(finallyでタイマーを止める設計——外部API呼び出し向けにはそれで
 * 十分だが、ここは大きいバイナリのストリーム読み取り自体が止まる/
 * 極端に遅いケースも中断したいため、専用に実装している——
 * browserImageZip.tsのコメント参照)。
 */
export const IMAGE_FETCH_TIMEOUT_MS = 30_000;
/** 選択商品群全体(最大20商品・100枚)の取得〜ZIP組み立てにかける時間予算。これを超えたら残りを中断し、取得済み分があっても部分成功のZIPは返さない。 */
export const ZIP_TOTAL_TIME_BUDGET_MS = 120_000;
/** 同時に取得する画像の最大数。ブラウザのメモリ・同時接続数の両方を有界にする。 */
export const ZIP_FETCH_CONCURRENCY = 4;
