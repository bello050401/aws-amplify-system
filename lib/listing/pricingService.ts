import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing } from "./service";
import {
  calculateFloorPrice,
  calculateMarkdownPrice,
  calculateNextPriceActionAt,
  evaluatePricingSafety,
  type PricingActionAtFloor,
  type PricingFloorMode,
  type PricingMarkdownType,
  type PricingRuleRecord,
  type PricingSafetyBlockReason,
} from "./pricing";
import type { ChannelListingRecord } from "./types";

/**
 * BELLO統合業務OS指示書(2026-08-30) §17-20: Pricing Rule Engineの
 * AWS/Amplify接続層 — 純粋な計算・判定ロジック(lib/listing/pricing.ts)
 * と分離してある(lib/inventory/sales.ts/lib/listing/serviceの既存の
 * 分離方針と同じ)。lib/listing/service.tsへ直接足さず別ファイルにした
 * のは、service.tsが既にListingDraft/ChannelListingの基本CRUD+
 * Mercari出品本体で十分な大きさになっており、価格自動化という独立した
 * 関心事を同じファイルへこれ以上積み増さないため(§124 過剰設計防止の
 * 裏返し — 逆に1ファイルへ無関係な関心事を混ぜすぎない、という判断)。
 *
 * 【重要】このファイルはMercariへ実際に価格変更を送信しない。
 * runPricingCheckは「今、値下げを実行して良いか」の判定と、判定結果の
 * 監査ログ(PriceHistory)記録までを行うが、実際のupdateProduct相当の
 * API呼び出しはlib/listing/mercari/adapter.tsに実装されていない
 * ([UNVERIFIED] — Mercari Shops GraphQL APIのupdateProduct実Schemaが
 * このsandbox環境から確認できていないため)。safe:trueの場合でも
 * PriceHistory.externalResultへ"NOT_IMPLEMENTED"を正直に記録し、
 * ChannelListing.currentPrice/markdownCount等は一切更新しない —
 * 実際には送信していない変更を送信済みとして扱うことは
 * fake success(§157で明示的に禁止)にあたるため。
 */

function toPricingRuleRecord(row: {
  id: string;
  name: string;
  enabled?: boolean | null;
  channel: "MERCARI_SHOPS";
  startAfterDays: number;
  intervalDays: number;
  markdownType: PricingMarkdownType;
  markdownValue: number;
  floorPriceMode: PricingFloorMode;
  floorPriceValue: number;
  maxExecutions?: number | null;
  relistEnabled?: boolean | null;
  relistAfterDays?: number | null;
  actionAtFloor: PricingActionAtFloor;
}): PricingRuleRecord {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled ?? false,
    channel: row.channel,
    startAfterDays: row.startAfterDays,
    intervalDays: row.intervalDays,
    markdownType: row.markdownType,
    markdownValue: row.markdownValue,
    floorPriceMode: row.floorPriceMode,
    floorPriceValue: row.floorPriceValue,
    maxExecutions: row.maxExecutions ?? null,
    relistEnabled: row.relistEnabled ?? false,
    relistAfterDays: row.relistAfterDays ?? null,
    actionAtFloor: row.actionAtFloor,
  };
}

export async function listPricingRules(): Promise<PricingRuleRecord[]> {
  const { data, errors } = await serverDataClient.models.PricingRule.list({ ...inventoryAuthMode });
  if (errors) throw new Error(`自動価格ルール一覧の取得に失敗しました: ${JSON.stringify(errors)}`);
  return data.map(toPricingRuleRecord);
}

export async function getPricingRule(id: string): Promise<PricingRuleRecord | null> {
  const { data } = await serverDataClient.models.PricingRule.get({ id }, inventoryAuthMode);
  return data ? toPricingRuleRecord(data) : null;
}

export interface PricingRuleInput {
  name: string;
  enabled: boolean;
  startAfterDays: number;
  intervalDays: number;
  markdownType: PricingMarkdownType;
  markdownValue: number;
  floorPriceMode: PricingFloorMode;
  floorPriceValue: number;
  maxExecutions: number | null;
  actionAtFloor: PricingActionAtFloor;
}

/** §161: ruleId未指定(=新規作成)ならenabledに関わらずルール自体は作成できる — 「作成」と「有効化」を分けて考える(ルールを準備だけしておき、後で有効化する運用を妨げない)。 */
export async function savePricingRule(ruleId: string | null, input: PricingRuleInput, who: string | null): Promise<PricingRuleRecord> {
  if (!input.name.trim()) throw new Error("ルール名を入力してください。");
  if (input.startAfterDays < 0 || input.intervalDays <= 0) throw new Error("日数の指定が不正です。");
  if (input.markdownValue <= 0) throw new Error("値下げ幅は1以上を指定してください。");
  if (input.floorPriceValue < 0) throw new Error("下限価格の指定が不正です。");

  const fields = {
    name: input.name.trim(),
    enabled: input.enabled,
    startAfterDays: input.startAfterDays,
    intervalDays: input.intervalDays,
    markdownType: input.markdownType,
    markdownValue: input.markdownValue,
    floorPriceMode: input.floorPriceMode,
    floorPriceValue: input.floorPriceValue,
    maxExecutions: input.maxExecutions ?? undefined,
    actionAtFloor: input.actionAtFloor,
    updatedBy: who ?? undefined,
  };

  if (ruleId) {
    const { data: updated, errors } = await serverDataClient.models.PricingRule.update({ id: ruleId, ...fields }, inventoryAuthMode);
    if (errors || !updated) throw new Error(`自動価格ルールの更新に失敗しました: ${JSON.stringify(errors)}`);
    return toPricingRuleRecord(updated);
  }

  const { data: created, errors } = await serverDataClient.models.PricingRule.create(
    { channel: "MERCARI_SHOPS", relistEnabled: false, ...fields, createdBy: who ?? undefined },
    inventoryAuthMode,
  );
  if (errors || !created) throw new Error(`自動価格ルールの作成に失敗しました: ${JSON.stringify(errors)}`);
  return toPricingRuleRecord(created);
}

export interface AutoPricingSettingInput {
  autoPricingEnabled: boolean;
  pricingRuleId: string | null;
  automationHold: boolean;
}

/**
 * §18: 商品別自動価格設定の変更。autoPricingEnabledをtrueへ切り替えた
 * 瞬間(既にoriginalPriceが記録されていない場合)、その時点の実効価格
 * (overridePrice ?? ListingDraft.price)をoriginalPriceとして固定する
 * — 後からListingDraftの価格を変更しても、値下げの基準点(§17の
 * originalPrice)は動かないようにするため。
 */
export async function setAutoPricingForListing(inventoryId: string, input: AutoPricingSettingInput, who: string | null): Promise<ChannelListingRecord> {
  const channelListing = await getChannelListing(inventoryId, "MERCARI_SHOPS");
  if (!channelListing) throw new Error("先にMercariのカテゴリー設定を保存してください。");

  let rule: PricingRuleRecord | null = null;
  if (input.pricingRuleId) {
    rule = await getPricingRule(input.pricingRuleId);
    if (!rule) throw new Error("指定された自動価格ルールが見つかりません。");
  }

  const currentEffectivePrice = channelListing.overridePrice ?? 0;
  const originalPrice = currentEffectivePrice; // §17: このタイミングの実効価格を基準点として固定する(既存値があっても、設定変更のたびに基準点を更新する仕様 — 「今の価格からこのルールで値下げしていく」という直感に合わせた)
  const floorPrice = rule ? calculateFloorPrice(originalPrice, rule) : null;
  const nextPriceActionAt =
    input.autoPricingEnabled && rule && channelListing.firstListedAt
      ? calculateNextPriceActionAt(rule, new Date(channelListing.firstListedAt), null)
      : null;

  const { data: updated, errors } = await serverDataClient.models.ChannelListing.update(
    {
      id: channelListing.id,
      autoPricingEnabled: input.autoPricingEnabled,
      pricingRuleId: input.pricingRuleId ?? undefined,
      automationHold: input.automationHold,
      originalPrice: input.autoPricingEnabled ? originalPrice : undefined,
      currentPrice: input.autoPricingEnabled ? currentEffectivePrice : undefined,
      floorPrice: floorPrice ?? undefined,
      nextPriceActionAt: nextPriceActionAt ? nextPriceActionAt.toISOString() : undefined,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (errors || !updated) throw new Error(`自動価格設定の保存に失敗しました: ${JSON.stringify(errors)}`);
  // getChannelListingと同じ変換を経由させるため、service.tsのtoChannelListingRecord相当を再取得で得る
  const refreshed = await getChannelListing(inventoryId, "MERCARI_SHOPS");
  if (!refreshed) throw new Error("保存後の再取得に失敗しました。");
  return refreshed;
}

export interface PricingCheckResult {
  executed: boolean;
  reason?: PricingSafetyBlockReason;
  wouldChangePriceTo?: number;
}

/**
 * §17-20: 「今、値下げを実行して良いか」を判定し、safeな場合は
 * PriceHistoryへ記録する(ただし実際のMercari側価格変更は送信しない
 * — このファイル冒頭コメント参照)。実際にスケジューラから定期実行
 * される経路はまだ無く(§22 AWS-nativeスケジューラは今回未実装)、
 * 現状はUIからの手動テスト実行(「今すぐ価格チェックを実行」ボタン)
 * からのみ呼ばれる。
 */
export async function runPricingCheck(inventoryId: string, who: string | null): Promise<PricingCheckResult> {
  const channelListing = await getChannelListing(inventoryId, "MERCARI_SHOPS");
  if (!channelListing) throw new Error("対象のChannelListingが見つかりません。");

  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");

  const rule = channelListing.pricingRuleId ? await getPricingRule(channelListing.pricingRuleId) : null;

  const safety = evaluatePricingSafety({
    status: channelListing.status,
    quantity: inventory.quantity,
    autoPricingEnabled: channelListing.autoPricingEnabled,
    automationHold: channelListing.automationHold,
    externalListingId: channelListing.externalListingId,
    currentPrice: channelListing.currentPrice,
    floorPrice: channelListing.floorPrice,
    markdownCount: channelListing.markdownCount,
    rule,
    nextPriceActionAt: channelListing.nextPriceActionAt ? new Date(channelListing.nextPriceActionAt) : null,
    now: new Date(),
  });

  const summary = safety.safe ? "safe" : `blocked: ${safety.reason}`;
  await serverDataClient.models.ChannelListing.update(
    { id: channelListing.id, lastAutomationResult: `${new Date().toISOString()} ${summary}`, updatedBy: who ?? undefined },
    inventoryAuthMode,
  );

  if (!safety.safe) return { executed: false, reason: safety.reason };

  const currentPrice = channelListing.currentPrice ?? 0;
  const floorPrice = channelListing.floorPrice ?? 0;
  const newPrice = rule ? calculateMarkdownPrice(currentPrice, rule, floorPrice) : currentPrice;

  await serverDataClient.models.PriceHistory.create(
    {
      channelListingId: channelListing.id,
      oldPrice: currentPrice,
      newPrice,
      reason: `自動値下げルール「${rule?.name ?? ""}」による定期値下げ（判定のみ・未送信）`,
      ruleId: rule?.id,
      actor: "SYSTEM",
      externalResult: "NOT_IMPLEMENTED: Mercari updateProduct APIの実Schemaが未検証のため、実際の価格変更は送信していません。",
      changedAt: new Date().toISOString(),
    },
    inventoryAuthMode,
  );

  // §157: 実際には送信していないため、ChannelListing.currentPrice/
  // markdownCount/lastPriceChangeAtは更新しない — 「判定はsafeだった」
  // という事実だけをlastAutomationResult/PriceHistoryに残す。
  return { executed: false, reason: undefined, wouldChangePriceTo: newPrice };
}
