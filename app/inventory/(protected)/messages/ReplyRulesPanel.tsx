"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createReplyRuleAction,
  deleteReplyRuleAction,
  setReplyRuleEnabledAction,
  updateReplyRuleAction,
} from "@/app/actions/replyRules";
import {
  REPLY_RULE_CATEGORIES,
  REPLY_RULE_CATEGORY_LABEL,
  type ReplyRuleCategory,
  type ReplyRuleRecord,
} from "@/lib/inquiry/replyRuleSelection";
import { MESSAGE_CHANNEL_LABEL, type MessageChannel } from "@/lib/messaging/types";

/**
 * 2026-09-03 指示書 §16/§26: 返信ルールの管理画面。
 *
 * ── ナレッジと役割が違うことを画面でも示す ──────────────────────
 *
 * §19。ここに入れるのは「どう判断するか」で、送料表やブランド情報の
 * ような「判断に使う情報」はナレッジタブへ入れる。同じ画面の別タブに
 * 並べたうえで、説明文でその違いを明示する —— 混ざると、ルールとして
 * 書いた文章が事実として顧客へ書き写される。
 */

/** 顧客と接点のあるチャネルだけを選ばせる。TEST は運用者が選ぶものではない。 */
const SELECTABLE_CHANNELS: MessageChannel[] = ["LINE", "BASE", "MERCARI_SHOPS", "YAHOO_AUCTION", "EMAIL"];

interface FormState {
  title: string;
  category: ReplyRuleCategory;
  description: string;
  conditions: string;
  instruction: string;
  priority: number;
  enabled: boolean;
  channelScope: MessageChannel[];
}

const EMPTY_FORM: FormState = {
  title: "",
  category: "DISCOUNT",
  description: "",
  conditions: "",
  instruction: "",
  priority: 100,
  enabled: true,
  channelScope: [],
};

function toForm(rule: ReplyRuleRecord): FormState {
  return {
    title: rule.title,
    category: rule.category,
    description: rule.description ?? "",
    conditions: rule.conditions ?? "",
    instruction: rule.instruction,
    priority: rule.priority,
    enabled: rule.enabled,
    channelScope: rule.channelScope,
  };
}

export function ReplyRulesPanel({ rules, isAdmin }: { rules: ReplyRuleRecord[]; isAdmin: boolean }) {
  const router = useRouter();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, successText: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fn();
      if (res.ok) {
        setMessage({ kind: "success", text: successText });
        router.refresh();
        return true;
      }
      setMessage({ kind: "error", text: res.error });
      return false;
    } catch (err) {
      setMessage({ kind: "error", text: err instanceof Error ? err.message : "操作に失敗しました。" });
      return false;
    } finally {
      setBusy(false);
    }
  }

  function startCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setCreating(true);
    setMessage(null);
  }

  function startEdit(rule: ReplyRuleRecord) {
    setForm(toForm(rule));
    setEditingId(rule.id);
    setCreating(false);
    setMessage(null);
  }

  function cancel() {
    setCreating(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  const payload = () => ({
    title: form.title,
    category: form.category,
    description: form.description.trim() || null,
    conditions: form.conditions.trim() || null,
    instruction: form.instruction,
    priority: form.priority,
    enabled: form.enabled,
    channelScope: form.channelScope,
    productCategoryScope: [] as string[],
  });

  const showForm = creating || editingId !== null;

  return (
    <div className="space-y-4 p-4 text-[13px] text-gray-800">
      <section className="border border-gray-300 bg-white p-4">
        <h3 className="mb-1 text-[14px] font-bold text-gray-900">返信ルール</h3>
        <p className="text-[12px] leading-relaxed text-gray-600">
          AIが返信案を作るときの<strong>判断の方針</strong>を登録します。
          「配送先が分からない値下げ交渉では、先に都道府県を伺う」のような、
          <strong>どう判断するか</strong>をここへ書きます。
          <br />
          送料表やブランドの情報など、<strong>判断に使う情報そのもの</strong>は「ナレッジ」タブへ登録してください。
          金額の計算・2週間判定・商品特定はコードが行うため、ここへ書いても計算方法は変わりません。
        </p>
        {isAdmin && !showForm && (
          <button
            type="button"
            onClick={startCreate}
            className="mt-3 border border-gray-800 bg-gray-800 px-3 py-1.5 text-[12px] text-white hover:bg-gray-700"
          >
            ルールを追加
          </button>
        )}
        {message && (
          <p
            className={`mt-3 border p-2 text-[12px] ${
              message.kind === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-red-300 bg-red-50 text-red-800"
            }`}
          >
            {message.text}
          </p>
        )}
      </section>

      {showForm && (
        <section className="border border-gray-300 bg-white p-4">
          <h4 className="mb-3 text-[13px] font-bold text-gray-900">{creating ? "新しいルール" : "ルールを編集"}</h4>
          <div className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">ルール名</span>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
                placeholder="配送先が不明な値下げ交渉"
              />
            </label>

            <div className="flex flex-wrap gap-3">
              <label className="block">
                <span className="mb-1 block text-[12px] text-gray-700">分類</span>
                <select
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value as ReplyRuleCategory })}
                  className="border border-gray-300 px-2 py-1.5 text-[13px]"
                >
                  {REPLY_RULE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {REPLY_RULE_CATEGORY_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="mb-1 block text-[12px] text-gray-700">優先度（小さいほど先）</span>
                <input
                  type="number"
                  min={0}
                  max={9999}
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
                  className="w-28 border border-gray-300 px-2 py-1.5 text-[13px]"
                />
              </label>

              <label className="flex items-end gap-2 pb-1.5">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                <span className="text-[12px] text-gray-700">有効</span>
              </label>
            </div>

            <div>
              <span className="mb-1 block text-[12px] text-gray-700">適用チャネル（未選択なら全チャネル）</span>
              <div className="flex flex-wrap gap-3">
                {SELECTABLE_CHANNELS.map((ch) => (
                  <label key={ch} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={form.channelScope.includes(ch)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          channelScope: e.target.checked
                            ? [...form.channelScope, ch]
                            : form.channelScope.filter((c) => c !== ch),
                        })
                      }
                    />
                    <span className="text-[12px]">{MESSAGE_CHANNEL_LABEL[ch]}</span>
                  </label>
                ))}
              </div>
            </div>

            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">適用条件（任意・AIへ渡ります）</span>
              <textarea
                value={form.conditions}
                onChange={(e) => setForm({ ...form, conditions: e.target.value })}
                rows={2}
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
                placeholder="お届け先の都道府県が分かっていないとき"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">指示内容（AIへ渡ります）</span>
              <textarea
                value={form.instruction}
                onChange={(e) => setForm({ ...form, instruction: e.target.value })}
                rows={6}
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
                placeholder="値引きの可否・金額を書かず、まずお届け先の都道府県を伺う内容にする。"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[12px] text-gray-700">メモ（任意・AIへは渡りません）</span>
              <input
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full border border-gray-300 px-2 py-1.5 text-[13px]"
              />
            </label>
          </div>

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const ok = creating
                  ? await run(() => createReplyRuleAction(payload()), "ルールを追加しました。")
                  : await run(() => updateReplyRuleAction(editingId!, payload()), "ルールを更新しました。");
                if (ok) cancel();
              }}
              className="border border-gray-800 bg-gray-800 px-3 py-1.5 text-[12px] text-white hover:bg-gray-700 disabled:opacity-50"
            >
              保存
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={cancel}
              className="border border-gray-400 bg-white px-3 py-1.5 text-[12px] hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </section>
      )}

      <section className="border border-gray-300 bg-white">
        {rules.length === 0 ? (
          <p className="p-4 text-[12px] text-gray-500">
            返信ルールがまだ登録されていません。ルールが無くても返信案は生成されます（ナレッジとコードの判断が使われます）。
          </p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {rules.map((rule) => (
              <li key={rule.id} className="p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-bold text-gray-900">{rule.title}</span>
                      <span className="border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
                        {REPLY_RULE_CATEGORY_LABEL[rule.category]}
                      </span>
                      <span className="text-[10px] text-gray-500">優先度 {rule.priority}</span>
                      {!rule.enabled && (
                        <span className="border border-gray-300 bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">無効</span>
                      )}
                      {rule.channelScope.length > 0 && (
                        <span className="text-[10px] text-gray-500">
                          {rule.channelScope.map((c) => MESSAGE_CHANNEL_LABEL[c]).join("・")}のみ
                        </span>
                      )}
                    </p>
                    {rule.conditions && <p className="mt-1 text-[12px] text-gray-600">適用条件: {rule.conditions}</p>}
                    <p className="mt-1 whitespace-pre-wrap text-[12px] text-gray-700">{rule.instruction}</p>
                  </div>

                  {isAdmin && (
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => startEdit(rule)}
                        className="border border-gray-400 bg-white px-2 py-1 text-[11px] hover:bg-gray-50"
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          run(
                            () => setReplyRuleEnabledAction(rule.id, !rule.enabled),
                            rule.enabled ? "ルールを無効にしました。" : "ルールを有効にしました。",
                          )
                        }
                        className="border border-gray-400 bg-white px-2 py-1 text-[11px] hover:bg-gray-50"
                      >
                        {rule.enabled ? "無効化" : "有効化"}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          // §26 削除確認は必須。
                          if (!window.confirm(`「${rule.title}」を削除します。本当に削除してもよろしいでしょうか。`)) return;
                          void run(() => deleteReplyRuleAction(rule.id), "ルールを削除しました。");
                        }}
                        className="border border-red-300 bg-white px-2 py-1 text-[11px] text-red-700 hover:bg-red-50"
                      >
                        削除
                      </button>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
