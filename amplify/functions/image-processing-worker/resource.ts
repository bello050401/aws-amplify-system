import { defineFunction } from "@aws-amplify/backend";

/**
 * BELLO画像自動加工システム(2026-08-30指示書)§14 AWSバックグラウンド
 * 処理。amplify/functions/pricing-scheduler/resource.tsで確立した
 * 「defineFunction({schedule})によるEventBridge Scheduler連携 +
 * backend.data.resources.tablesによるIAM直接付与」パターンをそのまま
 * 再利用する(§9指示書の同一の再調査結果に基づく——今回はさらに
 * S3(backend.storage.resources.bucket、@aws-amplify/backend-storageの
 * IBucket型で実在確認済み)への読み書きも必要)。
 *
 * 【スコープ、正直に】このLambdaはProcessingJob(PENDING行)をScanし、
 * 1件ずつsharpProcessor.tsの決定論的処理(crop/resize/tone補正/
 * format変換)のみを実行する。§5(実画像PoC)が要求する被写体
 * segmentation・床クリーニング・RAW現像は実装していない
 * (lib/imageProcessing/types.tsのコメント参照、実画像テストセットが
 * このサンドボックスに無いためSPEC_UNCONFIRMED)——「対応したふり」を
 * しない。
 *
 * timeoutSecondsをpricing-scheduler(60秒)より長くしているのは、
 * 複数枚のsharp処理(resize×3種類のバッファ生成+S3 GET/PUT)が
 * 商品1件あたり数秒かかり得るため——ジョブ1件ずつの処理なので
 * Lambda自体の最大実行時間内に収まるジョブ件数だけを1回の起動で
 * 処理し、余りは次のスケジュール実行(5分毎)へ回す設計
 * (handler.tsのmaxJobsPerRun参照)。
 */
export const imageProcessingWorker = defineFunction({
  name: "image-processing-worker",
  entry: "./handler.ts",
  timeoutSeconds: 300,
  memoryMB: 1024, // sharpのRAW→複数導出バッファ生成はデフォルト128MBでは不足するため引き上げ(pricing-schedulerはJSONのみを扱うため既定値のままだったのと対照的)
  schedule: "every 5m",
});
