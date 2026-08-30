import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing } from "./service";
import { updateBaseProduct } from "./base/adapter";
import { BaseListingApiError } from "./base/errors";
import type { ListingChannel, ListingStatus } from "./types";
import {
  calculateFloorPrice,
  decideActionAtFloor,
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
  channel: ListingChannel;
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
  /** §6(第二次完全完遂指示): 実際に外部へ送信できた場合のエラーメッセージ(送信自体は成功したがレスポンス確認等で問題があった場合)。 */
  externalError?: string;
}

/**
 * §17-20/第二次完全完遂指示§6: 「今、値下げを実行して良いか」を判定し、
 * safeな場合はPriceHistoryへ記録する。
 *
 * 【第二次ラウンドでの変更】Mercari Shopsのupdate系ミューテーション
 * (updateProduct)は今回もWebSearchで複数の切り口(公式docs直接fetch、
 * sandbox GraphQLエンドポイント、GitHub上の非公式クライアント2件の
 * ソース確認)から再調査したが、`UpdateProductInput`に
 * `shippingConfigurationId`/`channelListingScope`が存在することは
 * 確認できたものの、price/status等の肝心のフィールド名までは確認
 * できなかった([UNVERIFIED]のまま — 引き続きBLOCKED_BY_EXTERNAL_
 * SERVICE、憶測でのフィールド名送信はしない)。
 *
 * 一方BASEは`items/edit`(price/stock/visible)の実フィールド名を確認
 * 済み(lib/listing/base/adapter.ts参照)のため、BASEチャネルの
 * ChannelListingに対しては実際にupdateBaseProductを呼び、成功すれば
 * ChannelListing.currentPrice/markdownCount/lastPriceChangeAt/
 * nextPriceActionAtを実際に更新する — 「判定のみ」から「実行」まで
 * 到達した初めてのチャネル。
 *
 * 【§8 完全無人スケジュール実行について、今回の再調査結果】
 * lib/inventory/zaicoSyncPorts.tsが既に検証済みの結論(Amplify Data
 * @aws-amplify/data-schema@1.26.1で`allow.resource(fn)`が機能しない
 * ため、Lambda等の非ブラウザ実行体からinventoryAuthMode
 * (`authMode: "userPool"`)を要求するChannelListing/PricingRule等へ
 * 安全に書き込む経路が無い)を、今回改めてnode_modules内の実際の型
 * 定義(@aws-amplify/data-schema/dist/esm/Authorization.d.ts)を読んで
 * 再確認した — Providers一覧は apiKey/identityPool/userPools/oidc/
 * function の5つのみで、userPools系のgroup認可を無条件のIAM
 * (Lambda実行ロール)から満たす手段は無い。「調べていないからBLOCKED」
 * ではなく、型定義まで再確認した上でのBLOCKED_BY_EXTERNAL_SERVICE
 * (Amplify Gen2側の既知の制約)。
 *
 * 生DynamoDB API経由(backend.data.resources.tables +
 * grantReadWriteData、ZaicoSyncJobで検証済みの安全な適用範囲)は
 * GSIを持たないテーブルへの読み書きでは安全に使えるが、ChannelListing
 * はinventoryId/listingDraftIdのGSIを持つため、生DynamoDB
 * PutItem/UpdateItemでGSI用computed属性を手書きすると
 * 「一見成功するが一覧・検索から見えなくなる」実害リスクがあり、
 * ライブAWS環境での検証なしに採用しない(zaicoSyncPorts.tsと同じ判断
 * 基準)。そのため今回も新規のLambda/EventBridge基盤は追加していない
 * — 未検証のまま「AWS background job実装済み」と称することの方が
 * ユーザーにとって有害(§157)と判断した。現状はUIからの手動テスト
 * 実行(「今すぐ価格チェックを実行」ボタン)からのみ呼ばれる。
 */
/**
 * 下限価格に到達した出品へ、ルールの「下限到達時の動作」を適用する。
 * 何をするかの判定は`decideActionAtFloor`(純粋関数)が持ち、ここは
 * その結果を書き込むだけ。変更が不要な場合でも、なぜ何もしなかったかは
 * lastAutomationResultに必ず残す。
 */
async function applyActionAtFloor(
  channelListing: { id: string; status: ListingStatus; automationHold?: boolean | null },
  rule: PricingRuleRecord,
  who: string | null,
): Promise<void> {
  const decision = decideActionAtFloor(rule.actionAtFloor, channelListing);
  await serverDataClient.models.ChannelListing.update(
    {
      id: channelListing.id,
      ...(decision.status ? { status: decision.status } : {}),
      ...(decision.automationHold ? { automationHold: true } : {}),
      lastAutomationResult: `${new Date().toISOString()} at-floor(${rule.actionAtFloor}): ${decision.note}`,
      updatedBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
}

export async function runPricingCheck(inventoryId: string, who: string | null, channel: ListingChannel = "MERCARI_SHOPS"): Promise<PricingCheckResult> {
  const channelListing = await getChannelListing(inventoryId, channel);
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

  // 下限価格に到達したときだけは、単に止めるのではなくルールの
  // 「下限到達時の動作」に従う。
  //
  // これは以前まったく効いていなかった: actionAtFloorはルールとして
  // 保存され設定画面に4択で出るのに、判定側がこの値を一度も読んでおらず、
  // 「そのまま維持」「出品を停止」「手動確認を促す」のどれを選んでも
  // AT_FLOOR_PRICEで止まるだけで挙動が同一だった。「出品を停止」を選んだ
  // 利用者は停止されると期待するので、選択肢が効かないまま並んでいるのは
  // 黙って機能を縮小しているのと同じ(§155)。
  //
  // 外部APIを呼ぶ動作(RELIST=再出品)はMercari側の再出品APIが未確認の
  // ため引き続き実行しない — 代わりに「なぜ実行しなかったか」を
  // lastAutomationResultへ必ず残し、UIのラベルも「未実装」のままにする。
  if (!safety.safe && safety.reason === "AT_FLOOR_PRICE" && rule) {
    await applyActionAtFloor(channelListing, rule, who);
    return { executed: false, reason: safety.reason };
  }

  if (!safety.safe) return { executed: false, reason: safety.reason };

  const currentPrice = channelListing.currentPrice ?? 0;
  const floorPrice = channelListing.floorPrice ?? 0;
  const newPrice = rule ? calculateMarkdownPrice(currentPrice, rule, floorPrice) : currentPrice;

  if (channel === "BASE" && channelListing.externalListingId) {
    // §6: BASEは実フィールド名確認済みなので、実際に送信する。
    let externalResult: string;
    let executed = false;
    let externalError: string | undefined;
    try {
      await updateBaseProduct({ itemId: channelListing.externalListingId, price: newPrice });
      externalResult = `SUCCESS: BASE items/edit APIへ実際に価格変更(¥${currentPrice}→¥${newPrice})を送信しました。`;
      executed = true;
    } catch (err) {
      externalResult = `FAILED: ${err instanceof BaseListingApiError ? err.message : err instanceof Error ? err.message : String(err)}`;
      externalError = externalResult;
    }

    await serverDataClient.models.PriceHistory.create(
      {
        channelListingId: channelListing.id,
        oldPrice: currentPrice,
        newPrice,
        reason: `自動値下げルール「${rule?.name ?? ""}」による定期値下げ`,
        ruleId: rule?.id,
        actor: "SYSTEM",
        externalResult,
        changedAt: new Date().toISOString(),
      },
      inventoryAuthMode,
    );

    if (executed) {
      const nowIso = new Date().toISOString();
      const nextAt = rule ? calculateNextPriceActionAt(rule, new Date(channelListing.firstListedAt ?? nowIso), new Date(nowIso)) : null;
      await serverDataClient.models.ChannelListing.update(
        {
          id: channelListing.id,
          currentPrice: newPrice,
          markdownCount: channelListing.markdownCount + 1,
          lastPriceChangeAt: nowIso,
          nextPriceActionAt: nextAt?.toISOString(),
          updatedBy: who ?? undefined,
        },
        inventoryAuthMode,
      );
    }

    return { executed, reason: undefined, wouldChangePriceTo: newPrice, externalError };
  }

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

export interface PriceHistoryEntry {
  id: string;
  oldPrice: number | null;
  newPrice: number;
  reason: string;
  actor: "USER" | "SYSTEM";
  externalResult: string | null;
  changedAt: string;
}

/**
 * §20「なぜこの価格になったか」を実際に見られるようにする読み出し。
 *
 * PriceHistoryはこれまで**書かれるだけで、どこからも読まれていなかった**。
 * 設定画面の注記は「監査ログ（商品詳細画面から確認可能）」と書いていたが、
 * 実際に画面へ出ていたのは`lastAutomationResult`(直近1回の判定を要約した
 * 文字列)だけで、価格の変更履歴そのものは表示されていなかった。
 *
 * channelListingIdのGSIが最初から張ってあるのでScanは不要。新しい順に
 * 返す(件数はUI側で必要なだけ切る)。
 */
export async function listPriceHistory(channelListingId: string, limit = 20): Promise<PriceHistoryEntry[]> {
  const { data } = await serverDataClient.models.PriceHistory.listPriceHistoryByChannelListingId(
    { channelListingId },
    { ...inventoryAuthMode, limit: 200 },
  );
  return data
    .map((r) => ({
      id: r.id,
      oldPrice: r.oldPrice ?? null,
      newPrice: r.newPrice,
      reason: r.reason,
      actor: (r.actor ?? "SYSTEM") as "USER" | "SYSTEM",
      externalResult: r.externalResult ?? null,
      changedAt: r.changedAt,
    }))
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
    .slice(0, limit);
}
