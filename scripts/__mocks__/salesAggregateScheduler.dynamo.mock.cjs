/**
 * scripts/verify-sales-aggregate-scheduler-handler.ts 専用fixture。
 *
 * amplify/functions/sales-aggregate-scheduler/handler.ts が呼ぶ
 * "@aws-sdk/client-dynamodb" / "@aws-sdk/lib-dynamodb" をこのmodule一本へ
 * 差し替える——実AWSへは一切接続しない。ScanCommand(Inventory走査)/
 * GetCommand(RunStatus読み取り)/PutCommand(Snapshot・RunStatus書き込み)を
 * それぞれ個別のクラスとして提供し、handler.tsの`instanceof`チェック
 * (ConditionalCheckFailedException)もそのまま動く形にしてある。
 *
 * `snapshotStorage`が「現在DynamoDBに保存されている(つもりの)
 * SalesAggregateSnapshot」を表す唯一の状態——PutCommandが成功した
 * ときだけ更新し、ConditionalCheckFailedException/その他の例外を
 * 投げるよう設定した回では一切更新しない。これにより「失敗時に前回の
 * 値がそのまま残る」ことをテスト側がsnapshotStorageの中身を読んで
 * 直接確認できる。
 *
 * .mjs ではなく .cjs にしているのは意図的(2026-09-11 task_e509 引継ぎ
 * 完了対応): amplify/functions/sales-aggregate-scheduler/handler.ts
 * (トップレベルawaitを持たない.ts)はpackage.jsonに"type":"module"が
 * 無いためtsxによってCJS出力に変換される。CJS化されたモジュールから
 * この fixture を .mjs(=常にESM)としてrequireすると、Nodeの
 * require(esm)相互運用が"await import()"で直接読み込んだ別インスタンス
 * とは別のモジュールレコードを作ってしまい、テスト側の__configure()が
 * 実際にhandlerが参照するインスタンスへ反映されない(状態が分裂する)。
 * .cjs であれば require() 経由でも import() 経由でも同じ
 * Module._cache を共有するため、この分裂が起きない。
 */

class ConditionalCheckFailedException extends Error {
  constructor(message) {
    super(message);
    this.name = "ConditionalCheckFailedException";
  }
}

class ScanCommand {
  constructor(input) {
    this.input = input;
  }
}
class GetCommand {
  constructor(input) {
    this.input = input;
  }
}
class PutCommand {
  constructor(input) {
    this.input = input;
  }
}

class DynamoDBClient {
  constructor() {}
}

let inventoryItems = [];
let runStatusItem; // 既存のSalesAggregateRunStatus行(無ければundefined)
let snapshotStorage; // 既存のSalesAggregateSnapshot行(無ければundefined)
/** "success" | "conditionalFail" | "otherFail" — 次回のSnapshot PutCommandの挙動。 */
let putBehavior = "success";

const calls = { snapshotPuts: [], runStatusPuts: [] };

function __configure({ items = [], existingRunStatus, existingSnapshot, snapshotPutBehavior = "success" } = {}) {
  inventoryItems = items;
  runStatusItem = existingRunStatus;
  snapshotStorage = existingSnapshot;
  putBehavior = snapshotPutBehavior;
  calls.snapshotPuts = [];
  calls.runStatusPuts = [];
}

function __getSnapshotStorage() {
  return snapshotStorage;
}

const DynamoDBDocumentClient = {
  from() {
    return {
      async send(command) {
        if (command instanceof ScanCommand) {
          return { Items: inventoryItems, LastEvaluatedKey: undefined };
        }
        if (command instanceof GetCommand) {
          return { Item: runStatusItem };
        }
        if (command instanceof PutCommand) {
          const item = command.input.Item;
          // Snapshot書き込みは monthsJson を持つ。RunStatus書き込みは state を持つ。
          if (item && typeof item.monthsJson === "string") {
            calls.snapshotPuts.push(item);
            if (putBehavior === "conditionalFail") throw new ConditionalCheckFailedException("mock: 既存の世代の方が新しい");
            if (putBehavior === "otherFail") throw new Error("mock: DynamoDBへの書き込みに失敗しました");
            snapshotStorage = item; // 成功時のみ「保存済み」を更新——失敗時は前回のまま。
            return {};
          }
          calls.runStatusPuts.push(item);
          runStatusItem = item;
          return {};
        }
        throw new Error("mock: 未対応のコマンドです");
      },
    };
  },
};

module.exports = {
  ConditionalCheckFailedException,
  ScanCommand,
  GetCommand,
  PutCommand,
  DynamoDBClient,
  calls,
  __configure,
  __getSnapshotStorage,
  DynamoDBDocumentClient,
};
