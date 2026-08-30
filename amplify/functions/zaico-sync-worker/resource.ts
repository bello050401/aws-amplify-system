import { defineFunction } from "@aws-amplify/backend";

/**
 * BELLO統合業務OS 第五ラウンド §4(P0-A): ZAICO同期を「ユーザーが開始
 * を押した後、ブラウザを閉じ、PCの電源を落としてもAWS側だけで最後
 * まで進む」完全無人Background Job化する。
 *
 * 【経緯】lib/inventory/zaicoSyncPorts.tsの元コメントが記録する通り、
 * これは第2ラウンドまで「Amplify Gen2の`allow.resource(fn)`未実装
 * + Inventoryの生DynamoDB書き込みの安全性が未検証」という2つの理由で
 * 見送られていた。今回:
 *   1. `allow.resource(fn)`を迂回する
 *      `backend.data.resources.tables[modelName].grantReadWriteData(fn)`
 *      経路は、pricing-scheduler/image-processing-workerで既に実証済み。
 *   2. Inventoryの安全性は、synth-check生成の実CloudFormation
 *      (`Custom::AmplifyDynamoDBTable`)を実際にdumpし、5つのGSI
 *      (sku/categoryId/statusId/locationId/deletedAt)が全て素の
 *      トップレベル属性によるシンプルなHASHキーのみのGSIであることを
 *      確認した(lambdaSyncPort.tsのコメント参照)——これでUPDATE経路
 *      の安全性は確定した。CREATE経路(新規ZAICO商品)は実AWS環境での
 *      読み戻し確認ができないため、LOCAL_IMPLEMENTEDに留め
 *      AWS_VERIFIEDは名乗らない。
 *
 * スケジュール5分毎: ZaicoSyncJobがPENDING/RUNNINGでなければ即終了
 * (コストほぼ0)。実行中のjobがあれば、lease(leaseOwner/leaseExpiresAt)
 * を確保した上でこのLambdaのtimeout内で処理できるだけのページを進め、
 * チェックポイントを保存して終了する——1回のスケジュール実行で
 * 全件終わらなくても、次の5分後の実行が同じcheckpointから続きを行う
 * ため、結果として「ブラウザ非依存で最後まで終わる」が実現する。
 */
export const zaicoSyncWorker = defineFunction({
  name: "zaico-sync-worker",
  entry: "./handler.ts",
  // dataスタックへ移す理由はpricing-scheduler/resource.tsの同じ位置の
  // コメントを参照(data ⇄ function のネストスタック循環依存の根本修正)。
  // このLambdaはInventory/Category/Location/InventoryHistory/
  // ZaicoSyncJob/ZaicoSourceLinkをgrantされている。なお本Lambdaは
  // generate-sku(functionスタックに残る)をgrantInvokeするが、これは
  // data → function 方向であり、data/resource.tsが既に持っている向きと
  // 同じ。逆向きのエッジを増やさないため循環にはならない。
  resourceGroupName: "data",
  timeoutSeconds: 240, // 5分スケジュールに対して余裕を残す(次のtickと重ならない)
  memoryMB: 512, // sharpによるthumbnail生成を含むため既定値(128MB)より引き上げ
  schedule: "every 5m",
});
