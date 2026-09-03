"use client";

import Link from "next/link";
import { InventoryThumbnail } from "../../InventoryThumbnail";
import type { IdentifiedProductCard } from "@/lib/inquiry/types";

/**
 * メッセージ画面の「対象商品」カード。
 *
 * ── 顧客へは送られない ──────────────────────────────────────────
 *
 * 仕入価格と販売開始日時を含む。値下げ交渉のときにこの2つをすぐ確認
 * したい、という運用要件から来ている。返信本文の組み立てへは渡らない
 * 経路になっている。
 *
 * 【今どこで使われているか】2026-09-03 追加指示§1で「お問い合わせ」タブを
 * 外したため、以前の置き場所(AI返信パネル)は無くなった。現在は
 * AI処理ログの詳細で「この通知はどの商品として処理されたか」を示すために
 * 使う —— 同じデータは社内LINEの1通目にも入っており、通知を見た人が後から
 * 画面で裏を取れるようにするのがこのカードの役割。
 *
 * ── 一意に特定できたときだけ出す ────────────────────────────────
 *
 * 候補の1つを載せると、担当者がそれを確定した商品だと思い込む。
 * 特定できていないときはカードごと出さない（呼び出し側が null を渡す）。
 *
 * ── 部品は使い回す ──────────────────────────────────────────────
 *
 * 画像は既存の InventoryThumbnail をそのまま使う。Storage のURL解決・
 * 失敗時の再試行・Cognito スコープの扱いが既にそこにあるので、ここで
 * 作り直さない。
 */
export function IdentifiedProductCardView({ card }: { card: IdentifiedProductCard }) {
  const yen = (v: number | null) => (v == null ? "—" : `${v.toLocaleString("ja-JP")}円`);
  const date = (v: string | null) => (v == null ? "—" : new Date(v).toLocaleDateString("ja-JP"));

  const basisLabel: Record<string, string> = {
    BASE_ITEM_ID: "商品URLのIDで特定",
    STRONG_CODE: "SKU・在庫IDで特定",
    OPERATOR_OR_CONVERSATION: "担当者の選択／会話の紐付け",
    NAME_ONLY: "商品名の一致のみ",
    NONE: "未特定",
  };

  return (
    <div className="border border-gray-300 bg-white p-3 text-[11px] text-gray-800">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[12px] font-bold text-gray-900">対象商品（担当者向け・お客様には送信されません）</p>
        <span className="shrink-0 border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-600">
          {basisLabel[card.basis] ?? card.basis}
        </span>
      </div>

      {/* 狭い画面では縦、広い画面では画像＋情報の横並び。
          メッセージ画面は右ペインが狭いことがあるので、既定を縦にする。 */}
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="shrink-0">
          <InventoryThumbnail storageKey={card.imageKey} alt={card.name} size="list" loading="lazy" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="mb-1 break-words text-[12px] font-bold text-gray-900">{card.name}</p>

          <dl className="grid grid-cols-[6.5rem_1fr] gap-y-0.5">
            <dt className="text-gray-500">在庫ID</dt>
            <dd className="break-all">{card.displayInventoryId}</dd>

            <dt className="text-gray-500">SKU</dt>
            <dd className="break-all">{card.sku}</dd>

            {/* まだ売れていない商品では plannedSalePrice(販売予定価格)が
                現在の売値。成約済みの実売価格と混同させないよう、見出しで
                どちらなのかを言う。 */}
            <dt className="text-gray-500">{card.salePriceSource === "plannedSalePrice" ? "販売予定価格" : "販売価格"}</dt>
            <dd>{yen(card.salePriceYen)}</dd>

            {/* 仕入価格と販売開始日時は担当者専用。色を変えて、顧客へ
                そのまま貼らないことが目で分かるようにする。 */}
            <dt className="text-amber-800">仕入価格</dt>
            <dd className="text-amber-800">{yen(card.purchasePriceYen)}</dd>

            <dt className="text-amber-800">販売開始日時</dt>
            <dd className="text-amber-800">{date(card.saleStartedAt)}</dd>

            {/* 数量は必ず出す。「在庫が残っているか」は値下げ交渉の判断に
                直接効く（残1点なら値下げる理由が薄い）。 */}
            <dt className="text-gray-500">数量</dt>
            <dd>{card.quantity ?? "—"}</dd>

            {/* 在庫ステータスは StatusMaster が未整備だと常に空になる
                （Staging実測: statusId 0/5,327件、StatusMaster 0件）。
                空の行を出すと担当者が「壊れている」と読むので、値がある
                ときだけ出す —— マスタが整備されれば自動で出る。 */}
            {card.statusName && (
              <>
                <dt className="text-gray-500">在庫ステータス</dt>
                <dd>{card.statusName}</dd>
              </>
            )}

            {card.baseItemId && (
              <>
                <dt className="text-gray-500">BASE商品ID</dt>
                <dd className="break-all">{card.baseItemId}</dd>
              </>
            )}
          </dl>

          <div className="mt-2 flex flex-wrap gap-3">
            <Link
              href={`/inventory/${card.inventoryId}`}
              className="text-[11px] text-blue-700 underline hover:text-blue-900"
            >
              BELLO在庫詳細を開く
            </Link>
            {card.baseItemUrl && (
              <a
                href={card.baseItemUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-blue-700 underline hover:text-blue-900"
              >
                BASE商品ページを開く
              </a>
            )}
          </div>
        </div>
      </div>

      {/* 問い合わせにあったURLのうち、この商品と結び付けられなかったもの。
          勝手に1商品へ固定したように見せないための注記。件数は組み立て側
          (lib/inquiry/pipeline.ts)が決める —— どのURLがこの在庫に対応
          するかを知っているのはそちらだけなので、ここでは数え直さない。 */}
      {card.unlinkedBaseProductCount > 0 && (
        <p className="mt-2 border-t border-gray-200 pt-2 text-[10px] text-amber-800">
          この問い合わせには商品URLが{card.unlinkedBaseProductCount}件含まれていますが、
          上の商品とは結び付けられていません（上の商品は
          {card.basis === "OPERATOR_OR_CONVERSATION" ? "担当者の選択・会話の紐付け" : "商品名などの照合"}
          で特定したものです）。別の商品について回答する場合は、下の候補から選び直してください。
        </p>
      )}
    </div>
  );
}
