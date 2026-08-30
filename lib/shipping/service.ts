import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { getChannelListing } from "@/lib/listing/service";
import type { ChannelListingRecord, ListingChannel } from "@/lib/listing/types";
import { calculateShippingRankFromDimensions, type ShippingRank } from "./rank";
import { SHIPPING_ORIGIN_PREFECTURE } from "./prefectures";
import { SHIPPING_RATE_SEED, SHIPPING_RATE_SEED_SOURCE_REFERENCE, SHIPPING_RATE_SEED_VERIFIED_AT } from "./ratesSeed";
import type { ShippingRateRecord } from "./types";
import { buildShippingReferencePriceView, pickLatestPerPrefecture, type ShippingReferencePriceView } from "./referencePrice";

/**
 * BELLO統合業務OS指示書(2026-08-30) §65-68: 家財おまかせ便の料金
 * マスタCRUD + ランク見積り。lib/listing/pricingService.tsと同じ
 * pure/AWS分離方針 — ランク計算そのもの(lib/shipping/rank.ts)は純粋
 * 関数、ここはDynamoDB(Amplify Data)へのアクセスのみを担当する。
 */

function toShippingRateRecord(row: {
  id: string;
  provider: string;
  service: string;
  originPrefecture: string;
  originArea?: string | null;
  destinationPrefecture: string;
  destinationArea?: string | null;
  rank: ShippingRank;
  price: number;
  surcharge?: number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  sourceReference?: string | null;
  verifiedAt?: string | null;
  version?: number | null;
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}): ShippingRateRecord {
  return {
    id: row.id,
    provider: row.provider,
    service: row.service,
    originPrefecture: row.originPrefecture,
    originArea: row.originArea ?? null,
    destinationPrefecture: row.destinationPrefecture,
    destinationArea: row.destinationArea ?? null,
    rank: row.rank,
    price: row.price,
    surcharge: row.surcharge ?? null,
    effectiveFrom: row.effectiveFrom ?? null,
    effectiveTo: row.effectiveTo ?? null,
    sourceReference: row.sourceReference ?? null,
    verifiedAt: row.verifiedAt ?? null,
    version: row.version ?? 1,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * lib/inventory/masterSeed.tsと同じ追加専用シード方針 — 既に同じ
 * provider/destinationPrefecture/rankの行が(誰かの編集結果も含めて)
 * 存在すれば絶対に上書きしない。lib/shipping/ratesSeed.tsに記載した
 * 実際にWebSearchで確認できた2件(埼玉→東京 B/Cランク)のみを投入する
 * — 設定画面の初回表示のたびに呼んでも安全な冪等処理。
 */
export async function seedShippingRates(): Promise<void> {
  const { data: existing } = await serverDataClient.models.ShippingRate.list({ ...inventoryAuthMode, limit: 1000 });
  for (const seed of SHIPPING_RATE_SEED) {
    const already = existing.some(
      (r) => r.provider === seed.provider && r.destinationPrefecture === seed.destinationPrefecture && r.rank === seed.rank,
    );
    if (already) continue;
    await serverDataClient.models.ShippingRate.create(
      {
        provider: seed.provider,
        service: seed.service,
        originPrefecture: seed.originPrefecture,
        destinationPrefecture: seed.destinationPrefecture,
        rank: seed.rank,
        price: seed.price,
        sourceReference: SHIPPING_RATE_SEED_SOURCE_REFERENCE,
        verifiedAt: SHIPPING_RATE_SEED_VERIFIED_AT,
        version: 1,
        createdBy: "system-seed",
      },
      inventoryAuthMode,
    );
  }
}

/** 設定画面の管理一覧用 — 全件(通常は数十件規模を想定)。 */
export async function listShippingRates(): Promise<ShippingRateRecord[]> {
  const { data } = await serverDataClient.models.ShippingRate.list({ ...inventoryAuthMode, limit: 1000 });
  return data.map(toShippingRateRecord).sort((a, b) => {
    if (a.destinationPrefecture !== b.destinationPrefecture) return a.destinationPrefecture.localeCompare(b.destinationPrefecture, "ja");
    return a.rank.localeCompare(b.rank);
  });
}

export interface ShippingRateInput {
  provider: string;
  service: string;
  destinationPrefecture: string;
  destinationArea?: string | null;
  rank: ShippingRank;
  price: number;
  surcharge?: number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  sourceReference?: string | null; // §65: 憶測値でないことの根拠 — 空のままの保存も許すが、ADMIN向けUIで強く推奨する
}

/** §65: rateIdがあれば更新、無ければ新規作成(ADMIN専用 — 呼び出し元のapp/actions/shipping.tsがrequireAdminで守る)。 */
export async function saveShippingRate(rateId: string | null, input: ShippingRateInput, who: string | null): Promise<ShippingRateRecord> {
  const fields = {
    provider: input.provider,
    service: input.service,
    originPrefecture: SHIPPING_ORIGIN_PREFECTURE, // §61: 発送元は常に固定
    destinationPrefecture: input.destinationPrefecture,
    destinationArea: input.destinationArea ?? null,
    rank: input.rank,
    price: input.price,
    surcharge: input.surcharge ?? null,
    effectiveFrom: input.effectiveFrom ?? null,
    effectiveTo: input.effectiveTo ?? null,
    sourceReference: input.sourceReference ?? null,
    verifiedAt: input.sourceReference ? new Date().toISOString() : null, // 出典を入力した=その時点で人が確認したという扱い
    updatedBy: who,
  };

  if (rateId) {
    const { data: existing } = await serverDataClient.models.ShippingRate.get({ id: rateId }, inventoryAuthMode);
    const { data: updated, errors } = await serverDataClient.models.ShippingRate.update(
      { id: rateId, ...fields, version: (existing?.version ?? 1) + 1 },
      inventoryAuthMode,
    );
    if (errors || !updated) throw new Error(errors?.[0]?.message ?? "料金の更新に失敗しました。");
    return toShippingRateRecord(updated);
  }

  const { data: created, errors } = await serverDataClient.models.ShippingRate.create(
    { ...fields, version: 1, createdBy: who },
    inventoryAuthMode,
  );
  if (errors || !created) throw new Error(errors?.[0]?.message ?? "料金の登録に失敗しました。");
  return toShippingRateRecord(created);
}

export async function deleteShippingRate(rateId: string): Promise<void> {
  const { errors } = await serverDataClient.models.ShippingRate.delete({ id: rateId }, inventoryAuthMode);
  if (errors) throw new Error(errors[0]?.message ?? "料金の削除に失敗しました。");
}

/**
 * §65: 発送先都道府県+ランクで料金を検索する。同一条件で複数該当する
 * 場合(effectiveFromの更新など)はversionが最大のものを採用する。
 * 発送元は常に埼玉県固定(§61)なので検索条件に含めない。
 */
export async function lookupShippingRate(destinationPrefecture: string, rank: ShippingRank): Promise<ShippingRateRecord | null> {
  const { data } = await serverDataClient.models.ShippingRate.list({
    filter: { and: [{ destinationPrefecture: { eq: destinationPrefecture } }, { rank: { eq: rank } }] },
    ...inventoryAuthMode,
  });
  if (data.length === 0) return null;
  const sorted = data.map(toShippingRateRecord).sort((a, b) => b.version - a.version);
  return sorted[0];
}

export interface ShippingEstimateResult {
  channelListing: ChannelListingRecord;
  rank: ShippingRank | null;
  rateFound: boolean;
  reason?: string;
}

const SHIPPING_CHANNEL: ListingChannel = "MERCARI_SHOPS";

/**
 * §67: Inventoryの寸法からランクを計算し、ShippingRateマスタを検索して
 * ChannelListing.calculatedShippingFee等へ書き込む。マスタに該当行が
 * 無ければcalculatedShippingFeeはnullのまま(reasonで理由を返す) —
 * 憶測の金額を書き込むことは絶対にしない(§157)。
 */
export async function calculateShippingEstimate(inventoryId: string, destinationPrefecture: string, who: string | null): Promise<ShippingEstimateResult> {
  const [inventory, channelListing] = await Promise.all([getInventoryDetail(inventoryId), getChannelListing(inventoryId, SHIPPING_CHANNEL)]);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");
  if (!channelListing) throw new Error("この商品にはまだEC出品情報がありません。先に出品準備を行ってください。");

  const dims = calculateShippingRankFromDimensions(inventory.width, inventory.depth, inventory.height);
  if (!dims) {
    const { data: updated, errors } = await serverDataClient.models.ChannelListing.update(
      {
        id: channelListing.id,
        shippingRank: null,
        shippingDestinationPrefecture: destinationPrefecture,
        calculatedShippingFee: null,
        shippingFeeUpdatedAt: new Date().toISOString(),
        updatedBy: who,
      },
      inventoryAuthMode,
    );
    if (errors || !updated) throw new Error(errors?.[0]?.message ?? "見積りの保存に失敗しました。");
    const refreshed = await getChannelListing(inventoryId, SHIPPING_CHANNEL);
    return { channelListing: refreshed!, rank: null, rateFound: false, reason: "幅・奥行・高さが未入力のため、ランクを判定できません。" };
  }

  const rate = await lookupShippingRate(destinationPrefecture, dims.rank);

  const { errors } = await serverDataClient.models.ChannelListing.update(
    {
      id: channelListing.id,
      shippingRank: dims.rank,
      shippingDestinationPrefecture: destinationPrefecture,
      calculatedShippingFee: rate ? rate.price + (rate.surcharge ?? 0) : null,
      shippingFeeUpdatedAt: new Date().toISOString(),
      updatedBy: who,
    },
    inventoryAuthMode,
  );
  if (errors) throw new Error(errors[0]?.message ?? "見積りの保存に失敗しました。");

  const refreshed = await getChannelListing(inventoryId, SHIPPING_CHANNEL);
  return {
    channelListing: refreshed!,
    rank: dims.rank,
    rateFound: rate != null,
    reason: rate ? undefined : `埼玉県 → ${destinationPrefecture}・${dims.rank}ランクの料金がまだ料金マスタに登録されていません。設定画面から追加してください。`,
  };
}

/** §68: confirmedShippingFeeを人が確定させる(nullを渡せば確定解除)。 */
export async function confirmShippingFee(inventoryId: string, confirmedFee: number | null, who: string | null): Promise<ChannelListingRecord> {
  const channelListing = await getChannelListing(inventoryId, SHIPPING_CHANNEL);
  if (!channelListing) throw new Error("この商品にはまだEC出品情報がありません。");

  const { errors } = await serverDataClient.models.ChannelListing.update(
    { id: channelListing.id, confirmedShippingFee: confirmedFee, shippingFeeUpdatedAt: new Date().toISOString(), updatedBy: who },
    inventoryAuthMode,
  );
  if (errors) throw new Error(errors[0]?.message ?? "送料の確定に失敗しました。");

  const refreshed = await getChannelListing(inventoryId, SHIPPING_CHANNEL);
  return refreshed!;
}

export type GetShippingReferencePriceResult =
  | { available: false; reason: string }
  | { available: true; view: ShippingReferencePriceView };

/**
 * §31/§46: EC出品下書きの「送料込み参考価格」。plannedPrice(Inventory.
 * plannedSalePrice)は絶対に書き換えない——読み取って派生値を計算する
 * だけ。ランクはInventoryの寸法から都度計算する(ChannelListing行が
 * まだ無い商品でも表示できるようにするため——出品準備前でも見積りの
 * 目安は見たい、という自然な利用順序に合わせた設計判断)。
 *
 * 中央値算出に使う`verifiedRates`は、同一都道府県の重複バージョンを
 * pickLatestPerPrefectureで1件に絞り、`verifiedAt`が設定されている
 * (=手入力の未確認値ではない)行だけに限定する——§157「憶測値を実装
 * 済みに見せかけない」原則を、このバージョンでも徹底する。
 */
export async function getShippingReferencePrice(inventoryId: string): Promise<GetShippingReferencePriceResult> {
  const inventory = await getInventoryDetail(inventoryId);
  if (!inventory) throw new Error("対象の在庫が見つかりません。");
  if (inventory.plannedSalePrice == null) {
    return { available: false, reason: "販売予定金額が未入力です。先に在庫詳細で販売予定金額を入力してください。" };
  }

  const dims = calculateShippingRankFromDimensions(inventory.width, inventory.depth, inventory.height);
  if (!dims) {
    return { available: false, reason: "幅・奥行・高さが未入力のため、家財おまかせ便ランクを判定できません。" };
  }

  const { data } = await serverDataClient.models.ShippingRate.list({
    filter: { rank: { eq: dims.rank } },
    ...inventoryAuthMode,
  });
  const verifiedRates = pickLatestPerPrefecture(data.map(toShippingRateRecord).filter((r) => r.verifiedAt != null));

  const view = buildShippingReferencePriceView({ plannedPrice: inventory.plannedSalePrice, rank: dims.rank, verifiedRates });
  return { available: true, view };
}
