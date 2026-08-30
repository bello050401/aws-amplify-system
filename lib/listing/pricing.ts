/**
 * BELLO統合業務OS指示書(2026-08-30) §17-21: Pricing Rule Engine —
 * 純粋なロジックのみ(lib/inventory/sales.tsと同じ方針: AWS/Amplifyへ
 * 一切触れない、DB取得は呼び出し元(lib/listing/service.ts)の責務)。
 *
 * 実際にMercariへ価格変更を送信するAPI呼び出しはこのファイルの範囲外
 * — updateProduct相当のGraphQL実Schemaがこのsandbox環境から確認でき
 * ていない([UNVERIFIED])ため、「今この瞬間、値下げを実行して良いか」
 * を判定するところまでがこのファイルの責務。実際の外部送信は
 * lib/listing/service.tsのrunPricingCheckが、判定がsafe:trueであって
 * も明示的にBLOCKED_BY_EXTERNAL_SERVICEとして記録する(§157: fake
 * successを作らない)。
 */

import type { ListingChannel, ListingStatus } from "./types";

export type PricingMarkdownType = "FIXED_AMOUNT" | "PERCENTAGE";
export type PricingFloorMode = "FIXED_AMOUNT" | "PERCENTAGE_OF_ORIGINAL";
export type PricingActionAtFloor = "KEEP" | "PAUSE" | "RELIST" | "MANUAL_REVIEW";

export interface PricingRuleRecord {
  id: string;
  name: string;
  enabled: boolean;
  channel: ListingChannel;
  startAfterDays: number;
  intervalDays: number;
  markdownType: PricingMarkdownType;
  markdownValue: number;
  floorPriceMode: PricingFloorMode;
  floorPriceValue: number;
  maxExecutions: number | null;
  relistEnabled: boolean;
  relistAfterDays: number | null;
  actionAtFloor: PricingActionAtFloor;
}

/**
 * §17: floorPriceの計算。FIXED_AMOUNTならそのまま、
 * PERCENTAGE_OF_ORIGINALなら初回価格に対する割合(切り上げ — 下限価格
 * は「これ以上は下げない」という保護なので、丸め誤差で保護ラインを
 * 割り込む方向(切り捨て)には倒さない)。
 */
export function calculateFloorPrice(originalPrice: number, rule: Pick<PricingRuleRecord, "floorPriceMode" | "floorPriceValue">): number {
  if (rule.floorPriceMode === "FIXED_AMOUNT") return rule.floorPriceValue;
  return Math.ceil((originalPrice * rule.floorPriceValue) / 100);
}

/**
 * §17: 1回の値下げ後の価格。FIXED_AMOUNTなら現在価格から定額を引く、
 * PERCENTAGEなら現在価格に対して定率で引く(切り捨て — 値下げ額を
 * 誤って少なく見積もることはあっても、意図せず大きく値下げしてしまう
 * 方向には倒さない)。floorPriceを下回らないようクランプする。
 */
export function calculateMarkdownPrice(
  currentPrice: number,
  rule: Pick<PricingRuleRecord, "markdownType" | "markdownValue">,
  floorPrice: number,
): number {
  const raw =
    rule.markdownType === "FIXED_AMOUNT" ? currentPrice - rule.markdownValue : Math.floor(currentPrice * (1 - rule.markdownValue / 100));
  return Math.max(raw, floorPrice);
}

/** §17: 次回値下げ予定時刻。初回はfirstListedAt + startAfterDays、以降はlastPriceChangeAt + intervalDays。 */
export function calculateNextPriceActionAt(
  rule: Pick<PricingRuleRecord, "startAfterDays" | "intervalDays">,
  firstListedAt: Date,
  lastPriceChangeAt: Date | null,
): Date {
  const base = lastPriceChangeAt ?? firstListedAt;
  const days = lastPriceChangeAt ? rule.intervalDays : rule.startAfterDays;
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

export type PricingSafetyBlockReason =
  | "STATUS_NOT_ELIGIBLE"
  | "OUT_OF_STOCK"
  | "AUTO_PRICING_DISABLED"
  | "AUTOMATION_ON_HOLD"
  | "AT_FLOOR_PRICE"
  | "RULE_DISABLED"
  | "RULE_MISSING"
  | "NO_EXTERNAL_LISTING"
  | "MAX_EXECUTIONS_REACHED"
  | "NOT_DUE_YET";

export interface PricingSafetyInput {
  status: ListingStatus;
  quantity: number;
  autoPricingEnabled: boolean;
  automationHold: boolean;
  externalListingId: string | null;
  currentPrice: number | null;
  floorPrice: number | null;
  markdownCount: number;
  rule: PricingRuleRecord | null;
  nextPriceActionAt: Date | null;
  now: Date;
}

export interface PricingSafetyResult {
  safe: boolean;
  reason?: PricingSafetyBlockReason;
}

/**
 * §19: 自動価格処理の安全条件。すべてtrueでなければ絶対に値下げを
 * 実行しない、という否定形のホワイトリストではなくブラックリスト
 * (どれか1つでも該当すれば即ブロック)として実装 — 安全側に倒す
 * ため、判定条件を追加する分には既存の安全性を壊さない設計。
 *
 * §19に列挙されている一部の条件(credential invalid / API error継続 /
 * concurrency conflict / 予約・取り置き等)はこの関数の範囲外 —
 * 前者2つは実際の外部API呼び出し時に初めて分かるものであり事前の
 * 純粋関数では判定できず、concurrency conflictはスケジューラ本体の
 * ロック機構(未実装)の責務、予約・取り置き等はBELLOに該当する概念が
 * 現状無い。
 */
export function evaluatePricingSafety(input: PricingSafetyInput): PricingSafetyResult {
  if (input.status === "SOLD" || input.status === "ENDED" || input.status === "ARCHIVED") {
    return { safe: false, reason: "STATUS_NOT_ELIGIBLE" };
  }
  if (input.quantity <= 0) return { safe: false, reason: "OUT_OF_STOCK" };
  if (!input.autoPricingEnabled) return { safe: false, reason: "AUTO_PRICING_DISABLED" };
  if (input.automationHold) return { safe: false, reason: "AUTOMATION_ON_HOLD" };
  if (!input.externalListingId) return { safe: false, reason: "NO_EXTERNAL_LISTING" };
  if (!input.rule) return { safe: false, reason: "RULE_MISSING" };
  if (!input.rule.enabled) return { safe: false, reason: "RULE_DISABLED" };
  if (input.rule.maxExecutions != null && input.markdownCount >= input.rule.maxExecutions) {
    return { safe: false, reason: "MAX_EXECUTIONS_REACHED" };
  }
  if (input.currentPrice != null && input.floorPrice != null && input.currentPrice <= input.floorPrice) {
    return { safe: false, reason: "AT_FLOOR_PRICE" };
  }
  if (input.nextPriceActionAt && input.now < input.nextPriceActionAt) {
    return { safe: false, reason: "NOT_DUE_YET" };
  }
  return { safe: true };
}

/**
 * 下限価格に到達したときに何をするかを決める。DBへは触れず、
 * 「どう更新すべきか」だけを返す純粋関数(判定はpricing.ts、
 * 書き込みはpricingService.tsという既存の分担に合わせる)。
 *
 * この設定は以前まったく効いていなかった — ルールとして保存され設定画面に
 * 4択で出るのに、判定側がこの値を一度も読んでおらず、どれを選んでも
 * AT_FLOOR_PRICEで止まるだけで挙動が同一だった。
 *
 * どの分岐も価格自体は変更しない(下限より下げない)。RELISTはMercariの
 * 再出品APIが未確認のため実行せず、何もしなかったことを記録だけする。
 */
export function decideActionAtFloor(
  action: PricingActionAtFloor,
  current: { status: string; automationHold?: boolean | null },
): { status?: "PAUSED"; automationHold?: true; note: string } {
  switch (action) {
    case "PAUSE":
      return current.status === "PAUSED"
        ? { note: "下限に到達しています(出品は既に停止済み)。" }
        : { status: "PAUSED", note: "下限に到達したため出品を停止しました。" };
    case "MANUAL_REVIEW":
      return current.automationHold
        ? { note: "下限に到達しています(既に手動確認待ち)。" }
        : { automationHold: true, note: "下限に到達したため手動確認待ちにしました。" };
    case "RELIST":
      return { note: "再出品は未実装のため、価格・状態とも変更していません。" };
    case "KEEP":
    default:
      return { note: "下限に到達しました。設定により価格・状態とも変更していません。" };
  }
}
