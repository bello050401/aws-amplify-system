import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { baseBrandHint, type ArchivedStyleReference } from "@/lib/base/archive/similar";
import { inferCategory, type BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";
import { generateProductPage, type ProductPageResult } from "./service";

/**
 * 商品説明生成の**正本**(2026-09-02 指示書§2/§10)。
 *
 * ── 何を一本化したのか ──────────────────────────────────────────
 *
 * EC出品画面には生成の入口が2つあった:
 *
 *   上側「出品下書き」  → app/actions/ai.ts → lib/ai/ecCopy.ts
 *   下側「BASE商品ページの下書きを作る」 → lib/ai/productPage/service.ts
 *
 * 同じ目的なのに中身がまるごと別で、品質差の原因も別ではなく**片方に
 * だけ機能が付いていた**という単純な話だった:
 *
 *                          上側(ecCopy)   下側(productPage)
 *   BELLO Style Profile参照      無し           あり
 *   類似BASE商品の参照           無し           あり
 *   セクション構造(◎見出し)      無し           あり
 *   紹介文の寸法除外検査          無し           あり
 *   missing facts の提示         無し           あり
 *   生成メタデータの保存          無し           あり
 *
 * 上側は「タイトル + 説明文 + コンディション + 箇条書き」を1回のAI呼び
 * 出しで作るだけで、過去267件の文体分析にも類似商品にも一切触れて
 * いなかった。だから一般的なEC文章になり、寸法が紹介文へ混ざった。
 *
 * そこで**下側を正本**にし、上側からも同じ関数を呼ぶ。生成コアを
 * 複製しない —— チャネルごとの差はこの後ろの formatter で吸収する。
 */

/**
 * 文体の参考にする過去BASE商品を読む。
 *
 * 267件・約2.7MBなので毎回読むのは無駄がある一方、生成は「ボタンを
 * 押したとき」にしか起きない低頻度の操作なので、キャッシュを持って
 * 古い文体を参照し続けるより、その都度読む方が素直で安全。
 */
export async function loadStyleArchive(): Promise<ArchivedStyleReference[]> {
  const rows = await listAllPages<{
    baseItemId: string;
    title?: string | null;
    titleCore?: string | null;
    price?: number | null;
    introText?: string | null;
  }>(
    async (nextToken) => {
      const res = await serverDataClient.models.BaseProductArchive.list({
        limit: 200,
        nextToken,
        ...inventoryAuthMode,
      });
      return { data: res.data as never[], nextToken: res.nextToken, errors: res.errors };
    },
    { label: "過去BASE商品" },
  );

  return rows
    .filter((row) => Boolean(row.introText)) // 紹介文が無いものは文体の参考にならない
    .map((row) => ({
      baseItemId: row.baseItemId,
      titleCore: row.titleCore ?? row.title ?? "",
      brand: baseBrandHint(row.title ?? ""),
      category: inferCategory(row.title ?? ""),
      price: row.price ?? null,
      introText: row.introText!,
    }));
}

/** 現在有効な Style Profile(isActive の1件)。無ければ null。 */
export async function loadActiveStyleProfile(): Promise<{ profile: BelloStyleProfile; version: number } | null> {
  const { data, errors } = await serverDataClient.models.BelloStyleProfile.list({ ...inventoryAuthMode, limit: 100 });
  if (errors) throw new Error(`文体プロファイルの取得に失敗しました: ${errors.map((e) => e.message).join("; ")}`);
  const active = data.find((d) => d.isActive === true);
  if (!active?.profileJson) return null;
  return { profile: JSON.parse(active.profileJson) as BelloStyleProfile, version: active.version };
}

export interface CanonicalGenerationResult extends ProductPageResult {
  /** どの在庫から作ったか。 */
  inventoryId: string;
  /** 生成に使った在庫の商品名(監査用)。 */
  inventoryName: string;
  /** 参照した Style Profile の version(0件なら null)。 */
  usedStyleProfileVersion: number | null;
  /** 参照した過去BASE商品の総数(母集団の大きさ)。 */
  archiveSize: number;
}

/**
 * 在庫IDから商品説明を生成する、唯一の入口。
 *
 * EC出品画面の上側も下側も、他のどのチャネル向けの下書きも、必ずここを
 * 通す。生成contextには毎回:
 *
 *   Inventoryの確定事実 / ACTIVE Style Profile / 類似BASE商品 / validator
 *
 * が入る(指示書§10)。どれを使ったかは戻り値に載るので、管理者が
 * 追跡できる。
 */
export async function generateCanonicalProductPage(inventoryId: string): Promise<CanonicalGenerationResult> {
  const item = await getInventoryDetail(inventoryId);
  if (!item) throw new Error("対象の在庫が見つかりません。");

  const [archive, styleProfile, categories] = await Promise.all([
    loadStyleArchive(),
    loadActiveStyleProfile(),
    listAllMasterEntries("Category"),
  ]);
  const categoryName = categories.find((c: { id: string; name: string }) => c.id === item.categoryId)?.name ?? null;

  const result = await generateProductPage({
    inventoryId: item.id,
    name: item.name,
    categoryName,
    width: item.width ? String(item.width) : null,
    depth: item.depth ? String(item.depth) : null,
    height: item.height ? String(item.height) : null,
    damageNotes: item.damageNotes ?? null,
    note: item.note ?? null,
    conditionRating: item.conditionRating ?? null,
    stockQuantity: item.quantity ?? null,
    sku: item.sku ?? null,
    price: item.salePrice ?? item.plannedSalePrice ?? null,
    brand: baseBrandHint(item.name),
    archive,
    styleProfile: styleProfile?.profile ?? null,
    styleProfileVersion: styleProfile?.version ?? null,
  });

  return {
    ...result,
    inventoryId: item.id,
    inventoryName: item.name,
    usedStyleProfileVersion: styleProfile?.version ?? null,
    archiveSize: archive.length,
  };
}

/**
 * 生成結果を「出品下書き」の形へ落とす(チャネル差はここで吸収する)。
 *
 * 生成コアを複製せず、**同じ生成結果を出力形式だけ変えて使う**という
 * 指示書§24の要求そのもの。Mercari/BASE でタイトル長や本文の作りが
 * 違うなら、この関数を増やす(生成そのものは1つのまま)。
 */
export interface ListingDraftCopy {
  title: string;
  description: string;
  conditionText: string;
  sellingPoints: string[];
}

export function toListingDraftCopy(result: ProductPageResult): ListingDraftCopy | null {
  if (!result.sections) return null;
  const s = result.sections;
  return {
    title: s.title,
    // 掲載用本文はセクション見出し付きの完成形をそのまま使う。
    // 上側の下書きでも「◎商品のご紹介 / ◎サイズ / ◎コンディション」の
    // 構造がそのまま得られる —— これが上下の品質差の正体だった。
    description: result.fullDescription ?? s.introduction,
    conditionText: s.conditionSection,
    // 箇条書きは「特徴」セクションの行を流用する。無理に作らない。
    sellingPoints: (s.featureSection ?? "")
      .split("\n")
      .map((l) => l.replace(/^[・\-*\s]+/, "").trim())
      .filter((l) => l.length > 0)
      .slice(0, 5),
  };
}
