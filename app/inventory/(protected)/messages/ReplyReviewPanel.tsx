"use client";
import type { ReplyEvidence } from "@/lib/inquiry/types";
import { reviewCustomerDraft } from "@/lib/inquiry/review";
export default function ReplyReviewPanel({
  evidence,
  text,
}: {
  evidence: ReplyEvidence | null;
  text: string;
}) {
  if (!evidence) return null;
  const review = reviewCustomerDraft(text, evidence),
    q = evidence.quote;
  const money = (n: number | null) =>
    n === null ? "未確認" : n.toLocaleString("ja-JP") + "円";
  return (
    <section className="mt-4 space-y-3" aria-label="返信内容の点検">
      <div
        className={
          "rounded-xl border p-4 " +
          (review.status === "REVIEWABLE"
            ? "border-teal-200 bg-teal-50"
            : "border-amber-200 bg-amber-50")
        }
      >
        <h4 className="font-semibold">
          {review.status === "REVIEWABLE"
            ? "返信案を確認できます"
            : review.status === "NEEDS_CUSTOMER"
              ? "お客様への確認が必要です"
              : "社内で確認してください"}
        </h4>
        <p className="mt-1 text-xs text-slate-600">
          自動送信は行いません。編集した内容も再点検します。
        </p>
        {review.issues.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {review.issues.map((i) => (
              <li key={i.code}>{i.message}</li>
            ))}
          </ul>
        )}
      </div>
      {q && (
        <details className="rounded-xl border bg-white p-4" open>
          <summary className="font-semibold">
            送料・お支払金額 {q.confirmed ? "計算済み" : "確認待ち"}
          </summary>
          <p className="my-2 text-sm text-slate-600">
            {q.conditions.origin ?? "発送元未確認"} →{" "}
            {q.conditions.destination ?? "配送先未確認"}{" "}
            {q.conditions.area ?? ""} /{" "}
            {q.conditions.packages.join("・") || "ランク・口数未確認"}
          </p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-2 text-sm">
            <dt>商品代金</dt>
            <dd>{money(q.merchandiseYen)}</dd>
            <dt>お客様への送料</dt>
            <dd>{money(q.customerShippingYen)}</dd>
            <dt>
              地域加算{" "}
              {q.policy?.regionalTreatment === "INCLUDED_IN_SHIPPING"
                ? "（送料内）"
                : "（別途）"}
            </dt>
            <dd>{money(q.regionalYen)}</dd>
            <dt>オプション料金</dt>
            <dd>{money(q.optionsYen)}</dd>
            <dt>承認済み割引</dt>
            <dd>{money(q.discountYen)}</dd>
            <dt className="border-t pt-2 font-semibold">お支払総額</dt>
            <dd className="border-t pt-2 font-semibold">{money(q.totalYen)}</dd>
          </dl>
          {q.reasons.map((r, i) => (
            <p key={i} className="mt-2 text-sm text-amber-900">
              {r}
            </p>
          ))}
          <details className="mt-3 text-xs text-slate-600">
            <summary>計算の根拠・配送原価（社内用）</summary>
            <p className="mt-2">
              配送原価：{money(q.carrierCostYen)}
              。お客様への請求送料とは別です。
            </p>
            <p>
              計算日：{q.asOfDate} / ルール：
              {q.policy ? `${q.policy.id}・${q.policy.version}` : "未確認"}
            </p>
            {q.rates.map((r, i) => (
              <p key={i} className="mt-2 break-words">
                料金表 {r.id} / 版{r.version} / 適用{" "}
                {r.effectiveFrom ?? "開始日未登録"}〜
                {r.effectiveTo ?? "終了日なし"}
                <br />
                {r.source ?? "出典未登録"}
              </p>
            ))}
          </details>
        </details>
      )}
      {evidence.researchAvailability?.reason && (
        <p className="rounded-lg bg-slate-50 p-3 text-sm">
          外部調査：{evidence.researchAvailability.reason}
        </p>
      )}
      {!!evidence.externalFacts.length && (
        <details className="rounded-xl border bg-white p-4 text-sm">
          <summary className="font-semibold">調べた資料・回答の根拠</summary>
          <div className="mt-3 space-y-3">
            {evidence.externalFacts.map((f, i) => (
              <div key={i} className="border-t pt-3">
                <p className="font-medium">
                  {f.field}：{f.value ?? "未確認"}
                </p>
                <p className="text-xs text-slate-600">
                  {f.status} / {f.modelEvidence ?? "対象仕様の確認なし"}
                </p>
                {f.sourceUrl && /^https:\/\//.test(f.sourceUrl) && (
                  <a
                    href={f.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="break-all text-teal-800 underline"
                  >
                    {f.sourceTitle ?? "参照元を開く"}
                  </a>
                )}
                {f.excerpt && (
                  <blockquote className="my-2 border-l-2 pl-3 text-slate-600">
                    {f.excerpt}
                  </blockquote>
                )}
                {f.retrievedAt && (
                  <p className="text-xs text-slate-500">
                    取得：{new Date(f.retrievedAt).toLocaleString("ja-JP")}
                  </p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
