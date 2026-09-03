/**
 * 統合Product Context(2026-09-03 追加指示 §29-§36)。
 *
 * ── なぜ作るのか ────────────────────────────────────────────────
 *
 * 実例: 在庫にサイズが入っていない商品に値下げ交渉が来た。顧客が送って
 * きたBASE商品ページには寸法が書いてある。それでも
 *
 *     ■ 配送情報
 *     配送先：埼玉県
 *     想定送料：不明
 *
 * となり、値下げ判断まで進まなかった。**計算に必要な数字は目の前にあった**。
 * 原因は「商品情報＝Inventory」と決め打ちしていたこと。Inventory に無ければ
 * そこで終わっていた。
 *
 * ── 何をするのか ────────────────────────────────────────────────
 *
 * 商品1件について、使える出典を**項目ごとに**組み合わせて1つの文脈を作る。
 * 上書きではなく補完である:
 *
 *     商品名     ← Inventory(あれば)
 *     仕入価格   ← Inventory のみ(BASEには無い)
 *     販売開始日 ← Inventory のみ
 *     販売価格   ← Inventory、無ければBASEの掲載価格
 *     サイズ     ← Inventory、無ければBASEの商品説明から抽出
 *     商品説明   ← BASE
 *
 * ── 出典を必ず持つ(§33) ─────────────────────────────────────────
 *
 * どの項目をどこから取ったかを値と一緒に持ち回る。「送料はBASEの説明文から
 * 読んだ寸法で出した」ことが後から追えないと、金額が合わなかったときに
 * どこを直すべきか分からない。
 *
 * ── チャネルで分岐しない(§34) ───────────────────────────────────
 *
 * 公式LINEでもメルカリShopsでも、商品が特定できたら同じこの関数を通す。
 * チャネルごとに送料ロジックを持つと、片方だけ直る/片方だけ壊れる。
 */
import "server-only";
import { calculateShippingRankFromDimensions } from "@/lib/shipping/rank";
import { lookupBaseProduct } from "./baseProductLookup";
import {
  descriptionToPlainText,
  extractAttributesFromText,
  extractDimensionsFromText,
  extractShippingRankFromText,
  type DimensionConfidence,
} from "./productDetailExtraction";

/** 項目1つの出典。§33 の sizeSource がこれにあたる。 */
export type ProductFieldSource = "INVENTORY" | "BASE_ARCHIVE" | "BASE_LIVE";

export const PRODUCT_FIELD_SOURCE_LABEL: Record<ProductFieldSource, string> = {
  INVENTORY: "在庫データ",
  BASE_ARCHIVE: "BASE取り込み済みデータ",
  BASE_LIVE: "BASE商品ページ",
};

export interface Sourced<T> {
  value: T;
  source: ProductFieldSource;
}

export interface ProductDimensions {
  width: Sourced<string> | null;
  depth: Sourced<string> | null;
  height: Sourced<string> | null;
  /**
   * 3辺そろっているか、そしてどれくらい確かか。
   * LOW は「ラベルの無い3連から読んだ」= 要確認(§39)。
   */
  confidence: DimensionConfidence | null;
  /** 補完したときの元記載。診断ログに出す。 */
  matchedText: string | null;
  note: string | null;
}

/** 在庫側から渡す事実。pipeline が既に読み込んでいるものをそのまま渡す。 */
export interface InventoryFacts {
  id: string;
  displayInventoryId: string | null;
  sku: string | null;
  name: string | null;
  salePriceYen: number | null;
  plannedSalePriceYen: number | null;
  purchasePriceYen: number | null;
  saleStartDate: string | null;
  width: string | null;
  depth: string | null;
  height: string | null;
  quantity: number | null;
  categoryName: string | null;
  statusName: string | null;
}

export interface ResolvedProductContext {
  identity: {
    inventoryId: string | null;
    displayInventoryId: string | null;
    sku: string | null;
    baseItemId: string | null;
    baseItemUrl: string | null;
    productName: Sourced<string> | null;
  };
  commerce: {
    currentSalePriceYen: Sourced<number> | null;
    purchasePriceYen: number | null;
    saleStartedAt: string | null;
    inventoryAgeDays: number | null;
    quantity: number | null;
  };
  dimensions: ProductDimensions;
  details: {
    material: Sourced<string> | null;
    color: Sourced<string> | null;
    brand: Sourced<string> | null;
    modelNumber: Sourced<string> | null;
    weight: Sourced<string> | null;
    condition: Sourced<string> | null;
    categoryName: string | null;
    statusName: string | null;
  };
  shipping: {
    /** 3辺から出した配送ランク。寸法が足りなければ null。 */
    rank: string | null;
    sumCm: number | null;
    /** どの出典の寸法で計算したか(§33)。 */
    sizeSource: ProductFieldSource | null;
    /**
     * BASEの商品説明に明記されていた配送ランク。
     *
     * 寸法が3辺そろわない商品(円形スツール等)でも、説明文にランクが
     * 書かれていれば送料を出せる。推定ではなくBELLOが決めた値なので、
     * 寸法から起こすより正確。
     */
    declaredRank: { rank: string; matchedText: string } | null;
  };
  sources: {
    inventory: boolean;
    baseArchive: boolean;
    baseLive: boolean;
  };
  /** 何をどこから補ったか。AI処理ログと管理画面に出す(§33)。 */
  completionNotes: string[];
  /** 人の確認が要る点(低信頼の寸法など §39)。 */
  reviewReasons: string[];
}

function sourced<T>(value: T | null | undefined, source: ProductFieldSource): Sourced<T> | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return { value, source };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return null;
  const days = Math.floor((Date.now() - started) / (24 * 60 * 60 * 1000));
  return days >= 0 ? days : null;
}

/**
 * 在庫の寸法が3辺そろっているか。
 *
 * 1辺でも欠けていたら補完へ回す。足りない辺だけをBASEから足して合計を
 * 出すことはしない —— 出所の違う数字を足した合計は追跡できないし、
 * 同じ商品の別個体の寸法を混ぜている可能性がある。
 */
function inventoryDimensionsComplete(inventory: InventoryFacts | null): boolean {
  if (!inventory) return false;
  return calculateShippingRankFromDimensions(inventory.width, inventory.depth, inventory.height) != null;
}

export interface BuildProductContextParams {
  inventory: InventoryFacts | null;
  /** 特定済みのBASE商品(pipeline が既に引いているもの)。 */
  baseProduct?: {
    baseItemId: string;
    title: string | null;
    price: number | null;
    itemUrl: string | null;
    description: string | null;
    source: "archive" | "api";
  } | null;
  /**
   * BASE商品IDだけ分かっていて中身が手元に無い場合に、取りに行くか。
   *
   * 既定は true。**寸法が足りないときにだけ**呼ぶ(§32の順序)。
   * 情報が足りているのに毎回BASEへ問い合わせると、返信が遅くなるだけで
   * 何も良くならない。
   */
  fetchBaseIfMissing?: boolean;
  /** 取得に使うBASE商品ID(baseProduct が無いとき)。 */
  baseItemId?: string | null;
  baseItemUrl?: string | null;
}

/**
 * 統合された商品文脈を組み立てる。
 *
 * BASEへの問い合わせは**必要なときだけ**行う:
 *   - 在庫の寸法が3辺そろっていない、かつ
 *   - BASE商品IDが分かっている、かつ
 *   - 手元に商品説明が無い
 */
export async function buildResolvedProductContext(
  params: BuildProductContextParams,
): Promise<ResolvedProductContext> {
  const inventory = params.inventory;
  const completionNotes: string[] = [];
  const reviewReasons: string[] = [];

  let baseProduct = params.baseProduct ?? null;
  const dimensionsComplete = inventoryDimensionsComplete(inventory);

  // §32 送料計算の前に、サイズが足りているかを見る。足りていれば
  // BASEへは問い合わせない。
  const needsBase = !dimensionsComplete;
  const baseItemId = baseProduct?.baseItemId ?? params.baseItemId ?? null;
  if (needsBase && !baseProduct?.description && baseItemId && (params.fetchBaseIfMissing ?? true)) {
    const looked = await lookupBaseProduct(baseItemId);
    if (looked.source !== "not-found") {
      baseProduct = {
        baseItemId: looked.baseItemId,
        title: looked.title,
        price: looked.price,
        itemUrl: looked.itemUrl,
        description: looked.description,
        source: looked.source === "api" ? "api" : "archive",
      };
      completionNotes.push(
        `商品情報をBASE(${looked.source === "api" ? "商品ページ" : "取り込み済みデータ"})から取得しました。`,
      );
    } else if (!baseProduct) {
      completionNotes.push("BASEから商品情報を取得できませんでした(削除済み・非公開・未接続のいずれか)。");
    }
  }

  const baseSource: ProductFieldSource | null = baseProduct
    ? baseProduct.source === "api"
      ? "BASE_LIVE"
      : "BASE_ARCHIVE"
    : null;
  const baseText = baseProduct?.description ? descriptionToPlainText(baseProduct.description) : "";

  // ── 寸法(§30 補完方式) ────────────────────────────────────────
  const dimensions: ProductDimensions = {
    width: null,
    depth: null,
    height: null,
    confidence: null,
    matchedText: null,
    note: null,
  };
  let sizeSource: ProductFieldSource | null = null;

  if (dimensionsComplete && inventory) {
    dimensions.width = sourced(inventory.width, "INVENTORY");
    dimensions.depth = sourced(inventory.depth, "INVENTORY");
    dimensions.height = sourced(inventory.height, "INVENTORY");
    dimensions.confidence = "HIGH";
    dimensions.note = "在庫データの寸法を使いました。";
    sizeSource = "INVENTORY";
  } else if (baseText && baseSource) {
    const extracted = extractDimensionsFromText(baseText);
    if (extracted) {
      dimensions.width = { value: extracted.widthCm, source: baseSource };
      dimensions.depth = { value: extracted.depthCm, source: baseSource };
      dimensions.height = { value: extracted.heightCm, source: baseSource };
      dimensions.confidence = extracted.confidence;
      dimensions.matchedText = extracted.matchedText;
      dimensions.note = extracted.note;
      sizeSource = baseSource;
      completionNotes.push(
        `サイズ：${PRODUCT_FIELD_SOURCE_LABEL[baseSource]}から補完(${extracted.matchedText})。`,
      );
      if (extracted.confidence === "LOW") {
        // §39 曖昧な数値を無理に採用しない。使うが、必ず人へ知らせる。
        reviewReasons.push(
          `送料の計算に使ったサイズは、商品説明の「${extracted.matchedText}」から読み取ったものです(幅・奥行・高さのラベルが無いため確認してください)。`,
        );
      }
    } else {
      completionNotes.push("BASEの商品説明にも、送料判定に使える寸法の記載がありませんでした。");
    }
  }

  // ── 配送ランク ────────────────────────────────────────────────
  const rankResult =
    dimensions.width && dimensions.depth && dimensions.height
      ? calculateShippingRankFromDimensions(dimensions.width.value, dimensions.depth.value, dimensions.height.value)
      : null;

  // ── 明記された配送ランク ──────────────────────────────────────
  //
  // 寸法が読めない商品でも、説明文にランクが書かれていれば送料は出せる。
  // 実測: HAY REVOLVER BAR STOOL は「座面直径34cm / 脚幅44cm / 高さ75cm」で
  // 幅・奥行・高さの3辺が無く寸法抽出が null になり「想定送料：不明」に
  // なっていたが、同じ説明文に「家財おまかせ便Bランク」と明記されていた。
  const declaredRank = baseText ? extractShippingRankFromText(baseText) : null;
  if (!rankResult && declaredRank) {
    completionNotes.push(`配送ランク：BASEの商品説明の「${declaredRank.matchedText}」から読み取りました。`);
  }

  // ── 属性(§31) ─────────────────────────────────────────────────
  const attributes = baseText ? extractAttributesFromText(baseText) : null;

  // ── 販売価格 ──────────────────────────────────────────────────
  //
  // 在庫の salePrice → plannedSalePrice → BASEの掲載価格。BASEを最後に
  // 置くのは、BELLO側の価格が正本だから。ただし在庫に価格が1つも入って
  // いなければ、実際に顧客が見ている価格はBASEの掲載価格である。
  const currentSalePrice =
    sourced(inventory?.salePriceYen ?? null, "INVENTORY") ??
    sourced(inventory?.plannedSalePriceYen ?? null, "INVENTORY") ??
    (baseProduct && baseSource ? sourced(baseProduct.price, baseSource) : null);

  if (currentSalePrice && currentSalePrice.source !== "INVENTORY") {
    completionNotes.push("販売価格：在庫データに価格が無いため、BASEの掲載価格を使いました。");
  }

  const productName =
    sourced(inventory?.name ?? null, "INVENTORY") ??
    (baseProduct && baseSource ? sourced(baseProduct.title, baseSource) : null);

  return {
    identity: {
      inventoryId: inventory?.id ?? null,
      displayInventoryId: inventory?.displayInventoryId ?? null,
      sku: inventory?.sku ?? null,
      baseItemId: baseProduct?.baseItemId ?? params.baseItemId ?? null,
      baseItemUrl: baseProduct?.itemUrl ?? params.baseItemUrl ?? null,
      productName,
    },
    commerce: {
      currentSalePriceYen: currentSalePrice,
      purchasePriceYen: inventory?.purchasePriceYen ?? null,
      saleStartedAt: inventory?.saleStartDate ?? null,
      inventoryAgeDays: daysSince(inventory?.saleStartDate ?? null),
      quantity: inventory?.quantity ?? null,
    },
    dimensions,
    details: {
      material: attributes && baseSource ? sourced(attributes.material, baseSource) : null,
      color: attributes && baseSource ? sourced(attributes.color, baseSource) : null,
      brand: attributes && baseSource ? sourced(attributes.brand, baseSource) : null,
      modelNumber: attributes && baseSource ? sourced(attributes.modelNumber, baseSource) : null,
      weight: attributes && baseSource ? sourced(attributes.weight, baseSource) : null,
      condition: attributes && baseSource ? sourced(attributes.condition, baseSource) : null,
      categoryName: inventory?.categoryName ?? null,
      statusName: inventory?.statusName ?? null,
    },
    shipping: {
      rank: rankResult?.rank ?? declaredRank?.rank ?? null,
      sumCm: rankResult?.sumCm ?? null,
      sizeSource,
      declaredRank,
    },
    sources: {
      inventory: inventory != null,
      baseArchive: baseSource === "BASE_ARCHIVE",
      baseLive: baseSource === "BASE_LIVE",
    },
    completionNotes,
    reviewReasons,
  };
}

/**
 * 送料計算へ渡す寸法。**統合後の値**を使う。
 *
 * ここを経由させることで、在庫にサイズが無い商品でも
 * 「BASEから補完した寸法で送料を出す」経路が既定になる(§32)。
 */
export function shippingDimensionsOf(
  context: ResolvedProductContext,
): { width: string | null; depth: string | null; height: string | null } {
  return {
    width: context.dimensions.width?.value ?? null,
    depth: context.dimensions.depth?.value ?? null,
    height: context.dimensions.height?.value ?? null,
  };
}

/** 診断ログ・通知用の1行(§33「サイズ：BASE商品ページから補完」)。 */
export function sizeSourceNote(context: ResolvedProductContext): string | null {
  if (!context.shipping.sizeSource) return null;
  return `サイズ：${PRODUCT_FIELD_SOURCE_LABEL[context.shipping.sizeSource]}`;
}
