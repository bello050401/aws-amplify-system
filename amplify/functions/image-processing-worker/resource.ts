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
  // dataスタックへ移す理由はpricing-scheduler/resource.tsの同じ位置の
  // コメントを参照(data ⇄ function のネストスタック循環依存の根本修正)。
  // このLambdaもProcessingJob/ImageProcessingVersion/PhotoProfile/
  // Inventoryの各テーブルをbackend.tsからgrantされている。
  resourceGroupName: "data",
  // ── sharpがLambda上で一切ロードできなかった問題の修正 ────────────────
  // このLambdaが史上初めて実際にデプロイされた直後(build job#65)、
  // 5分ごとのスケジュール起動が毎回INITで即死していた(CloudWatchで確認、
  // 5回起動して5回ともRuntime.Unknown):
  //   Error: Could not load the "sharp" module using the linux-x64 runtime
  //     at file:///var/task/index.mjs:60:239185
  // スタックの位置が示すとおり、sharpはesbuildによってindex.mjsへインラ
  // イン展開されていた。sharpはネイティブアドオン(@img/sharp-linux-x64
  // の .node バイナリ)を必要とするため、JSだけをバンドルへ畳み込んでも
  // 実行時に必ず失敗する——バンドラで解決できる類の問題ではない。
  //
  // 修正: sharpをバンドルから外し、Lambdaレイヤーで供給する。Amplify
  // Gen2はこの2つを`layers`プロパティ1つで同時に行う——
  // @aws-amplify/backend-function/lib/factory.jsが
  // `externalModules: Object.keys(props.layers)`としてesbuildへ渡すため、
  // ここにキー`sharp`を書くこと自体が「sharpをexternalにする」指示に
  // なり、値のレイヤーが実体を/opt/nodejs/node_modules/sharpへ供給する。
  //
  // 値がフルARNではなく`name:version`形式なのは意図的:
  // FunctionLayerArnParserがデプロイ先スタック自身のregion/accountを
  // 使ってARNを組み立てるため、アカウントやリージョンをこのファイルへ
  // ハードコードせずに済む。
  //
  // レイヤーの実体はscripts/aws-setup/9-publish-sharp-layer.ps1が作成・
  // 発行する(sharpのバージョンはpackage.jsonと一致させること)。この
  // レイヤーはCDK管理外の前提リソースなので、新しいAWSアカウント/
  // リージョンへ初めてデプロイする際は、そのスクリプトを先に実行する
  // 必要がある——READMEの手順参照。
  layers: { sharp: "bello-sharp-linux-x64:1" },
  timeoutSeconds: 300,
  memoryMB: 1024, // sharpのRAW→複数導出バッファ生成はデフォルト128MBでは不足するため引き上げ(pricing-schedulerはJSONのみを扱うため既定値のままだったのと対照的)
  schedule: "every 5m",
});
