import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { listAllPages } from "@/lib/amplify/listAll";
import { getInventoryDetail } from "@/lib/inventory/queries";
import { listAllMasterEntries } from "@/lib/inventory/masters";
import { baseBrandHint, type ArchivedStyleReference } from "@/lib/base/archive/similar";
import { inferCategory, type BelloStyleProfile } from "@/lib/ai/productIntro/styleProfile";
import { generateProductPage, type ProductPageResult } from "./service";
import { buildGuidanceBlock, listActiveGuidance, type GuidanceRule } from "./guidance";
import { resolveLinkedBaseItem, type BaseLink } from "./baseLink";
import { buildResolvedProductContext, type ResolvedProductContext } from "@/lib/inquiry/productContext";
import { buildListingFacts, type ListingFacts } from "./listingFacts";
import {
  buildConditionSection,
  buildProductDetailSection,
  buildShippingSection,
} from "./descriptionSections";

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
/** 過去BASE商品の生の行。文体の参考にも、同一商品の照合にも使う。 */
export interface ArchiveRow {
  baseItemId: string;
  title?: string | null;
  titleCore?: string | null;
  price?: number | null;
  introText?: string | null;
}

/**
 * 過去BASE商品を読む。
 *
 * 267件・約2.7MBある。**1回の生成で2回読まない**ために、生の行を返す
 * この関数を1つ置き、文体の参考(loadStyleArchive)と同一商品の照合
 * (baseLink.ts)がそこから派生する。以前はそれぞれが読んでいたわけでは
 * ないが、§44 で照合が加わるときに二度読みになるところだった。
 */
export async function loadArchiveRows(): Promise<ArchiveRow[]> {
  return listAllPages<ArchiveRow>(
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
}

/** 文体の参考にできる形へ。紹介文が無い行は文体の見本にならないので落とす。 */
export function toStyleReferences(rows: ArchiveRow[]): ArchivedStyleReference[] {
  return rows
    .filter((row) => Boolean(row.introText))
    .map((row) => ({
      baseItemId: row.baseItemId,
      titleCore: row.titleCore ?? row.title ?? "",
      brand: baseBrandHint(row.title ?? ""),
      category: inferCategory(row.title ?? ""),
      price: row.price ?? null,
      introText: row.introText!,
    }));
}

/** 文体の参考にする過去BASE商品(既存の呼び出し口。中身は上の2つの合成)。 */
export async function loadStyleArchive(): Promise<ArchivedStyleReference[]> {
  return toStyleReferences(await loadArchiveRows());
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
  /** 適用したACTIVEな改善指示。 */
  activeGuidance: GuidanceRule[];
  /**
   * 同一商品として結び付いたBASE商品(2026-09-03 追加指示 §44)。
   * 見つからなければ null —— まだBASEへ出していない在庫では普通のこと。
   */
  baseLink: BaseLink | null;
  /** 在庫に無くBASEから補った項目の記録(§33 出典を必ず持つ)。 */
  completionNotes: string[];
  /**
   * ルールで確定させた事実一式(2026-09-04 EC出品改修指示書 §20/§21)。
   *
   * 画面の右パネル・警告表示・監査で使う。生成に失敗しても、ここまでは
   * 必ず確定しているので返す。
   */
  facts: ListingFacts;
  /**
   * 担当者へ出す警告(§21)。座面寸法が無い・配送ランクを確定できない等。
   * 生成そのものは止めない —— 分からないことを分からないまま渡す。
   */
  warnings: string[];
  /** どのメンテナンス文・状態文をどの根拠で入れたか(監査用)。 */
  ruleNotes: string[];
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

  const [archiveRows, styleProfile, categories, guidance] = await Promise.all([
    loadArchiveRows(),
    loadActiveStyleProfile(),
    listAllMasterEntries("Category"),
    listActiveGuidance(),
  ]);
  const archive = toStyleReferences(archiveRows);
  const categoryName = categories.find((c: { id: string; name: string }) => c.id === item.categoryId)?.name ?? null;

  // ── BASEからの補完(2026-09-03 追加指示 §44) ────────────────
  //
  // 在庫にサイズ・素材・ブランドが無くても、同じ商品がBASEに出ていれば
  // そこに書いてあることがある。**同一商品と言い切れる根拠がある場合だけ**
  // 使う(baseLink.ts) —— 文体の参考にしている「似ている商品」の寸法を
  // 使うと、別商品の事実をこの商品の説明へ書き込むことになる。
  //
  // 補完に失敗しても生成は止めない。空欄で返すのがこれまでの動きで、
  // それは正しい挙動なのだから、補完できないときはそこへ戻るだけでよい。
  let baseLink: BaseLink | null = null;
  let productContext: ResolvedProductContext | null = null;
  const completionNotes: string[] = [];
  try {
    baseLink = await resolveLinkedBaseItem(item.id, item.name, archiveRows);
    if (baseLink) {
      completionNotes.push(`BASE商品 ${baseLink.baseItemId} と結び付けました(${baseLink.reason})`);
      productContext = await buildResolvedProductContext({
        inventory: {
          id: item.id,
          displayInventoryId: null,
          sku: item.sku ?? null,
          name: item.name,
          salePriceYen: item.salePrice ?? null,
          plannedSalePriceYen: item.plannedSalePrice ?? null,
          purchasePriceYen: item.purchasePrice ?? null,
          saleStartDate: item.saleStartDate ?? null,
          width: item.width ? String(item.width) : null,
          depth: item.depth ? String(item.depth) : null,
          height: item.height ? String(item.height) : null,
          quantity: item.quantity ?? null,
          categoryName,
          statusName: null,
        },
        baseItemId: baseLink.baseItemId,
      });
      completionNotes.push(...productContext.completionNotes);
    }
  } catch (err) {
    // §19 黙って「BASEに情報が無かった」ことにしない。
    completionNotes.push(
      `BASE商品情報を参照できませんでした: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  /** 在庫の値を優先し、無いときだけBASEの値を使う(§30 補完方式)。 */
  const completed = (
    inventoryValue: string | null,
    fromBase: string | null,
    label: string,
  ): string | null => {
    if (inventoryValue && inventoryValue.trim() !== "") return inventoryValue;
    if (!fromBase) return null;
    completionNotes.push(`${label}：BASE商品ページから補完(${fromBase})`);
    return fromBase;
  };

  const dims = productContext?.dimensions ?? null;
  // 寸法は3辺そろって初めて意味がある。1辺だけBASEから足すと、出所の
  // 違う数字を並べた寸法表記になる。productContext は3辺そろったときしか
  // 値を持たないので、ここはそのまま渡してよい。
  const width = completed(item.width ? String(item.width) : null, dims?.width?.value ?? null, "幅");
  const depth = completed(item.depth ? String(item.depth) : null, dims?.depth?.value ?? null, "奥行");
  const height = completed(item.height ? String(item.height) : null, dims?.height?.value ?? null, "高さ");

  // ── ルールで確定させる領域(2026-09-04 §19) ────────────────────
  //
  // 寸法・座面寸法・配送ランク・佐川サイズ・メンテナンス内容・傷汚れは
  // 在庫データから機械的に決まる。AIに渡すのは「◎商品のご紹介」に必要な
  // ものだけで、確定した文章は生成後に差し替えるのではなく**最初から
  // ルール側で作る** —— 差し替え方式にすると、AIが書いた誤った寸法が
  // どこかの経路で残る余地ができる。
  const brand = completed(baseBrandHint(item.name), productContext?.details.brand?.value ?? null, "ブランド");
  const customFields = (item.customFields ?? {}) as Record<string, unknown>;
  const customFieldText = (key: string): string | null => {
    const v = customFields[key];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };

  const facts = buildListingFacts({
    name: item.name,
    categoryName,
    brand,
    width,
    depth,
    height,
    overallLength: item.overallLength ?? null,
    seatDimensionsField: customFieldText("seatDimensions"),
    material: customFieldText("material"),
    conditionRating: item.conditionRating ?? null,
    damageNotes: item.damageNotes ?? null,
    note: item.note ?? null,
    listingNotes: item.listingNotes ?? null,
    adminMemo: item.adminMemo ?? null,
  });

  const conditionSection = buildConditionSection({
    maintenance: facts.maintenance,
    nonFabric: facts.nonFabric,
    conditionDisclosure: facts.safe.conditionDisclosure,
    goodConditionEvidence: facts.goodConditionEvidence,
  });

  const ruleSections = {
    productDetail: buildProductDetailSection({
      width: facts.width,
      depth: facts.depth,
      height: facts.height,
      overallLength: facts.overallLength,
      seat: facts.seat,
    }),
    shipping: buildShippingSection({ rank: facts.shippingRank, unresolvedReason: facts.shippingRankReason }),
    condition: conditionSection.text,
  };

  const result = await generateProductPage({
    inventoryId: item.id,
    name: item.name,
    categoryName,
    width,
    depth,
    height,
    ruleSections,
    extraFacts: { brand, material: facts.material },
    damageNotes: item.damageNotes ?? null,
    note: item.note ?? null,
    conditionRating: item.conditionRating ?? null,
    stockQuantity: item.quantity ?? null,
    sku: item.sku ?? null,
    price: item.salePrice ?? item.plannedSalePrice ?? null,
    // ブランドは在庫の商品名から機械的に導いたものを優先し、無ければ
    // BASEの商品説明に「ブランド：」と明示されているものを使う。
    // どちらも無ければ null のまま —— 推測して書かせない。
    // (上の facts 組み立てで既に解決済みの値を使い回す。同じ補完を
    //  2回走らせると completionNotes に同じ行が2つ並ぶ。)
    brand,
    archive,
    styleProfile: styleProfile?.profile ?? null,
    styleProfileVersion: styleProfile?.version ?? null,
    guidanceBlock: buildGuidanceBlock(guidance),
    appliedGuidance: guidance.map((g) => g.instruction),
  });

  return {
    ...result,
    inventoryId: item.id,
    inventoryName: item.name,
    usedStyleProfileVersion: styleProfile?.version ?? null,
    archiveSize: archive.length,
    activeGuidance: guidance,
    baseLink,
    completionNotes,
    facts,
    warnings: [...facts.warnings, ...conditionSection.warnings],
    ruleNotes: conditionSection.notes,
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
