"use client";

import { useEffect, useState } from "react";
import { generateInquiryReplyAction, getInquiryReplyDraftAction, markInquiryReplyDraftAction } from "@/app/actions/inquiryReply";
import { INQUIRY_INTENT_LABEL, REPLY_DRAFT_STATUS_LABEL, type ProductMatch, type ReplyDraftRecord } from "@/lib/inquiry/types";
import { IdentifiedProductCardView } from "./IdentifiedProductCardView";

/**
 * §14/§33 問い合わせ詳細のAI返信パネル。
 *
 * 【生成と送信を分ける】このパネルは返信案を作って表示するだけで、
 * 送信ボタンを持たない。「返信欄へ反映」を押すと既存の返信フォームへ
 * 文章が入り、そこから先(下書き保存→送信確認→送信)は元からある経路を
 * そのまま通る。AIが顧客へ直接送る経路はどこにも無い(§41)。
 *
 * 【根拠を必ず出す】返信案の下に、どの商品・どの社内文書・どの外部情報を
 * 使い、何が分からなかったかを表示する(§33)。これは担当者向けであって、
 * 顧客へは送られない。
 *
 * 【開いただけでAIを呼ばない】§15/§31。マウント時に読むのは保存済みの
 * 返信案だけで、生成はボタンを押したときだけ起きる。
 */
export function AiReplyPanel({
  conversationId,
  onApplyToReply,
}: {
  conversationId: string;
  /** 返信案を返信入力欄へ反映する。送信はしない。 */
  onApplyToReply: (text: string) => void;
}) {
  const [draft, setDraft] = useState<ReplyDraftRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDraft(null);
    setShowEvidence(false);
    void (async () => {
      const result = await getInquiryReplyDraftAction(conversationId);
      if (cancelled) return;
      if (result.ok) setDraft(result.data);
      else setError(result.error);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function generate(overrideInventoryId?: string | null) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await generateInquiryReplyAction(conversationId, { overrideInventoryId: overrideInventoryId ?? null });
      if (result.ok) {
        setDraft(result.data);
        setShowEvidence(true);
      } else {
        setError(result.error);
      }
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!draft?.draftText) return;
    onApplyToReply(draft.draftText);
    // 使ったことを記録する。失敗しても反映自体は成立しているので止めない。
    const result = await markInquiryReplyDraftAction(draft.id, "USED");
    if (result.ok) setDraft({ ...draft, status: "USED" });
  }

  async function copy() {
    if (!draft?.draftText) return;
    try {
      await navigator.clipboard.writeText(draft.draftText);
      setCopied(true);
    } catch {
      setError("クリップボードへコピーできませんでした。文章を選択してコピーしてください。");
    }
  }

  const evidence = draft?.evidence ?? null;

  return (
    <div className="border border-gray-200 bg-gray-50 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-bold text-gray-800">AI返信案</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void generate()}
            disabled={busy || loading}
            className="border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          >
            {busy ? "作成中…" : draft ? "再生成" : "AI返信案を作成"}
          </button>
          {draft?.draftText && (
            <>
              <button type="button" onClick={() => void copy()} disabled={busy} className="border border-gray-300 bg-white px-2 py-1 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40">
                {copied ? "コピーしました" : "コピー"}
              </button>
              <button type="button" onClick={() => void apply()} disabled={busy} className="border border-gray-900 bg-gray-900 px-2 py-1 text-[11px] text-white hover:bg-gray-800 disabled:opacity-40">
                返信欄へ反映
              </button>
            </>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
      {loading && <p className="mt-2 text-[12px] text-gray-500">読み込み中…</p>}

      {!loading && !draft && !error && (
        <p className="mt-2 text-[11px] text-gray-500">
          「AI返信案を作成」を押すと、在庫情報・社内文書・配送料金データベースを参照して返信案を作ります。作成するまでAIは呼び出されません。
        </p>
      )}

      {draft && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className={`px-1.5 py-0.5 ${statusClass(draft.status)}`}>{REPLY_DRAFT_STATUS_LABEL[draft.status]}</span>
            {draft.intents.map((intent) => (
              <span key={intent} className="bg-gray-200 px-1.5 py-0.5 text-gray-700">
                {INQUIRY_INTENT_LABEL[intent] ?? intent}
              </span>
            ))}
          </div>

          {draft.failureReason && <p className="text-[12px] text-amber-700">{draft.failureReason}</p>}

          {draft.draftText && (
            <textarea
              readOnly
              value={draft.draftText}
              rows={Math.min(14, Math.max(4, draft.draftText.split("\n").length + 2))}
              className="w-full resize-y border border-gray-300 bg-white p-2 text-[12px] text-gray-800"
            />
          )}

          {/* §4.3 候補が複数あるときは人が選び直せるようにする。 */}
          {evidence && evidence.productStatus === "AMBIGUOUS" && evidence.productCandidates.length > 0 && (
            <div className="border border-amber-300 bg-amber-50 p-2">
              <p className="text-[11px] font-bold text-amber-800">対象商品候補（確定していません）</p>
              <ul className="mt-1 space-y-1">
                {evidence.productCandidates.map((candidate) => (
                  <li key={candidate.inventoryId} className="flex flex-wrap items-center gap-2">
                    <span className="text-[11px] text-gray-800">
                      {candidate.name}（在庫ID {candidate.displayInventoryId} / {Math.round(candidate.confidence * 100)}%）
                    </span>
                    <button
                      type="button"
                      onClick={() => void generate(candidate.inventoryId)}
                      disabled={busy}
                      className="border border-gray-400 bg-white px-2 py-0.5 text-[11px] text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                    >
                      この商品を使用
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* 対象商品カード。値下げ交渉かどうかに関わらず、商品が一意に
              特定できたときは常に出す —— 担当者が「どの商品の話か」を
              返信を書く前に確認できるようにするため。参照情報を開かないと
              見えない位置には置かない。 */}
          {evidence?.identifiedProduct && (
            <IdentifiedProductCardView card={evidence.identifiedProduct} />
          )}

          {/* 値下げ交渉のときだけ出す、管理者向けの判断材料。
              参照情報を開かなくても見える位置に置く —— 値下げの可否は
              返信を書く前に決める必要があるため。 */}
          {evidence?.staffCard && <NegotiationStaffCardView card={evidence.staffCard} negotiation={evidence.negotiation ?? null} />}

          {evidence && (
            <div>
              <button type="button" onClick={() => setShowEvidence((v) => !v)} className="text-[11px] text-blue-700 underline">
                {showEvidence ? "参照情報を隠す" : "参照情報を表示"}
              </button>
              {showEvidence && <EvidenceView evidence={evidence} draft={draft} onUseCandidate={(id) => void generate(id)} busy={busy} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 管理者向けの値下げ判断カード(2026-09-02 指示書§6)。
 *
 * **顧客向けの返信本文には一切出ない情報**(仕入価格・販売開始日時・
 * 経過日数)を含む。サーバー側で型を分けてあり(NegotiationStaffCard は
 * 顧客向けプロンプト組み立て関数へ渡す口が無い)、この画面だけが受け取る。
 */
function NegotiationStaffCardView({
  card,
  negotiation,
}: {
  card: NonNullable<NonNullable<ReplyDraftRecord["evidence"]>["staffCard"]>;
  negotiation: NonNullable<ReplyDraftRecord["evidence"]>["negotiation"];
}) {
  const yen = (v: number | null | undefined) => (v == null ? "—" : `${v.toLocaleString("ja-JP")}円`);
  const pct = (v: number | null | undefined) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  return (
    <div className="border border-amber-300 bg-amber-50 p-3 text-[11px] text-gray-800">
      <p className="mb-2 text-[12px] font-bold text-amber-900">値下げ判断（担当者向け・お客様には送信されません）</p>

      {negotiation?.awaitingDestination && (
        <p className="mb-2 border border-amber-400 bg-white p-1.5 text-amber-900">
          お届け先の都道府県が未確認のため、送料が確定していません。値下げの可否・金額はまだ確定できません。
          まずお届け先をお伺いする段階です。
        </p>
      )}

      <dl className="grid grid-cols-[9rem_1fr] gap-y-0.5">
        <dt>商品名</dt>
        <dd>{card.productName ?? "—"}</dd>
        {card.baseItemId && (
          <>
            <dt>BASE商品ID</dt>
            <dd>
              {card.baseItemId}
              {card.baseItemUrl ? (
                <a href={card.baseItemUrl} target="_blank" rel="noreferrer" className="ml-1 text-blue-700 underline">
                  開く
                </a>
              ) : null}
            </dd>
            <dt>BASE掲載価格</dt>
            <dd>{yen(card.baseListedPriceYen)}</dd>
          </>
        )}
        <dt>BELLO在庫ID</dt>
        <dd>{card.displayInventoryId ?? "未確定（BASE商品は特定済み）"}</dd>
        <dt>数量</dt>
        <dd>{card.quantity ?? "（記載なし）"}</dd>
        <dt>現在販売価格（単価）</dt>
        <dd>{yen(card.unitSalePriceYen)}</dd>
        <dt>現在販売価格（合計）</dt>
        <dd>{yen(card.totalSalePriceYen)}</dd>
        <dt>お客様希望価格（合計）</dt>
        <dd>{yen(card.requestedTotalPriceYen)}</dd>
        <dt>お客様希望価格（単価）</dt>
        <dd>{yen(card.requestedUnitPriceYen)}</dd>
        <dt>希望値引率</dt>
        <dd>{pct(card.requestedDiscountRate)}</dd>

        <dt className="text-amber-900">仕入価格（単価）</dt>
        <dd className="text-amber-900">{yen(card.purchaseUnitPriceYen)}</dd>
        <dt className="text-amber-900">仕入価格（合計）</dt>
        <dd className="text-amber-900">{yen(card.purchaseTotalPriceYen)}</dd>
        <dt className="text-amber-900">販売開始日時</dt>
        <dd className="text-amber-900">{card.saleStartDate ?? "—"}</dd>
        <dt className="text-amber-900">販売開始からの経過</dt>
        <dd className="text-amber-900">{card.daysOnSale != null ? `${card.daysOnSale}日` : "—"}</dd>

        <dt>送料判定に使った寸法</dt>
        <dd>{card.shippingDimensionText ?? "—"}</dd>
        <dt>3辺合計</dt>
        <dd>{card.shippingSumCm != null ? `${card.shippingSumCm} cm` : "—"}</dd>
        <dt>配送ランク</dt>
        <dd>{card.shippingRank ?? "—"}</dd>
        <dt>配送先</dt>
        <dd>{card.destinationPrefecture ?? "未確認"}</dd>
        <dt>送料</dt>
        <dd>{card.shippingFeeYen != null ? yen(card.shippingFeeYen) : "未算出"}</dd>
        <dt>送料込み合計</dt>
        <dd>{yen(card.totalWithShippingYen)}</dd>

        <dt>7%値引き後（単価）</dt>
        <dd>{yen(card.baseDiscountedUnitPriceYen)}</dd>
        <dt>7%値引き後（合計）</dt>
        <dd>{yen(card.baseDiscountedTotalPriceYen)}</dd>
        <dt>希望額との差</dt>
        <dd>
          {card.differenceFromRequestedYen == null
            ? "—"
            : card.differenceFromRequestedYen >= 0
              ? `希望額が ${card.differenceFromRequestedYen.toLocaleString("ja-JP")}円 高い`
              : `希望額が ${Math.abs(card.differenceFromRequestedYen).toLocaleString("ja-JP")}円 安い`}
        </dd>

        <dt>公式LINE＋請求書払い</dt>
        <dd>
          {card.officialLinePaymentCondition.applicable ? "適用可" : "自動適用しない"}
          <span className="ml-1 text-gray-500">{card.officialLinePaymentCondition.reason}</span>
        </dd>
        {card.officialLinePaymentCondition.sourceDocumentTitle && (
          <>
            <dt>条件の出所</dt>
            <dd>{card.officialLinePaymentCondition.sourceDocumentTitle}</dd>
          </>
        )}
      </dl>

      {card.decisionNotes.length > 0 && (
        <div className="mt-2">
          <p className="font-bold">判断メモ</p>
          <ul className="mt-0.5 space-y-0.5">
            {card.decisionNotes.map((n, i) => (
              <li key={i}>・{n}</li>
            ))}
          </ul>
        </div>
      )}
      {card.missingInformation.length > 0 && (
        <div className="mt-2">
          <p className="font-bold">不足している情報</p>
          <ul className="mt-0.5 space-y-0.5">
            {card.missingInformation.map((n, i) => (
              <li key={i}>・{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function EvidenceView({
  evidence,
  draft,
  onUseCandidate,
  busy,
}: {
  evidence: NonNullable<ReplyDraftRecord["evidence"]>;
  draft: ReplyDraftRecord;
  onUseCandidate: (inventoryId: string) => void;
  busy: boolean;
}) {
  return (
    <div className="mt-2 space-y-2 border border-gray-200 bg-white p-2 text-[11px] text-gray-700">
      <p className="text-[11px] text-gray-400">この参照情報は担当者向けです。お客様へは送信されません。</p>

      {/* 2026-09-02 指示書§13: 処理経路をここだけで追えるようにする。 */}
      <Section title="処理の経路">
        <dl className="grid grid-cols-[7rem_1fr] gap-y-0.5">
          <dt>意図</dt>
NaN
          <dt>生成ルート</dt>
          <dd>{evidence.generationRoute === "negotiation" ? "negotiation（値下げ交渉）" : "standard（通常問い合わせ）"}</dd>
          <dt>商品特定</dt>
          <dd>{evidence.product ? "成功" : describeProductStatus(evidence.productStatus)}</dd>
          {evidence.baseProducts && evidence.baseProducts.length > 0 && (
            <>
              <dt>BASE商品</dt>
              <dd>
                {evidence.baseProducts.map((b) => (
                  <span key={b.baseItemId} className="block">
                    {b.baseItemId} / {b.title.slice(0, 40)}
                    {b.price != null ? ` / ${b.price.toLocaleString("ja-JP")}円` : ""}
                  </span>
                ))}
              </dd>
            </>
          )}
          {evidence.negotiation && (
            <>
              <dt>数量</dt>
              <dd>{evidence.negotiation.quantity ?? "（記載なし）"}</dd>
              <dt>希望総額</dt>
              <dd>
                {evidence.negotiation.requestedTotalPriceYen != null
                  ? `${evidence.negotiation.requestedTotalPriceYen.toLocaleString("ja-JP")}円`
                  : "（記載なし）"}
              </dd>
              <dt>配送先</dt>
              <dd>{evidence.shipping?.destinationPrefecture ?? "未確認"}</dd>
              <dt>値下げルール</dt>
              <dd>7%（既存の値引きルール文書に準拠）</dd>
              <dt>判定の根拠</dt>
              <dd>{evidence.negotiation.signals.join(" / ") || "（なし）"}</dd>
            </>
          )}
        </dl>
      </Section>

      <Section title="対象商品">
        {evidence.product ? (
          <p>
            {evidence.product.name}（在庫ID {evidence.product.displayInventoryId} / 確度 {Math.round(evidence.product.confidence * 100)}%）
          </p>
        ) : (
          <p className="text-gray-500">{describeProductStatus(evidence.productStatus)}</p>
        )}
        {evidence.productCandidates.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {evidence.productCandidates.map((c) => (
              <li key={c.inventoryId}>
                <CandidateLine candidate={c} onUse={onUseCandidate} busy={busy} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="参照した在庫情報">
        {evidence.inventoryFieldsUsed.length > 0 ? <p>{evidence.inventoryFieldsUsed.join(" / ")}</p> : <p className="text-gray-500">なし</p>}
      </Section>

      <Section title="参照した社内文書">
        {evidence.knowledgeDocuments.length > 0 ? (
          <ul className="space-y-0.5">
            {evidence.knowledgeDocuments.map((doc) => (
              <li key={doc.id}>✓ {doc.fileName}</li>
            ))}
          </ul>
        ) : (
          <p className="text-gray-500">なし</p>
        )}
      </Section>

      {evidence.shipping && (
        <Section title="送料（配送料金データベース）">
          <p>
            発送元 埼玉県 → {evidence.shipping.destinationPrefecture ?? "（お届け先が特定できていません）"}
            {evidence.shipping.rank ? ` / ランク ${evidence.shipping.rank}` : ""}
            {evidence.shipping.feeYen != null ? ` / ${evidence.shipping.feeYen.toLocaleString("ja-JP")}円` : ""}
          </p>
          {evidence.shipping.note && <p className="text-gray-500">{evidence.shipping.note}</p>}
        </Section>
      )}

      <Section title="外部情報">
        {/* Web検索は課金対象。何回呼んだかを必ず見えるようにする —— 在庫DBや
            社内文書で答えられた問い合わせでは0回になる。 */}
        <p className="text-gray-500">Web検索の呼び出し: {evidence.webSearchCallCount ?? 0}回</p>
        {evidence.externalFacts.length === 0 ? (
          <p className="text-gray-500">{evidence.externalResearchAttempted ? "取得できた情報はありません。" : "外部調査は実行していません。"}</p>
        ) : (
          <ul className="space-y-0.5">
            {evidence.externalFacts.map((fact, i) => (
              <li key={i}>
                <span>
                  {fact.field}: {fact.value ?? "（確認できず）"}
                </span>
                {fact.status !== "FOUND" && <span className="ml-1 text-amber-700">［{fact.status}］</span>}
                {/* 出典はタイトルとURLの両方を文字として出す。リンクの表示文字に
                    URLを隠すと、どのサイトの情報かがこの画面で読めない。
                    AgentCore Web Searchの利用条件も、検索結果を使った出力には
                    出典とリンクを保持・表示することを求めている。 */}
                {fact.sourceUrl && (
                  <div className="ml-3 text-gray-500">
                    <div>出典: {fact.sourceTitle ?? "(タイトル不明)"}</div>
                    <a href={fact.sourceUrl} target="_blank" rel="noopener noreferrer" className="break-all text-blue-700 underline">
                      {fact.sourceUrl}
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="不明点">
        {draft.unresolvedFacts.length === 0 ? (
          <p className="text-gray-500">なし</p>
        ) : (
          <ul className="space-y-0.5">
            {draft.unresolvedFacts.map((fact, i) => (
              <li key={i}>
                ・{fact.field}: {fact.reason}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {(draft.modelProvider || draft.modelName) && (
        <p className="text-gray-400">
          生成: {draft.modelProvider ?? "-"} / {draft.modelName ?? "-"}
        </p>
      )}
    </div>
  );
}

function CandidateLine({ candidate, onUse, busy }: { candidate: ProductMatch; onUse: (id: string) => void; busy: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        {candidate.name}（{Math.round(candidate.confidence * 100)}%）
        {candidate.reasons.length > 0 && <span className="text-gray-400"> — {candidate.reasons.join(" / ")}</span>}
      </span>
      <button type="button" onClick={() => onUse(candidate.inventoryId)} disabled={busy} className="border border-gray-300 px-1.5 py-0.5 text-[10px] text-gray-600 hover:bg-gray-50 disabled:opacity-40">
        この商品で再生成
      </button>
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="font-bold text-gray-800">{title}</p>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

function describeProductStatus(status: string): string {
  switch (status) {
    case "AMBIGUOUS":
      return "候補が複数あり、確定していません。";
    case "NOT_FOUND":
      return "問い合わせの情報に一致する在庫が見つかりませんでした。";
    case "NOT_REFERENCED":
      return "この問い合わせは特定の商品を指していません。";
    default:
      return "特定できていません。";
  }
}

function statusClass(status: ReplyDraftRecord["status"]): string {
  switch (status) {
    case "READY":
      return "bg-green-100 text-green-800";
    case "USED":
      return "bg-gray-200 text-gray-700";
    case "FAILED":
      return "bg-red-100 text-red-700";
    case "DISMISSED":
      return "bg-gray-200 text-gray-500";
    default:
      return "bg-amber-100 text-amber-800";
  }
}
