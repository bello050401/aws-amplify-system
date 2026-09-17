import { readBudgetSummary } from "@/lib/ai/gateway/commonBudget";

/** Parent renders only after checking ADMIN. This is a read-only, isolated status panel. */
export async function AIBudgetSummary() {
  try {
    const budget = await readBudgetSummary();
    if (!budget.initialized) return <p className="px-6 py-2 text-sm text-amber-700">AI予算：月300円。利用額の確認・初期設定が必要です。有料AIは停止中です。</p>;
    const yen = (n: number) => `${n.toLocaleString("ja-JP", { maximumFractionDigits: 2 })}円`;
    return <section aria-label="AI月次予算" className="px-6 py-2 text-sm text-gray-600">
      <p>{budget.month}：月上限300円 ／ 計上額 {yen(budget.spentJPY)} ／ 処理中・確認待ち {yen(budget.reservedJPY)} ／ 残予算 {yen(Math.max(0, budget.remainingJPY))}</p>
      <p>呼出予約 {budget.callCount}回。計上額は確認済み換算上限による管理額です。未完了の呼出しも枠を確保します。</p>
    </section>;
  } catch {
    return <p className="px-6 py-2 text-sm text-amber-700">AI予算を確認できません。金額を0円として扱わず、有料AIは予算確認後に実行します。</p>;
  }
}
