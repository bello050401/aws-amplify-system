import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, GetCommand, UpdateCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { calculateMarkdownPrice, evaluatePricingSafety, type PricingRuleRecord } from "../../../lib/listing/pricing";
import { isExternalWriteEnabled } from "../../../lib/integrations/writeGuard";

/**
 * §9(PC不在中・完全自律継続実装指示): 完全無人スケジュール実行の
 * Lambdaハンドラ。resource.tsのファイル冒頭コメント参照 —
 * ChannelListing/PricingRuleは読み書き(書き込みはUPDATE_ALLOWED_FIELDS
 * に限定)、BaseOAuthTokenは読み取り専用、PriceExecutionLogは
 * 新規作成のみ。AppSync/GraphQL/Cognitoセッションを一切経由しない、
 * 生DynamoDB API直叩き。
 *
 * 【安全境界、コードで強制する】UpdateCommandのUpdateExpressionは
 * 常にUPDATE_ALLOWED_FIELDSのみを対象にする — id/inventoryId/
 * listingDraftId/channel等のGSIキー属性には絶対に触れない
 * (resource.tsのコメントで説明した安全性の実際の実装)。
 */

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const CHANNEL_LISTING_TABLE = process.env.CHANNEL_LISTING_TABLE_NAME!;
const PRICING_RULE_TABLE = process.env.PRICING_RULE_TABLE_NAME!;
const BASE_OAUTH_TOKEN_TABLE = process.env.BASE_OAUTH_TOKEN_TABLE_NAME!;
const PRICE_EXECUTION_LOG_TABLE = process.env.PRICE_EXECUTION_LOG_TABLE_NAME!;

const BASE_API_BASE = "https://api.thebase.in/1";

interface ChannelListingRow {
  id: string;
  inventoryId: string;
  channel: string;
  status: string;
  externalListingId?: string;
  autoPricingEnabled?: boolean;
  automationHold?: boolean;
  pricingRuleId?: string;
  currentPrice?: number;
  floorPrice?: number;
  markdownCount?: number;
  nextPriceActionAt?: string;
  firstListedAt?: string;
}

interface PricingRuleRow {
  id: string;
  name: string;
  enabled?: boolean;
  channel: string;
  startAfterDays: number;
  intervalDays: number;
  markdownType: PricingRuleRecord["markdownType"];
  markdownValue: number;
  floorPriceMode: PricingRuleRecord["floorPriceMode"];
  floorPriceValue: number;
  maxExecutions?: number | null;
  relistEnabled?: boolean;
  relistAfterDays?: number | null;
  actionAtFloor: PricingRuleRecord["actionAtFloor"];
}

async function writeLog(entry: Record<string, unknown>): Promise<void> {
  try {
    await ddb.send(new PutCommand({ TableName: PRICE_EXECUTION_LOG_TABLE, Item: { id: randomUUID(), createdAt: new Date().toISOString(), ...entry } }));
  } catch (err) {
    // 監査ログ書き込み失敗は本処理を止めない(lib/ai/gateway/usageLog.tsと同じ方針)。
    console.error("[pricing-scheduler] failed to write PriceExecutionLog (non-fatal):", err);
  }
}

/** §9: GSIキー属性に一切触れない、限定されたUpdateExpressionでのみChannelListingを更新する。 */
/**
 * §9: 2つのLambda実行が同じ商品を二重処理しないための簡易lease/
 * idempotency — 直前にScanで読んだnextPriceActionAtの値をこの
 * ConditionExpressionへ渡し、現在DB上の値と一致する場合だけ更新する
 * (呼び出し元processOneは常にScanで実際にマッチした行だけをここへ
 * 渡すため、prevNextPriceActionAtは必ず値を持つ — Scanの
 * FilterExpression自体が`nextPriceActionAt <= :now`なので、この属性が
 * 存在しない行はそもそもScan結果に含まれない)。他の実行が既に処理済み
 * ならDB上の値は既に更新後の新しい日時になっており一致せず、
 * ConditionalCheckFailedExceptionになる。
 */
async function updateChannelListingPriceFields(id: string, prevNextPriceActionAt: string, fields: Partial<ChannelListingRow>): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: CHANNEL_LISTING_TABLE,
        Key: { id },
        UpdateExpression: "SET currentPrice = :cp, markdownCount = :mc, lastPriceChangeAt = :lpc, nextPriceActionAt = :npa, lastAutomationResult = :lar, updatedAt = :ua",
        ConditionExpression: "nextPriceActionAt = :prevNpa",
        ExpressionAttributeValues: {
          ":cp": fields.currentPrice,
          ":mc": fields.markdownCount,
          ":lpc": new Date().toISOString(),
          ":npa": fields.nextPriceActionAt,
          ":lar": `${new Date().toISOString()} pricing-scheduler(Lambda)による自動実行: 成功`,
          ":ua": new Date().toISOString(),
          ":prevNpa": prevNextPriceActionAt,
        },
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
      console.log(`[pricing-scheduler] id=${id}: already processed by another execution (idempotency check), skipping.`);
      return false;
    }
    throw err;
  }
}

async function recordAutomationResult(id: string, summary: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: CHANNEL_LISTING_TABLE,
      Key: { id },
      UpdateExpression: "SET lastAutomationResult = :lar, updatedAt = :ua",
      ExpressionAttributeValues: { ":lar": summary, ":ua": new Date().toISOString() },
    }),
  );
}

async function processOne(row: ChannelListingRow): Promise<void> {
  if (!row.pricingRuleId) return;
  // ScanのFilterExpression(`nextPriceActionAt <= :now`)にマッチした行
  // である以上、この属性は必ず存在する — ここでの早期returnは型を
  // 満たすためのガードであり、実行時に到達することは想定していない。
  if (!row.nextPriceActionAt) return;
  const nextPriceActionAt = row.nextPriceActionAt;
  const { Item: ruleItem } = await ddb.send(new GetCommand({ TableName: PRICING_RULE_TABLE, Key: { id: row.pricingRuleId } }));
  const rule = ruleItem as PricingRuleRow | undefined;
  if (!rule) {
    await writeLog({ channelListingId: row.id, result: "SKIPPED", reason: "RULE_MISSING" });
    return;
  }

  const safety = evaluatePricingSafety({
    status: row.status as never,
    quantity: 1, // Lambdaは在庫数量を直接読まない(Inventoryテーブルへの追加読み取りを避ける) — quantity=0判定はBLOCKED_BY_USERではなくLOCAL_IMPLEMENTEDの既知の簡略化。実際の在庫切れ判定はブラウザ側の手動実行パスで行われる。
    autoPricingEnabled: row.autoPricingEnabled ?? false,
    automationHold: row.automationHold ?? false,
    externalListingId: row.externalListingId ?? null,
    currentPrice: row.currentPrice ?? null,
    floorPrice: row.floorPrice ?? null,
    markdownCount: row.markdownCount ?? 0,
    rule: {
      id: rule.id,
      name: rule.name,
      enabled: rule.enabled ?? false,
      channel: rule.channel as never,
      startAfterDays: rule.startAfterDays,
      intervalDays: rule.intervalDays,
      markdownType: rule.markdownType,
      markdownValue: rule.markdownValue,
      floorPriceMode: rule.floorPriceMode,
      floorPriceValue: rule.floorPriceValue,
      maxExecutions: rule.maxExecutions ?? null,
      relistEnabled: rule.relistEnabled ?? false,
      relistAfterDays: rule.relistAfterDays ?? null,
      actionAtFloor: rule.actionAtFloor,
    },
    nextPriceActionAt: row.nextPriceActionAt ? new Date(row.nextPriceActionAt) : null,
    now: new Date(),
  });

  if (!safety.safe) {
    await recordAutomationResult(row.id, `${new Date().toISOString()} pricing-scheduler(Lambda): blocked: ${safety.reason}`);
    await writeLog({ channelListingId: row.id, result: "BLOCKED", reason: safety.reason });
    return;
  }

  if (row.channel !== "BASE") {
    // Mercariはupdate系ミューテーションの実schema未確認のため、Lambdaからも実送信しない(§157)。
    await writeLog({ channelListingId: row.id, result: "SKIPPED", reason: "CHANNEL_NOT_SUPPORTED_FOR_AUTO_EXECUTION" });
    return;
  }
  if (!row.externalListingId) {
    await writeLog({ channelListingId: row.id, result: "SKIPPED", reason: "NO_EXTERNAL_LISTING" });
    return;
  }

  // 外部サービスへの書き込みは既定で禁止（lib/integrations/writeGuard.ts）。
  // この経路は人の操作なしに1時間ごとに走るので、いちばん止めておく
  // 価値がある。例外は投げずに、止めた事実をログへ残して抜ける ——
  // 遮断は障害ではなく既定の状態であり、FAILEDとして記録すると
  // 本物の失敗が埋もれる。
  if (!isExternalWriteEnabled("BASE")) {
    await writeLog({ channelListingId: row.id, result: "BLOCKED", reason: "EXTERNAL_WRITES_DISABLED" });
    return;
  }

  const currentPrice = row.currentPrice ?? 0;
  const floorPrice = row.floorPrice ?? 0;
  const newPrice = calculateMarkdownPrice(currentPrice, { markdownType: rule.markdownType, markdownValue: rule.markdownValue }, floorPrice);

  // §9: BaseOAuthTokenはread-onlyでのみアクセスする(resource.tsの
  // コメント参照)。期限切れならブラウザでの手動リフレッシュに任せて
  // skipする。
  const { Item: tokenItem } = await ddb.send(new GetCommand({ TableName: BASE_OAUTH_TOKEN_TABLE, Key: { id: "singleton" } }));
  const token = tokenItem as { accessToken?: string; expiresAt?: string } | undefined;
  if (!token?.accessToken || !token.expiresAt || new Date(token.expiresAt).getTime() <= Date.now() + 60_000) {
    await writeLog({ channelListingId: row.id, result: "SKIPPED", reason: "BASE_TOKEN_EXPIRED_OR_MISSING_NEEDS_BROWSER_REFRESH" });
    return;
  }

  try {
    const res = await fetch(`${BASE_API_BASE}/items/edit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.accessToken}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ item_id: row.externalListingId, price: String(newPrice) }),
    });
    if (!res.ok) throw new Error(`BASE items/edit failed: HTTP ${res.status} ${await res.text()}`);

    const applied = await updateChannelListingPriceFields(row.id, nextPriceActionAt, {
      currentPrice: newPrice,
      markdownCount: (row.markdownCount ?? 0) + 1,
      nextPriceActionAt: new Date(Date.now() + rule.intervalDays * 24 * 60 * 60 * 1000).toISOString(),
    });
    await writeLog({ channelListingId: row.id, result: applied ? "SUCCESS" : "SKIPPED_ALREADY_PROCESSED", oldPrice: currentPrice, newPrice });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordAutomationResult(row.id, `${new Date().toISOString()} pricing-scheduler(Lambda): FAILED: ${message}`);
    await writeLog({ channelListingId: row.id, result: "FAILED", errorMessage: message });
  }
}

export const handler = async () => {
  const now = new Date().toISOString();
  let items: ChannelListingRow[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: CHANNEL_LISTING_TABLE,
        FilterExpression: "autoPricingEnabled = :t AND automationHold = :f AND nextPriceActionAt <= :now",
        ExpressionAttributeValues: { ":t": true, ":f": false, ":now": now },
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );
    items = items.concat((res.Items ?? []) as ChannelListingRow[]);
    lastEvaluatedKey = res.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  console.log(`[pricing-scheduler] ${items.length} channel listing(s) due for a pricing check.`);
  for (const row of items) {
    await processOne(row).catch((err) => console.error(`[pricing-scheduler] id=${row.id} unhandled error:`, err));
  }
  return { processedCount: items.length };
};
