import "server-only";
import { generateText } from "@/lib/ai/gateway/gateway";
import { buildCustomerSafeFacts, type CustomerSafeFacts } from "@/lib/ai/productIntro/facts";
import { getInventoryDetail, listCategories, listStatuses } from "@/lib/inventory/queries";
import { lookupShippingRate } from "@/lib/shipping/service";
import {
  calculateShippingRankFromDimensions,
  SHIPPING_RANKS,
  type ShippingRank,
  type ShippingRankSource,
} from "@/lib/shipping/rank";
import { listSearchableKnowledge } from "@/lib/knowledge/store";
import { retrieveKnowledge } from "@/lib/knowledge/retrieval";
import { extractIntents, hasProductIndependentIntent, requiresProduct } from "./intent";
import { resolveNegotiationContext } from "./negotiation";
import { resolveNegotiation, type NegotiationInventoryFacts } from "./negotiationService";
import { resolveProductFromInquiry } from "./productResolver";
import { effectiveListThumbnailKey, resolveTopImage } from "@/lib/inventory/imageTypes";
import {
  decideUrlRequest,
  identificationBasis,
  linkedBaseProduct,
  PRODUCT_URL_REQUEST_TEMPLATE,
} from "./productIdentification";
import { getAIReplySettings } from "./settings";
import { extractShippingDestination, missingShippingInfo } from "./shippingIntent";
import { buildInquirySystemPrompt, buildInquiryUserPrompt, INQUIRY_PROMPT_VERSION } from "./prompt";
import { REPLY_MAX_GENERATION_ATTEMPTS, validateReplyDraft } from "./validate";
import { createDirectUrlProvider, getAgentCoreGatewayUrl, getWebResearchAvailability, researchMissingFacts } from "./research/service";
import { createAgentCoreSearchProvider } from "./research/agentCoreProvider";
import { brandsInText, officialDomainsForBrands } from "./research/officialDomains";
import { nameCore } from "./scoring";
import { extractBaseItemId, extractUrls, isBaseUrl } from "./references";
import {
  addPendingQuestions,
  clearPendingQuestions,
  detectAskedQuestions,
  emptyConversationContext,
  mergeConversationContext,
  switchesProduct,
  knownFacts,
  type ConversationContext,
} from "./conversationContext";
import type { PendingQuestion, PendingQuestionField } from "./conversationContext";
import { resolvePendingAnswers } from "./pendingAnswer";
import { buildResolvedProductContext, shippingDimensionsOf, type ResolvedProductContext } from "./productContext";
import { selectReplyRules, type ReplyRuleRecord } from "./replyRuleSelection";
import { listActiveReplyRules } from "./replyRuleStore";
import type { MessageChannel } from "@/lib/messaging/types";
import type {
  ExternalResearchFact,
  InquiryIntent,
  InquiryReplyRequest,
  ProductResolutionStatus,
  ReplyDraftStatus,
  ReplyEvidence,
  ShippingEvidence,
  UnresolvedFact,
  IdentifiedProductCard,
} from "./types";

/**
 * §11 AI返信パイプライン。チャネルに依存しない(§16)。
 *
 * 呼び出し側(Server Action)はチャネル名と本文を渡すだけで、LINE固有の
 * ことは何も知らない。将来BASE・メール・Instagramが増えても、
 * 会話とメッセージの形さえ同じなら、この関数はそのまま使える。
 *
 * 【段階ごとに「できなかった」を返す】どこかが失敗しても全体を落とさない。
 * 商品が特定できなくても営業時間には答えられるし、外部調査ができなくても
 * 在庫情報だけで答えられることは答える。何ができて何ができなかったかは
 * ReplyEvidenceに残し、画面に出す(§19「成功したふり」を禁止)。
 */

export interface GenerateInquiryReplyResult {
  status: ReplyDraftStatus;
  draftText: string | null;
  evidence: ReplyEvidence;
  intents: InquiryIntent[];
  unresolvedFacts: UnresolvedFact[];
  modelProvider: string | null;
  modelName: string | null;
  /** 生成できなかった場合の、管理者向けの理由。 */
  failureReason: string | null;
  /**
   * この処理で分かったことを反映した会話文脈(§17-§24)。
   *
   * 呼び出し側(autoReply)がそのまま保存する。**返信案を作れなかった場合も
   * 返す** —— 商品が特定できたのに返信生成で失敗したとき、次のターンで
   * また商品特定からやり直すのは無駄で、しかも同じ結果になる保証が無い。
   */
  context: ConversationContext;
  /** 今回の返信で新たに顧客へ尋ねた項目。通知に出す。 */
  askedQuestions: string[];
  /** 今回のメッセージで解消した確認事項。通知に出す。 */
  answeredQuestions: string[];
  /**
   * 今回解消した確認事項の項目。**保存側がやり直しても同じ結果になるように**
   * 文字列ではなく項目で返す(contextStore は競合時にマージをやり直す)。
   */
  resolvedPendingFields: PendingQuestionField[];
  /** 今回新たに尋ねた確認事項。同上。 */
  askedPendingQuestions: PendingQuestion[];
  /** 引き継いだ情報(§27 社内通知の「引き継いだ情報」)。 */
  carriedFacts: { label: string; value: string }[];
  /** 商品情報をどこから補完したか(§33)。 */
  productContextNotes: string[];
}

/** 顧客向けに出してよい在庫の項目。ここに無いものはAIへ渡さない。 */
const CUSTOMER_SAFE_INVENTORY_FIELDS = ["商品名", "カテゴリー", "サイズ", "状態", "商品説明", "販売状況"] as const;

/** 会話文脈の項目を除いた返信結果。生成処理の中ではこの形で組み立てる。 */
type BaseReplyResult = Omit<
  GenerateInquiryReplyResult,
  | "context"
  | "askedQuestions"
  | "answeredQuestions"
  | "resolvedPendingFields"
  | "askedPendingQuestions"
  | "carriedFacts"
  | "productContextNotes"
>;

export async function generateInquiryReplyDraft(request: InquiryReplyRequest): Promise<GenerateInquiryReplyResult> {
  const settings = await getAIReplySettings();
  const messageText = normalizeMessage(request.messageText);

  // ── 会話文脈(2026-09-03 追加指示 §17-§24) ─────────────────────
  //
  // **今回のメッセージだけを見て処理しない。** 「埼玉です」の1通から
  // 商品も希望価格も読み取れるはずがない。ここまでに確定した事実を
  // 引き継いだうえで、今回分かったことを足す。
  const incomingContext = request.context ?? emptyConversationContext();
  const carriedFacts = knownFacts(incomingContext);

  // 直前の確認事項への回答か(§22)。確認待ちの項目がある場合だけ読む。
  const pendingAnswers = resolvePendingAnswers({ context: incomingContext, messageText });
  const answeredDestination = pendingAnswers.find((a) => a.field === "DESTINATION_PREFECTURE")?.value ?? null;
  const answeredDeliveryDate = pendingAnswers.find((a) => a.field === "REQUESTED_DELIVERY_DATE")?.value ?? null;

  // 更新されていく文脈。早期returnの経路でも必ず返す。
  let workingContext = clearPendingQuestions(
    incomingContext,
    pendingAnswers.map((a) => a.field),
  );
  const answeredQuestions = pendingAnswers.map((a) => a.reason);
  const resolvedPendingFields = pendingAnswers.map((a) => a.field);
  let productContextNotes: string[] = [];

  /**
   * 返信結果へ会話文脈を添えて返す。
   *
   * 返信案の**文面から**「何を尋ねたか」を読み取り、確認待ちとして積む。
   * 別のフラグで持つと文面と食い違う —— 顧客が読むのは文面のほうなので、
   * 文面を正本にする。
   */
  const finish = (base: BaseReplyResult): GenerateInquiryReplyResult => {
    const asked = detectAskedQuestions(base.draftText, new Date().toISOString());
    const context = addPendingQuestions(workingContext, asked);
    return {
      ...base,
      context,
      askedQuestions: asked.map((a) => a.askedText),
      answeredQuestions,
      resolvedPendingFields,
      askedPendingQuestions: asked,
      carriedFacts,
      productContextNotes,
    };
  };

  // ── 値下げ交渉の判定(指示書§3) ──────────────────────────────
  //
  // キーワード表(intent.ts)だけでは「こちら2脚で6万円になりませんか」を
  // 交渉として認識できなかった —— この文には「値下げ」「値引き」「安く」
  // 「交渉」のどれも現れない。金額の提示そのものを交渉として扱う
  // 決定的な抽出(negotiation.ts)を併用する。
  //
  // 配送先の回答(「埼玉県です」)だけが届いた場合は、直前の交渉条件を
  // 引き継ぐ。引き継ぐ条件をここまで狭くしているのは、普通の問い合わせ
  // にまで配送先を聞き返す回帰を防ぐため(指示書§16)。
  const destinationFromCurrent = extractShippingDestination(messageText);
  // 「埼玉です」は確認事項への回答としても読める。どちらで読めても同じ値。
  const currentDestination = destinationFromCurrent.prefecture ?? answeredDestination;
  let negotiation = resolveNegotiationContext({
    currentText: messageText,
    history: request.history,
    currentHasDestination: currentDestination != null,
  });

  const keywordIntents = extractIntents(messageText);

  // ── 交渉の引き継ぎ(§21) ───────────────────────────────────────
  //
  // 会話文脈に「交渉中」が残っていれば、今回の本文が交渉に見えなくても
  // 交渉として続ける。resolveNegotiationContext は本文と履歴だけを見る
  // 実装で、引き継ぐ条件を「配送先の回答のとき」に限っていた。文脈を
  // 持てるようになった以上、そこはもう本文の推測に頼らない。
  //
  // ただし**無条件には引き継がない**。一度交渉があった会話で以降ずっと
  // 交渉として扱うと、「サイズを教えてください」にまで配送先を聞き返す
  // (2026-09-02 指示書§16が名指しで禁じた回帰)。引き継ぐのは
  //   ・確認事項への回答である、または
  //   ・今回の本文が独立した別の話題を持っていない
  // ときだけにする。
  const currentBaseItemIds = extractUrls(messageText)
    .filter((u) => isBaseUrl(u))
    .map((u) => extractBaseItemId(u))
    .filter((id): id is string => id != null);
  const productSwitched = switchesProduct(incomingContext, currentBaseItemIds);
  const currentHasOwnTopic = keywordIntents.some((i) => i !== "OTHER" && i !== "NEGOTIATION");
  const carryNegotiation =
    !negotiation.isNegotiation &&
    incomingContext.negotiation.active &&
    !productSwitched &&
    (pendingAnswers.length > 0 || !currentHasOwnTopic);

  if (carryNegotiation) {
    negotiation = {
      isNegotiation: true,
      signals: ["(この会話の引き継ぎ情報から: 値下げ交渉の続き)"],
      quantity: incomingContext.negotiation.quantity,
      quantityRaw: null,
      requestedTotalPriceYen: incomingContext.negotiation.requestedTotalPriceYen,
      requestedUnitPriceYen: incomingContext.negotiation.requestedUnitPriceYen,
      amounts: [],
      fromCurrentMessage: false,
    };
  }

  // 交渉と判定したら NEGOTIATION を必ず立てる。OTHER 単独だったものが
  // NEGOTIATION になるので、OTHER は落とす(意味のないラベルを残さない)。
  const intents: InquiryIntent[] = negotiation.isNegotiation
    ? [...new Set<InquiryIntent>(["NEGOTIATION", ...keywordIntents.filter((i) => i !== "OTHER")])]
    : keywordIntents;

  // ── 商品の特定 ────────────────────────────────────────────────
  // 商品の手がかりは今回の本文に無くても、会話の過去の受信メッセージに
  // あることがある(「(BASE URL) 2脚で6万円に…」→「埼玉県です」)。
  // 今回の本文だけで特定できなかった場合に限り、過去の受信本文も足して
  // もう一度だけ試す —— 常に履歴を混ぜると、話題が変わった会話で
  // 古い商品を引きずる。
  // 商品特定にだけ使うテキスト。メール経由の問い合わせでは、商品名・商品URLが
  // 顧客の文面ではなくメールのメタ情報として届く(types.ts の
  // productLookupText のコメント参照)。特定にはそちらを使い、
  // **プロンプトへは messageText しか渡さない**。
  const lookupText = request.productLookupText?.trim() || messageText;

  // ── 商品の引き継ぎ(§17/§21/§23) ───────────────────────────────
  //
  // 一度BASE URLで特定できた商品は、次のターンで本文にURLが無くても
  // **同じ商品の話が続いている**。特定済みのURLを照合用テキストの先頭へ
  // 戻すことで、1通目とまったく同じ経路(URL → BASE商品 → 在庫照合)を
  // 通す —— 別経路を作ると、1通目と2通目で違う商品に解決しうる。
  //
  // 顧客が**別の**BASE商品URLを送ってきたときは引き継がない
  // (switchesProduct)。話題が変わったのに古い商品を引きずるほうが有害。
  const carriedBaseUrl =
    !productSwitched && currentBaseItemIds.length === 0 ? incomingContext.identifiedProduct.baseItemUrl : null;
  const effectiveLookupText = carriedBaseUrl ? `${carriedBaseUrl}\n${lookupText}` : lookupText;
  if (carriedBaseUrl) {
    productContextNotes.push("対象商品：前のメッセージで特定したBASE商品を引き継ぎました。");
  }

  // URLが無いまま在庫だけ分かっている場合(担当者が選んだ、名前で特定した等)は、
  // 在庫IDを引き継ぐ。productResolver はこれを**候補が0件のときの拠り所**
  // としてしか使わないので、今回の本文に別の手がかりがあればそちらが勝つ。
  const carriedInventoryId =
    !productSwitched && !carriedBaseUrl ? incomingContext.identifiedProduct.inventoryId : null;

  let resolution = await resolveProductFromInquiry({
    messageText: effectiveLookupText,
    overrideInventoryId: request.overrideInventoryId ?? null,
    conversationInventoryId: request.conversationInventoryId ?? carriedInventoryId,
    productTitle: request.productTitle ?? null,
  });
  if (!resolution.resolved && negotiation.isNegotiation && !negotiation.fromCurrentMessage) {
    const inboundHistory = request.history.filter((h) => h.direction === "INBOUND").map((h) => h.body);
    if (inboundHistory.length > 0) {
      const retry = await resolveProductFromInquiry({
        // 再試行でも特定用テキストを使う。ここだけ messageText に戻すと、
        // メール経由の問い合わせで一度目に効いた手がかりが二度目に消える。
        messageText: [...inboundHistory, effectiveLookupText].join("\n"),
        overrideInventoryId: request.overrideInventoryId ?? null,
        conversationInventoryId: request.conversationInventoryId ?? carriedInventoryId,
      });
      if (retry.resolved) resolution = retry;
    }
  }

  // ── 何を根拠に商品が決まったか ────────────────────────────────
  //
  // 確信度だけでは足りない。**同じ RESOLVED でも根拠によって信頼度が
  // 違う**。商品名の断片だけで 0.9 が出ても、同名・類似商品があれば
  // 別物かもしれない。それに気づかず値下げ・価格・寸法・仕入情報を
  // 答えると実害になる。
  //
  // 逆に、URLで確実に特定できているのに「URLを送ってください」と返すのは
  // 話を聞いていないのと同じ。特定できているときは確認を挟まない。
  const basis = identificationBasis({
    status: resolution.status,
    references: resolution.references,
    fromOperatorOrConversation: Boolean(
      request.overrideInventoryId || request.conversationInventoryId || carriedInventoryId,
    ),
    candidateCount: resolution.candidates.length,
  });
  const urlRequest = decideUrlRequest({
    basis,
    status: resolution.status,
    candidateCount: resolution.candidates.length,
    requiresProduct: requiresProduct(intents),
    // §4 メルカリShopsはメール経由で、顧客は商品ページから問い合わせている。
    // 商品URLを送ってもらう導線がそもそも無いので、依頼しない。
    customerCanProvideUrl: request.channel !== "MERCARI_SHOPS",
    // 既にURLが本文にあるなら、再送を頼んでも結果は変わらない。
    //
    // §23 会話の**前のメッセージ**で送られたURLも同じ。顧客からすれば
    // 一度送ったものをもう一度求められているだけで、内部の照合が
    // うまくいかないことは顧客の責任ではない。特定できないなら社内の
    // 【要確認】として扱う。
    customerAlreadySentUrl:
      resolution.references.urls.some((u) => isBaseUrl(u)) || incomingContext.identifiedProduct.baseItemId != null,
    // BASE商品が特定できていれば、どの商品かは分かっている。
    // 在庫との紐付けが未確定なだけなので、顧客へは尋ねない。
    baseProductResolved: resolution.baseProducts.length > 0,
  });

  const unresolved: UnresolvedFact[] = [];
  const inventoryFieldsUsed: string[] = [];
  const trustedProductFacts: { label: string; value: string }[] = [];
  let facts: CustomerSafeFacts = { name: "", dimensions: null, categoryName: null, conditionDisclosure: null, publicNote: null };
  let stockQuantity: number | null = null;
  let sku: string | null = null;
  let dimensionTexts: string[] = [];

  const inventory = resolution.resolved ? await getInventoryDetail(resolution.resolved.inventoryId) : null;

  // ── 統合した在庫行のうち、代表以外も読む(2026-09-03 利用者指示) ──
  //
  // 数量は合算してよいが、**仕入価格・販売開始日・状態は行ごとに違いうる**。
  // 傷の有無で分けた行は仕入れた時期も値段も別なので、代表1件の値を商品
  // 全体の値として出すと、担当者はそれを「この商品の原価」と読んでしまう。
  // 食い違う項目は出さずに、食い違っていること自体を伝える。
  const mergedRows = resolution.resolved?.mergedRows ?? [];
  const siblingInventories =
    mergedRows.length > 1
      ? (
          await Promise.all(
            mergedRows
              .filter((r) => r.inventoryId !== resolution.resolved?.inventoryId)
              .map((r) => getInventoryDetail(r.inventoryId)),
          )
        ).filter((v): v is NonNullable<typeof v> => v != null)
      : [];

  // ── 統合した行で食い違う項目は、商品全体の値として使わない ────────
  //
  // 数量は合算してよい(同じ商品の在庫数)。しかし仕入価格・販売開始日・
  // 状態は行ごとに違いうるので、代表1件の値を商品全体の値にすると
  // 担当者はそれを「この商品の原価」と読んでしまう。値下げ判断に直結する
  // ため、食い違う項目は出さずに食い違っていること自体を伝える。
  const ambiguousAcrossRows: string[] = [];
  const siblingStatusNames: (string | null)[] = await Promise.all(
    siblingInventories.map(async (s) => (await resolveMasterLabels(s.categoryId, s.statusId))[1]),
  );
  function agreed<T>(
    label: string,
    head: T,
    pick: (sibling: (typeof siblingInventories)[number]) => T,
    precomputed?: (T | null)[],
  ): T | null {
    if (siblingInventories.length === 0) return head;
    const others = precomputed ?? siblingInventories.map(pick);
    const same = others.every((v) => v === head);
    if (same) return head;
    ambiguousAcrossRows.push(label);
    return null;
  }
  // 対象商品カード。**一意に特定できたときだけ**組み立てる —— 候補の1つを
  // 載せると、担当者がそれを確定した商品だと思い込む
  // (AMBIGUOUS のとき resolution.resolved は null なので、ここは通らない)。
  let identifiedProduct: IdentifiedProductCard | null = null;
  // カテゴリー名・販売状況はInventoryにはIDしか無いため、マスタから引く。
  // 商品が特定できていない場合は引かない(無駄な問い合わせを増やさない)。
  const [categoryName, statusName] = inventory ? await resolveMasterLabels(inventory.categoryId, inventory.statusId) : [null, null];
  if (inventory && resolution.resolved) {
    const top = resolution.resolved;
    // BASE商品ページへの導線は、この在庫と1対1で結び付いたときだけ出す。
    // 判定理由は linkedBaseProduct のコメントを参照。
    const baseMatches = resolution.baseProducts ?? [];
    const linkedBase = linkedBaseProduct(basis, baseMatches);
    // BASE商品ページのURL。取り込み済みデータ(BaseProductArchive)には
    // itemUrl が入っていない(Staging実測: 267件すべて空)ため、それだけに
    // 頼るとリンクが常に出ない。**顧客が送ってきたURLそのもの**へ落とす ——
    // 店舗ドメインをコードに埋め込まずに済み、顧客が見ているページと確実に
    // 同じものが開く。linkedBase があるのは商品URLが1件のときだけなので、
    // 取り違えようがない。
    const linkedBaseUrl = linkedBase
      ? (linkedBase.itemUrl ??
        resolution.references.urls.find((u) => isBaseUrl(u) && extractBaseItemId(u) === linkedBase.baseItemId) ??
        null)
      : null;
    identifiedProduct = {
      inventoryId: inventory.id,
      displayInventoryId: top.displayInventoryId,
      sku: inventory.sku,
      name: inventory.name,
      // 一覧と同じ選び方(トップ画像 → サムネイルがあればそちら)。
      imageKey: (() => {
        const topImage = resolveTopImage(inventory.images);
        return topImage ? effectiveListThumbnailKey(topImage) : null;
      })(),
      // 販売価格は salePrice(成約後の実売価格) → plannedSalePrice
      // (販売予定価格) の順で採る。**値下げ交渉が来るのはまだ売れて
      // いない商品**なので、その場面では salePrice が空で
      // plannedSalePrice に希望価格が入っている。salePrice だけを見ると、
      // 交渉のために作ったカードが肝心の場面で「—」になる
      // (Staging実測: plannedSalePrice しか無い在庫が265件)。
      // 値下げ判定側(下の unitSalePriceYen)と同じ選び方に揃える。
      salePriceYen: agreed(
        "販売価格",
        inventory.salePrice ?? inventory.plannedSalePrice ?? null,
        (s) => s.salePrice ?? s.plannedSalePrice ?? null,
      ),
      salePriceSource:
        inventory.salePrice != null ? "salePrice" : inventory.plannedSalePrice != null ? "plannedSalePrice" : null,
      // 仕入価格・販売開始日・状態は行ごとに違いうる。食い違うなら出さない。
      purchasePriceYen: agreed("仕入れ価格", inventory.purchasePrice ?? null, (s) => s.purchasePrice ?? null),
      saleStartedAt: agreed("販売開始日", inventory.saleStartDate ?? null, (s) => s.saleStartDate ?? null),
      statusName: agreed("在庫ステータス", statusName, () => null, siblingStatusNames),
      quantity: inventory.quantity ?? null,
      // 同一商品としてまとめた行の内訳。まとめていなければ空。
      stockRows: top.mergedRows ?? [],
      ambiguousAcrossRows,
      totalQuantity: top.mergedRows
        ? top.mergedRows.reduce<number | null>(
            // 1行でも数量不明があれば合計を出さない。足りない数を
            // 「合計」として出すと、出荷可能数を実際より少なく見せる。
            (sum, r) => (sum == null || r.quantity == null ? null : sum + r.quantity),
            0,
          )
        : (inventory.quantity ?? null),
      baseItemId: linkedBase?.baseItemId ?? null,
      baseItemUrl: linkedBaseUrl,
      // 結び付けられなかったURLは件数だけ残す。担当者が「他のURLの話かも
      // しれない」と気づける最低限の情報。
      unlinkedBaseProductCount: baseMatches.length - (linkedBase ? 1 : 0),
      basis,
    };
  }
  if (inventory) {
    sku = inventory.sku;
    stockQuantity = inventory.quantity ?? null;
    const built = buildCustomerSafeFacts({
      name: inventory.name,
      width: inventory.width,
      depth: inventory.depth,
      height: inventory.height,
      categoryName,
      conditionRating: inventory.conditionRating,
      damageNotes: inventory.damageNotes,
      note: inventory.note,
    });
    facts = built.facts;
    if (facts.name) {
      trustedProductFacts.push({ label: "商品名", value: facts.name });
      inventoryFieldsUsed.push("商品名");
    }
    if (facts.categoryName) {
      trustedProductFacts.push({ label: "カテゴリー", value: facts.categoryName });
      inventoryFieldsUsed.push("カテゴリー");
    }
    if (facts.dimensions) {
      trustedProductFacts.push({ label: "サイズ", value: facts.dimensions });
      inventoryFieldsUsed.push("サイズ");
      dimensionTexts = [facts.dimensions];
    }
    if (facts.conditionDisclosure) {
      trustedProductFacts.push({ label: "状態", value: facts.conditionDisclosure });
      inventoryFieldsUsed.push("状態");
    }
    if (facts.publicNote) {
      trustedProductFacts.push({ label: "商品説明", value: facts.publicNote });
      inventoryFieldsUsed.push("商品説明");
    }
    // §36: 売却済みでも商品自体は特定できる。ただし現在の販売状態は正しく扱う。
    if (statusName) {
      trustedProductFacts.push({ label: "販売状況", value: statusName });
      inventoryFieldsUsed.push("販売状況");
    }
  }

  // 商品固有の質問なのに商品が決まっていない場合は、そのことを明示する。
  if (requiresProduct(intents) && !inventory) {
    unresolved.push({
      field: "対象商品",
      reason:
        resolution.status === "AMBIGUOUS"
          ? "候補が複数あり、どの商品か確定できていません。"
          : resolution.status === "NOT_FOUND"
            ? "問い合わせに含まれる情報に一致する在庫が見つかりませんでした。"
            : "問い合わせから対象商品を特定できる情報が見つかりませんでした。",
    });
  }

  // ── ナレッジ ──────────────────────────────────────────────────
  let knowledgeHits: { id: string; title: string; fileName: string; excerpt: string }[] = [];
  if (settings.knowledgeEnabled) {
    try {
      const docs = await listSearchableKnowledge();
      // 種別を渡すのは、「お店はどこ」のように文書側の語(所在地)が
      // 問い合わせに一切現れない場合に引けるようにするため。
      knowledgeHits = retrieveKnowledge(docs, messageText, { intents }).map((hit) => ({
        id: hit.document.id,
        title: hit.document.title,
        fileName: hit.document.originalFileName,
        excerpt: hit.snippet,
      }));
    } catch (err) {
      // §19: ナレッジが読めなかったことを黙って「該当なし」にしない。
      unresolved.push({ field: "社内文書の参照", reason: err instanceof Error ? err.message : "ナレッジ文書を取得できませんでした。" });
    }
  }

  // ── 送料(既存のらくらく家財DBを参照。新しいマスタは作らない) ──
  //
  // 値下げ交渉でも送料が要る(採算判断に効くため)。ただし配送先が
  // 未確定のうちは金額を作らない —— resolveShipping は「分からない」を
  // ちゃんと「分からない」として返す。
  //
  // 配送先は今回の本文だけでなく会話全体から探す。「埼玉県です」が
  // 別のメッセージで届くため。
  const destinationSearchText = [
    ...request.history.filter((h) => h.direction === "INBOUND").map((h) => h.body),
    messageText,
  ].join("\n");
  // 会話文脈の配送先が最優先。一度教わった配送先を、後のメッセージで
  // 本文に書かれていないという理由で見失わない(§21)。
  const destinationPrefecture =
    currentDestination ??
    incomingContext.shipping.prefecture ??
    (negotiation.isNegotiation ? extractShippingDestination(destinationSearchText).prefecture : null);
  const destinationCityHint =
    destinationFromCurrent.cityHint ??
    incomingContext.shipping.cityHint ??
    (negotiation.isNegotiation ? extractShippingDestination(destinationSearchText).cityHint : null);

  // ── 統合Product Context(§29-§36) ──────────────────────────────
  //
  // 商品情報を「Inventoryだけ」から取らない。在庫にサイズが無くても、
  // 顧客が送ってきたBASE商品ページには書かれていることがある。実際、
  // それで**計算できるはずの想定送料が「不明」になっていた**。
  //
  // 出典ごとに上書きするのではなく、足りない項目を別の出典で補う。
  // チャネルでは分岐しない —— 公式LINEでもメルカリShopsでも同じ文脈を使う(§34)。
  const linkedBaseForContext = linkedBaseProduct(basis, resolution.baseProducts) ?? resolution.baseProducts[0] ?? null;

  // 顧客が実際に送ってきたBASE URL。BASEを引けたかどうかとは独立した事実として持つ。
  const customerSentBaseItemId =
    resolution.references.baseItemIds[0] ?? incomingContext.identifiedProduct.baseItemId ?? null;
  const customerSentBaseUrl =
    resolution.references.urls.find((u) => isBaseUrl(u)) ?? incomingContext.identifiedProduct.baseItemUrl ?? null;
  if (customerSentBaseItemId && !linkedBaseForContext) {
    // §23 内部の照合失敗を顧客への質問に変換しない。社内の確認事項にする。
    unresolved.push({
      field: "BASE商品の取得",
      reason: `お客様が送られた商品URL(${customerSentBaseItemId})からBASE商品を取得できませんでした。BASEの接続状態を確認してください。`,
    });
  }
  const productContext: ResolvedProductContext = await buildResolvedProductContext({
    inventory: inventory
      ? {
          id: inventory.id,
          displayInventoryId: resolution.resolved?.displayInventoryId ?? null,
          sku: inventory.sku,
          name: inventory.name,
          salePriceYen: inventory.salePrice ?? null,
          plannedSalePriceYen: inventory.plannedSalePrice ?? null,
          purchasePriceYen: inventory.purchasePrice ?? null,
          saleStartDate: inventory.saleStartDate ?? null,
          width: inventory.width,
          depth: inventory.depth,
          height: inventory.height,
          quantity: inventory.quantity ?? null,
          categoryName,
          statusName,
        }
      : null,
    baseProduct: linkedBaseForContext
      ? {
          baseItemId: linkedBaseForContext.baseItemId,
          title: linkedBaseForContext.title,
          price: linkedBaseForContext.price,
          itemUrl: linkedBaseForContext.itemUrl,
          description: linkedBaseForContext.description,
          source: linkedBaseForContext.source,
        }
      : null,
    baseItemId: linkedBaseForContext?.baseItemId ?? incomingContext.identifiedProduct.baseItemId ?? null,
    baseItemUrl: linkedBaseForContext?.itemUrl ?? incomingContext.identifiedProduct.baseItemUrl ?? null,
  });
  productContextNotes = [...productContextNotes, ...productContext.completionNotes];
  for (const reason of productContext.reviewReasons) {
    // §39 低信頼の寸法は使うが、必ず人へ知らせる。
    unresolved.push({ field: "商品サイズの確認", reason });
  }

  const mergedDimensions = shippingDimensionsOf(productContext);



  let shipping: ShippingEvidence | null = null;
  if (intents.includes("SHIPPING") || negotiation.isNegotiation) {
    shipping = await resolveShipping({
      destinationPrefecture,
      cityHint: destinationCityHint,
      dimensions: mergedDimensions,
      productResolved: inventory != null || productContext.identity.baseItemId != null,
      // 寸法が読めない商品でも、説明文にランクが書かれていれば送料は出せる。
      declaredRank: productContext.shipping.declaredRank,
    });
    for (const missing of shipping.missingCustomerInfo) {
      // 交渉では市区町村まで求めない —— 指示書§4が求めているのは
      // 「まず都道府県を確認する」ことなので、そこで止める。
      if (negotiation.isNegotiation && missing === "お届け先の市区町村") continue;
      unresolved.push({ field: missing, reason: "送料を確定するために必要な情報が不足しています。" });
    }
  }

  // ── 値下げ交渉の計算(金額はすべてここで確定する。AIには計算させない) ──
  let negotiationResult: Awaited<ReturnType<typeof resolveNegotiation>> | null = null;
  if (negotiation.isNegotiation) {
    const negotiationInventory: NegotiationInventoryFacts | null =
      inventory && resolution.resolved
        ? {
            inventoryId: resolution.resolved.inventoryId,
            displayInventoryId: resolution.resolved.displayInventoryId,
            name: inventory.name,
            unitSalePriceYen: inventory.salePrice ?? inventory.plannedSalePrice ?? null,
            unitSalePriceSource:
              inventory.salePrice != null ? "salePrice" : inventory.plannedSalePrice != null ? "plannedSalePrice" : null,
            purchasePriceYen: inventory.purchasePrice ?? null,
            saleStartDate: inventory.saleStartDate ?? null,
            // §36 在庫にサイズが無いという理由だけで値下げ判断を止めない。
            // BASEから補完した寸法があればそれを使い、送料まで出してから
            // 判断する。統合Product Context が出典も持っている。
            width: mergedDimensions.width,
            depth: mergedDimensions.depth,
            height: mergedDimensions.height,
          }
        : null;
    negotiationResult = await resolveNegotiation({
      context: negotiation,
      inventory: negotiationInventory,
      destinationPrefecture,
      channel: request.channel,
      baseProduct: resolution.baseProducts[0] ?? null,
      // 明記された配送ランクは寸法推定より優先する。これが無いと、
      // 3辺で表せない商品では送料も値引き可否も永久に出せない。
      declaredShippingRank: productContext.shipping.declaredRank?.rank ?? null,
    });
    for (const m of negotiationResult.missing) {
      if (unresolved.some((u) => u.field === m)) continue;
      unresolved.push({ field: m, reason: "値下げ可否を判断するために必要な情報が不足しています。" });
    }
  }

  // ── 外部Webリサーチ(不明な項目だけ) ──────────────────────────
  //
  // ここへ来るまでに在庫DB・ナレッジ・配送DBを見終えている。
  // identifyResearchableFieldsが空を返せば、外部へは1リクエストも出ない。
  const researchFields = settings.webResearchEnabled ? identifyResearchableFields(intents, inventory != null, facts, messageText) : [];
  const availability = getWebResearchAvailability();

  // 型番・ブランドの手がかりは、問い合わせ本文と**商品名の両方**から集める。
  // 「この商品の耐荷重は?」のように、本文にブランドが出てこない問い合わせが
  // 普通にあるため。商品名の「検:」以降は他社の検索用キーワードなので落とす。
  const productNameCore = inventory ? nameCore(inventory.name) : "";
  const brandHints = [...new Set([...resolution.references.brandNames, ...brandsInText(productNameCore)])];
  // 型番だけを同定の手がかりにする。ブランド名を混ぜると、そのブランドの
  // 公式サイトにある**別商品**のページを「対象商品のもの」と誤認する。
  const modelHints = [...new Set([...resolution.references.modelNumbers, ...extractModelHintsFromName(productNameCore)])];
  const officialDomains = officialDomainsForBrands(brandHints);

  // Web検索(課金対象)の呼び出し回数を数える。Providerが呼ぶたびに増える。
  let webSearchCallCount = 0;
  const gatewayUrl = getAgentCoreGatewayUrl();
  const providers =
    researchFields.length > 0
      ? [
          createDirectUrlProvider(resolution.references.urls),
          ...(gatewayUrl
            ? [
                createAgentCoreSearchProvider({
                  gatewayUrl,
                  officialDomains,
                  onSearch: (info) => {
                    webSearchCallCount++;
                    // §32: 何を何回検索したかは残す。顧客本文は残さない。
                    console.info(
                      "[inquiryReply] web search",
                      JSON.stringify({
                        conversationId: request.conversationId,
                        scope: info.scope,
                        query: info.query,
                        resultCount: info.resultCount,
                        callCount: webSearchCallCount,
                      }),
                    );
                  },
                }),
              ]
            : []),
        ]
      : [];

  const research = await researchMissingFacts({
    fields: researchFields,
    inventoryId: resolution.resolved?.inventoryId ?? null,
    modelHints,
    brandHints,
    providers,
    readSearchCallCount: () => webSearchCallCount,
  });
  for (const fact of research.facts) {
    if (fact.status === "NOT_FOUND") {
      unresolved.push({ field: fact.field, reason: "公式情報を含め、確認できませんでした。" });
    } else if (fact.status === "UNCERTAIN") {
      unresolved.push({ field: fact.field, reason: "情報は見つかりましたが、この商品のものと確定できませんでした。" });
    }
  }
  if (researchFields.length > 0 && !research.attempted && !availability.available) {
    // 検索APIが未設定であることは事実として残す。UIにも出す。
    unresolved.push({ field: "外部情報の調査", reason: availability.reason });
  }

  const evidence: ReplyEvidence = {
    product: resolution.resolved
      ? {
          inventoryId: resolution.resolved.inventoryId,
          displayInventoryId: resolution.resolved.displayInventoryId,
          name: resolution.resolved.name,
          confidence: resolution.resolved.confidence,
        }
      : null,
    productStatus: resolution.status,
    // BASE商品の状態は在庫と分けて持つ。販売中の在庫が0件でも、
    // 顧客が送ってきたURLからBASE商品自体は確実に特定できている。
    baseProductStatus: resolution.baseProducts.length > 0
      ? "RESOLVED"
      : customerSentBaseItemId
        ? "NOT_FOUND"
        : "NOT_REFERENCED",
    inventorySyncSuspected: resolution.inventorySyncSuspected,
    zaicoLastSyncedAt: resolution.zaicoLastSyncedAt,
    onSaleCategoryResolved: resolution.onSaleCategoryResolved,
    productCandidates: resolution.candidates,
    inventoryFieldsUsed,
    knowledgeDocuments: knowledgeHits.map((k) => ({ id: k.id, title: k.title, fileName: k.fileName })),
    shipping,
    externalResearchAttempted: research.attempted,
    externalFacts: research.facts,
    webSearchCallCount: research.searchCallCount,
    unresolvedFacts: unresolved,
    baseProducts: resolution.baseProducts.map((b) => ({
      baseItemId: b.baseItemId,
      title: b.title,
      price: b.price,
      itemUrl: b.itemUrl,
    })),
    identifiedProduct,
    negotiation: negotiationResult?.evidence ?? null,
    staffCard: negotiationResult?.staffCard ?? null,
    generationRoute: negotiation.isNegotiation ? "negotiation" : "standard",
  };

  // ── 分かったことを会話文脈へ足す(§21) ─────────────────────────
  //
  // **消さない。** 今回分からなかった項目は undefined を渡して、既存の値を
  // そのまま残す。「埼玉です」の1通で商品や希望価格が消えるのが、今回
  // 直している不具合そのものなので、ここが最も重要な不変条件になる。
  const identifiedBase = linkedBaseForContext;
  workingContext = mergeConversationContext(workingContext, {
    channel: request.channel,
    intents,
    identifiedProduct: {
      // §23/§24 **顧客が送ってきたBASE URLそのものは、BASEを引けなくても確定情報**。
      //
      // 実機で見つけた抜け: BASE APIのトークンが無効で商品を取得できず、
      // baseProducts が空になり、会話文脈にURLが1つも残らなかった。その結果
      // 2通目で「商品のURLをお送りいただけますでしょうか」——顧客は1通目で
      // 送っている。BASEを引けたかどうかと、顧客がURLを送ったかどうかは
      // 別の事実なので、別々に記録する。
      baseItemId: identifiedBase?.baseItemId ?? customerSentBaseItemId ?? undefined,
      baseItemUrl: productContext.identity.baseItemUrl ?? customerSentBaseUrl ?? undefined,
      baseProductName: identifiedBase?.title ?? undefined,
      baseListedPriceYen: identifiedBase?.price ?? undefined,
      // §24 BASE商品と在庫で段階を分ける。BASEが特定できていれば、
      // 在庫が絞れなくてもそのことは失わない。URLは分かるが商品を取得
      // できなかった場合は NOT_FOUND —— 「URLすら無い」と区別する。
      baseStatus: identifiedBase ? "RESOLVED" : customerSentBaseItemId ? "NOT_FOUND" : undefined,
      inventoryId: resolution.resolved?.inventoryId ?? undefined,
      displayInventoryId: resolution.resolved?.displayInventoryId ?? undefined,
      inventoryName: resolution.resolved?.name ?? undefined,
      inventoryCandidateIds:
        resolution.candidates.length > 0 ? resolution.candidates.map((c) => c.inventoryId) : undefined,
      inventoryStatus: resolution.status,
      basis,
      salePriceYen: productContext.commerce.currentSalePriceYen?.value ?? undefined,
    },
    negotiation: negotiation.isNegotiation
      ? {
          active: true,
          requestedTotalPriceYen: negotiation.requestedTotalPriceYen ?? undefined,
          requestedUnitPriceYen: negotiation.requestedUnitPriceYen ?? undefined,
          quantity: negotiation.quantity ?? undefined,
          currentUnitPriceYen: productContext.commerce.currentSalePriceYen?.value ?? undefined,
        }
      : undefined,
    shipping: {
      prefecture: destinationPrefecture ?? undefined,
      cityHint: destinationCityHint ?? undefined,
      estimatedShippingCostYen: shipping?.feeYen ?? undefined,
      rank: shipping?.rank ?? productContext.shipping.rank ?? undefined,
    },
    order: {
      requestedDeliveryDate: answeredDeliveryDate ?? undefined,
    },
    appliedReplyRuleIds: undefined,
    knowledgeDocumentIds: knowledgeHits.length > 0 ? knowledgeHits.map((k) => k.id) : undefined,
    reviewReasons: productContext.reviewReasons.length > 0 ? productContext.reviewReasons : undefined,
  });

  // ── 商品が確実に特定できていなければ、答えずにURLを尋ねる ──────
  //
  // ここは**生成より前**に置く。AIに投げてから「やっぱり分からない」と
  // 捨てるのでは、その間に商品固有の事実がプロンプトへ混ざる余地が残る。
  // 特定できていない時点で、商品の話は一切しない。
  if (urlRequest.requestUrl) {
    return finish({
      status: "NEEDS_PRODUCT_CONFIRMATION",
      draftText: PRODUCT_URL_REQUEST_TEMPLATE,
      evidence,
      intents,
      unresolvedFacts: [
        ...unresolved,
        { field: "対象商品", reason: urlRequest.reason },
      ],
      modelProvider: null,
      modelName: null,
      failureReason: null,
    });
  }

  // ── 生成できない条件を先に判定する ────────────────────────────
  if (!settings.autoDraftEnabled) {
    return finish(failed("AI返信案の生成が設定で無効になっています。", evidence, intents, unresolved));
  }
  const nothingToAnswerWith =
    trustedProductFacts.length === 0 && knowledgeHits.length === 0 && shipping === null && research.facts.length === 0;
  if (nothingToAnswerWith && requiresProduct(intents) && !hasProductIndependentIntent(intents)) {
    return finish({
      status: "NEEDS_PRODUCT_CONFIRMATION",
      draftText: null,
      evidence,
      intents,
      unresolvedFacts: unresolved,
      modelProvider: null,
      modelName: null,
      failureReason: "回答の根拠になる情報が1件も得られなかったため、返信案を生成していません。対象商品を指定してから再生成してください。",
    });
  }

  // ── 返信ルール(§16/§19) ───────────────────────────────────────
  //
  // 「どう判断するか」はナレッジ文書ではなく ReplyRule が持つ。ここで
  // 全件を渡さず、この問い合わせに関係するものだけへ絞る(§22) ——
  // 関係の無い指示が混ざるほど、本来効くべきルールが薄まる。
  //
  // 読み込みに失敗しても返信案の生成そのものは止めない。ルールが無ければ
  // 既存の挙動(ナレッジ＋コードの判断)へ素直に落ちるだけで、止めるより
  // 返せるほうが運用上まし。
  let appliedRules: ReplyRuleRecord[] = [];
  try {
    appliedRules = selectReplyRules({
      rules: await listActiveReplyRules(),
      intents,
      channel: request.channel as MessageChannel,
      productCategoryId: inventory?.categoryId ?? null,
      // 配送先が分かっているなら「配送先が不明なとき用」のルールは渡さない。
      destinationKnown: Boolean(shipping?.destinationPrefecture ?? destinationPrefecture),
    });
  } catch (err) {
    console.warn("[inquiry] 返信ルールを読めませんでした。ルール無しで続行します。", err instanceof Error ? err.message : String(err));
  }
  // 何が効いたかを根拠へ残す(§24「使用ルール」)。URLを尋ねて早期returnした
  // 経路ではルールを1件も読んでいないので、ここには来ない = 空のまま。
  evidence.appliedReplyRules = appliedRules.map((r) => ({
    id: r.id,
    title: r.title,
    category: r.category,
    version: r.version,
  }));

  // ── 生成 ──────────────────────────────────────────────────────
  const systemPrompt = buildInquirySystemPrompt();
  const userPrompt = buildInquiryUserPrompt({
    intents,
    replyRules: appliedRules.map((r) => ({
      title: r.title,
      category: r.category,
      conditions: r.conditions,
      instruction: r.instruction,
    })),
    // 交渉で確定した金額だけを事実として足す。配送先が未確定なら
    // customerSafeFacts は空なので、AIが提示できる金額が存在しない。
    trustedProductFacts: [...trustedProductFacts, ...(negotiationResult?.customerSafeFacts ?? [])],
    knowledgeExcerpts: knowledgeHits.map((k) => ({ title: k.title, excerpt: k.excerpt })),
    shipping,
    externalFacts: research.facts,
    unresolved,
    context: request.additionalContext ?? null,
    // §4 顧客が商品を指し示せない経路(メール由来)では、商品特定の失敗を
    // 顧客への質問に変換させない。urlRequest の判定と同じ条件を使う。
    // §4 商品特定の失敗を顧客への質問に変換しない。
    // BASE商品が特定できている場合も、URLが本文にある場合も尋ねない。
    customerCanIdentifyProduct:
      request.channel !== "MERCARI_SHOPS" &&
      !resolution.references.urls.some((u) => isBaseUrl(u)) &&
      resolution.baseProducts.length === 0 &&
      incomingContext.identifiedProduct.baseItemId == null,
    // §23 会話ですでに分かっていること。**今回の更新を反映した後の文脈**を
    // 使う —— 「埼玉です」への返信を作る時点で、配送先はもう分かっている。
    knownFacts: knownFacts(workingContext),
    customerMessage: messageText,
    history: request.history.slice(-10),
    negotiation: negotiationResult
      ? {
          awaitingDestination: negotiationResult.evidence.awaitingDestination,
          quantity: negotiationResult.evidence.quantity,
          requestedTotalPriceYen: negotiationResult.evidence.requestedTotalPriceYen,
          customerQuestions: negotiationResult.customerQuestions,
          // 判断結果も渡す。金額だけ渡して判断を任せると、断る必要が無い
          // 場面で断り、根拠の無い理由まで添えてしまう(実測)。
          requestedComparison: (() => {
            const diff = negotiationResult.staffCard?.differenceFromRequestedYen ?? null;
            if (diff == null) return "UNKNOWN" as const;
            return diff >= 0 ? ("REQUEST_ABOVE_OFFER" as const) : ("REQUEST_BELOW_OFFER" as const);
          })(),
        }
      : null,
  });

  // ── 顧客向けに書いてよい金額 ──────────────────────────────────
  //
  // 送料と、値下げ交渉で提示してよい確定金額(7%引き後の単価・数量合計)。
  // **どちらもコード側で計算した値だけ**を通す —— AIに金額を計算させない
  // という方針(lib/inquiry/discount.ts)は変えない。
  //
  // 交渉での提示可否を決めるのは negotiationService の customerSafeFacts で、
  // そこは「確定値」としてのみ金額を積む。以前は検査が送料1件しか許可して
  // いなかったため、運用どおりに書いた返信が「根拠のない金額」として弾かれ、
  // 3回作り直して返信案が1つも作られない状態になっていた(実測)。
  const allowedShippingFee = shipping?.feeYen ?? null;
  const allowedMoneyYen = [
    ...(negotiationResult?.customerSafeFacts ?? []).map((f) => Number(f.value.replace(/[^0-9]/g, ""))),
    // お客様ご自身が書かれた金額。復唱は事実の確認なので許す ——
    // ここを弾くと「ご希望の6万円について」と書けず、話が通じなくなる。
    negotiationResult?.evidence.requestedTotalPriceYen ?? Number.NaN,
    negotiationResult?.evidence.requestedUnitPriceYen ?? Number.NaN,
  ].filter((n) => Number.isFinite(n) && n > 0);
  const allowedDimensionText = [...dimensionTexts, ...research.facts.map((f) => f.value ?? "")];

  let lastViolations: string[] = [];
  let modelProvider: string | null = null;
  let modelName: string | null = null;

  for (let attempt = 1; attempt <= REPLY_MAX_GENERATION_ATTEMPTS; attempt++) {
    let output: string;
    try {
      const result = await generateText({
        task: "CUSTOMER_REPLY_DRAFT",
        systemPrompt: attempt === 1 ? systemPrompt : `${systemPrompt}\n\n【前回の出力で検出された問題(必ず直すこと)】\n${lastViolations.join("\n")}`,
        userPrompt,
        tier: "STANDARD",
        promptVersion: INQUIRY_PROMPT_VERSION,
      });
      output = result.output.trim();
      modelProvider = result.providerId;
      modelName = result.modelId;
    } catch (err) {
      return finish(failed(err instanceof Error ? err.message : "AIの呼び出しに失敗しました。", evidence, intents, unresolved));
    }

    const validation = validateReplyDraft({
      output,
      facts,
      stockQuantity,
      sku,
      allowedShippingFeeYen: allowedShippingFee,
      allowedMoneyYen,
      unresolved,
      // 既に分かっている配送先を、もう一度尋ねる返信を出さない。
      knownDestinationPrefecture: shipping?.destinationPrefecture ?? destinationPrefecture ?? null,
      // ご希望に沿えるのに断る返信を出さない。
      requestIsWithinOffer: (negotiationResult?.staffCard?.differenceFromRequestedYen ?? -1) >= 0,
      // 受け取っていない写真に言及させない。
      customerSentAttachment: request.customerSentAttachment,
      externalTexts: research.documentTexts,
      allowedDimensionText,
      // 根拠として認めた文章。住所のように「出典があれば出してよいが
      // 出典が無ければ個人情報」という記述の判定に使う。
      groundedTexts: [...knowledgeHits.map((k) => k.excerpt), ...trustedProductFacts.map((f) => f.value)],
    });
    if (validation.ok) {
      return finish({
        status: deriveStatus(resolution.status, unresolved, research.facts),
        draftText: output,
        evidence,
        intents,
        unresolvedFacts: unresolved,
        modelProvider,
        modelName,
        failureReason: null,
      });
    }
    lastViolations = validation.violations.map((v) => `- ${v.detail}`);
    // §32: 検査に落ちたことは構造化ログに残す。生成文そのものは残さない
    // (顧客本文・生成文には個人情報が混ざりうる)。
    console.warn("[inquiryReply] 生成結果が検査に不合格", {
      attempt,
      codes: validation.violations.map((v) => v.code),
      conversationId: request.conversationId,
      // 生成文は残さない(§32)。ただしローカルの調査時だけは中身を見たい ——
      // 何を書いて弾かれたのか分からないと、プロンプトを直せない。
      // 明示的にopt-inした場合に限る(本番では立たない)。
      ...(process.env.INQUIRY_DEBUG_OUTPUT === "true" ? { output } : {}),
    });
  }

  return finish({
    status: "FAILED",
    draftText: null,
    evidence,
    intents,
    unresolvedFacts: unresolved,
    modelProvider,
    modelName,
    failureReason: `生成結果が安全性・事実整合性の検査に${REPLY_MAX_GENERATION_ATTEMPTS}回続けて不合格でした: ${lastViolations.join(" ")}`,
  });
}

/**
 * §18 状態の決定。
 *
 * 「返信案はできたが、確認が要る点がある」を READY と同じ扱いにしない ——
 * 担当者が根拠パネルを開かずに送信してしまう経路を作らないため。
 */
function deriveStatus(productStatus: ProductResolutionStatus, unresolved: UnresolvedFact[], facts: ExternalResearchFact[]): ReplyDraftStatus {
  if (productStatus === "AMBIGUOUS") return "NEEDS_PRODUCT_CONFIRMATION";
  if (unresolved.some((u) => u.field.includes("お届け先") || u.field.includes("市区町村"))) return "NEEDS_CUSTOMER_INFO";
  if (facts.some((f) => f.status === "NOT_FOUND" || f.status === "UNCERTAIN")) return "RESEARCH_INCOMPLETE";
  if (unresolved.length > 0) return "RESEARCH_INCOMPLETE";
  return "READY";
}

function failed(reason: string, evidence: ReplyEvidence, intents: InquiryIntent[], unresolved: UnresolvedFact[]): BaseReplyResult {
  return { status: "FAILED", draftText: null, evidence, intents, unresolvedFacts: unresolved, modelProvider: null, modelName: null, failureReason: reason };
}

/**
 * §10 送料。金額は必ず既存のShippingRateマスタから引く。
 *
 * 【書き込みをしない】lib/shipping/service.tsのcalculateShippingEstimateは
 * ChannelListingへ見積り結果を保存する。問い合わせを開いただけで出品情報が
 * 書き換わるのは副作用として重すぎるので、ここではランク計算とマスタ検索
 * (どちらも読み取りのみ)を直接使う。
 */
/**
 * 【本文からもう一度読み直さない】以前はここで配送先を本文から抽出し、
 * 寸法は在庫から直接読んでいた。会話文脈を持てるようになった今、
 * 「どこ宛か」と「どの寸法か」は呼び出し側が既に確定させている
 * (§32 の順序: Inventory → BASE保存データ → BASEライブ)。同じことを
 * 2箇所で判断すると、片方だけ直したときに食い違う。
 */
async function resolveShipping(params: {
  destinationPrefecture: string | null;
  cityHint: string | null;
  /** 統合Product Context が決めた寸法(出典は問わない)。 */
  dimensions: { width: string | null; depth: string | null; height: string | null };
  /** 商品が特定できているか(不足情報の案内文の出し分けに使う)。 */
  productResolved: boolean;
  /**
   * BASEの商品説明に明記されていた配送ランク(2026-09-03 実測)。
   *
   * 寸法から推定するより**こちらが正確**。BELLOが商品ごとに決めて
   * 説明文へ書いた値そのもので、推定ではない。
   * 円形スツール(座面直径34cm / 脚幅44cm / 高さ75cm)のように
   * 幅・奥行・高さの3辺で書かれていない商品では寸法抽出が成立せず、
   * 「想定送料：不明」になっていたが、説明文にはランクが明記されていた。
   */
  declaredRank?: { rank: string; matchedText: string } | null;
}): Promise<ShippingEvidence> {
  const dims = calculateShippingRankFromDimensions(
    params.dimensions.width,
    params.dimensions.depth,
    params.dimensions.height,
  );

  // ── 優先順位(2026-09-03 利用者指示) ──────────────────────────
  //
  //   1. BASE等にBELLOが明記した配送ランク (BASE_DECLARED)
  //   2. その他の確定済み配送ランク         (STRUCTURED)
  //   3. 寸法からの推定                     (DIMENSION_INFERRED)
  //   4. 不明
  //
  // **明記されたランクを寸法推定で上書きしない。** 明記された値は、人が
  // 形状・梱包・実際の配送方法まで考慮して決めたもので、3辺合計から
  // 機械的に出した値より信頼度が高い。円形スツール(座面直径34cm /
  // 脚幅44cm / 高さ75cm)のように3辺で表せない商品では推定自体が成立しない。
  // 明記されたランクは文字列なので、料金マスタが知っている値だけを通す。
  // 未知の文字列をそのまま渡すと、料金が引けずに「未登録」と報告され、
  // 原因が説明文の表記ゆれなのかマスタ不足なのか分からなくなる。
  const declared = params.declaredRank && (SHIPPING_RANKS as string[]).includes(params.declaredRank.rank)
    ? (params.declaredRank.rank as ShippingRank)
    : null;
  const rank: ShippingRank | null = declared ?? dims?.rank ?? null;
  const rankSource: ShippingRankSource | null = declared ? "BASE_DECLARED" : dims ? "DIMENSION_INFERRED" : null;

  const missing = missingShippingInfo({
    productResolved: params.productResolved,
    destinationPrefecture: params.destinationPrefecture,
    cityHint: params.cityHint,
    hasDimensions: rank != null,
  });

  if (!params.destinationPrefecture || !rank) {
    return {
      destinationPrefecture: params.destinationPrefecture,
      rank,
      rankSource,
      feeYen: null,
      note: !params.destinationPrefecture
        ? "お届け先が特定できないため、金額を出していません。"
        : "在庫にもBASE商品ページにも、送料判定に使える寸法・配送ランクの記載がありません。",
      missingCustomerInfo: missing,
    };
  }

  const rate = await lookupShippingRate(params.destinationPrefecture, rank);
  if (!rate) {
    return {
      destinationPrefecture: params.destinationPrefecture,
      rank,
      rankSource,
      feeYen: null,
      note: `埼玉県 → ${params.destinationPrefecture}・${rank}ランクの料金が料金マスタに未登録です。`,
      missingCustomerInfo: missing,
    };
  }
  if (rate.price == null) {
    return {
      destinationPrefecture: params.destinationPrefecture,
      rank,
      rankSource,
      feeYen: null,
      note: `埼玉県 → ${params.destinationPrefecture}・${rank}ランクは公式にサービス対象外と確認されています。`,
      missingCustomerInfo: missing,
    };
  }
  return {
    destinationPrefecture: params.destinationPrefecture,
    rank,
    rankSource,
    feeYen: rate.price + (rate.surcharge ?? 0),
    // 市区町村が分からない段階の金額は参考値。確定額として案内させない。
    // ランクを説明文から読んだ場合はそれも書く —— 担当者が金額の根拠を
    // 追えるようにするため(寸法から計算したのか、記載を読んだのか)。
    note: [
      params.cityHint ? null : "都道府県のみで引いた参考額です。市区町村により変わる場合があります。",
      declared ? `配送ランクはBASEの商品説明の「${params.declaredRank?.matchedText}」から読み取りました。` : null,
      // 明記と推定が食い違う場合は隠さない。梱包サイズが3辺合計と
      // ずれていることの手がかりになる。
      declared && dims && dims.rank !== declared ? `寸法からの計算では${dims.rank}ランクです。` : null,
    ]
      .filter(Boolean)
      .join(" ") || null,
    missingCustomerInfo: missing,
  };
}

/**
 * §9.1 外部調査を発動する条件。
 *
 * 在庫DBで答えられるなら調べない。ここが「Web検索費用対策」(§21)の
 * 実体で、条件を満たさない限り外部へは1リクエストも出ない。
 */
/**
 * 問い合わせ本文に直接書かれている仕様項目。
 *
 * 種別(PRODUCT_SPEC)から固定の項目を決め打ちすると、家具向けの
 * 「耐荷重」しか調べられない。実際の在庫には照明も多く、
 * 「消費電力は何Wですか」「口金は何ですか」が来る。聞かれた語を
 * そのまま調べる項目にするほうが、当たるし説明もしやすい。
 */
const SPEC_NOUNS = [
  "耐荷重",
  "消費電力",
  "重量",
  "重さ",
  "素材",
  "材質",
  "生地",
  "張地",
  "口金",
  "色温度",
  "光束",
  "明るさ",
  "電圧",
  "寸法",
  "サイズ",
  "座面高",
  "全長",
  "定格",
  "生産国",
  "原産国",
  "耐熱",
  "防水",
];

export function specNounsInQuestion(text: string): string[] {
  return SPEC_NOUNS.filter((noun) => text.includes(noun));
}

export function identifyResearchableFields(
  intents: InquiryIntent[],
  hasProduct: boolean,
  facts: CustomerSafeFacts,
  messageText = "",
): string[] {
  if (!hasProduct) return [];
  const fields: string[] = [];

  // 質問文に仕様項目が書かれていれば、それを最優先で調べる。
  for (const noun of specNounsInQuestion(messageText)) {
    // 在庫DBに寸法があるなら、寸法は調べない(§9.1 発動条件)。
    if ((noun === "寸法" || noun === "サイズ") && facts.dimensions) continue;
    fields.push(noun);
  }

  if (intents.includes("SIZE") && !facts.dimensions) fields.push("寸法");
  if (intents.includes("MATERIAL")) fields.push("素材");
  if (intents.includes("PRODUCT_SPEC") && fields.length === 0) fields.push("仕様");
  if (intents.includes("COMPATIBILITY")) fields.push("適合");
  // 同じ項目を2回調べない(そのぶん課金される)。
  return [...new Set(fields)];
}

/**
 * 商品名から型番らしき語を拾う。
 *
 * references.tsのextractModelNumbersは問い合わせ本文向けで、日本語混じりの
 * 商品名だとカタカナ語まで拾ってしまう。ここでは英数字が混ざった語だけを
 * 型番候補として取り、検索語と型番整合確認の両方に使う。
 */
export function extractModelHintsFromName(name: string): string[] {
  const hints: string[] = [];
  for (const token of name.split(/[\s　、,。「」『』()（）\[\]【】:：;；]+/)) {
    const t = token.replace(/^[-/.]+|[-/.]+$/g, "");
    if (t.length < 3 || t.length > 20) continue;
    if (!/^[0-9A-Za-z][0-9A-Za-z\-/.]*$/.test(t)) continue;
    if (!/[A-Za-z]/.test(t) || !/[0-9]/.test(t)) continue;
    hints.push(t.toUpperCase());
  }
  return [...new Set(hints)];
}

/** §11 normalizeMessage。制御文字とゼロ幅文字を落とし、改行を揃える。 */
export function normalizeMessage(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[​-‏‪-‮⁠-⁤﻿]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * カテゴリー名・販売状況の表示名を引く。
 *
 * IDのままAIへ渡すと、顧客への返信に内部IDが出る経路になる。マスタが
 * 引けなかった場合はnull —— 「不明なカテゴリー」等の作り話をしない。
 */
async function resolveMasterLabels(categoryId: string | null, statusId: string | null): Promise<[string | null, string | null]> {
  if (!categoryId && !statusId) return [null, null];
  try {
    const [categories, statuses] = await Promise.all([categoryId ? listCategories() : Promise.resolve([]), statusId ? listStatuses() : Promise.resolve([])]);
    return [categories.find((c) => c.id === categoryId)?.name ?? null, statuses.find((s) => s.id === statusId)?.label ?? null];
  } catch {
    return [null, null];
  }
}

export { CUSTOMER_SAFE_INVENTORY_FIELDS };
