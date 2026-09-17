import "server-only";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { directTableName } from "@/lib/amplify/directData";

/**
 * lib/ai/budget/ledgerCommands.ts が使うDynamoDB接続とテーブル名解決。
 *
 * lib/amplify/directData.tsと同じ理由(§ledgerCommands.tsの冒頭コメント)で
 * Amplify DataのGraphQLクライアントを使わず直結する。テーブル名解決
 * (`<Model>-<apiId>-<env>`)は directData.ts の directTableName を再利用
 * する — 同じ規則をもう一度書くと、環境が変わったときに片方だけ直して
 * 静かにテーブルを取り違える([[lib/amplify/directData.ts]]のコメント参照)。
 */
const REGION = process.env.AWS_REGION || process.env.BEDROCK_REGION || "us-west-2";

let cached: DynamoDBDocumentClient | null = null;
function ddb(): DynamoDBDocumentClient {
  if (!cached) cached = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cached;
}

/**
 * ledgerCommands.tsが要求する依存一式。**DIで受け取る**(collect.tsや
 * lib/integrity/store.tsと同じ理由) — テストがfakeのddb.sendを差し込める
 * ようにし、かつ"server-only"を引き込まないコアロジックにする。
 */
export interface LedgerDeps {
  ddb: DynamoDBDocumentClient;
  tableFor: (model: "AIBudgetLedger" | "AIBudgetReservation") => string;
  /** 「今」。テストから固定できるようにする。 */
  now: () => string;
}

/** 本番用の依存一式。 */
export function liveLedgerDeps(): LedgerDeps {
  return {
    ddb: ddb(),
    tableFor: (model) => directTableName(model),
    now: () => new Date().toISOString(),
  };
}
