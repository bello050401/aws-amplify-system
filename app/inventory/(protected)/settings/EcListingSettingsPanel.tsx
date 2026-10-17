"use client";
import { useState } from "react";
import Link from "next/link";
import { EcPresetManager } from "./EcPresetManager";
import { renewMercariHttpConnectionAction } from "@/app/actions/mercariWebHttpLifecycle";
import { checkYahooHttpsConnectionAction } from "@/app/actions/yahooAuctionHttp";

const card = "rounded-xl border border-gray-200 bg-white p-5";
const button =
  "mt-3 inline-block rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-40";
export function EcListingSettingsPanel({
  isAdmin,
  onOpen,
}: {
  isAdmin: boolean;
  onOpen: (tab: "base" | "mercariBridge" | "shipping" | "photoProfile" | "productDescription") => void;
}) {
  const [busy, setBusy] = useState<string | null>(null),
    [messages, setMessages] = useState<Record<string, string>>({});
  async function check(target: "mercari" | "yahoo") {
    if (busy) return;
    setBusy(target);
    try {
      let text: string;
      if (target === "mercari") {
        const r = await renewMercariHttpConnectionAction();
        text =
          r === "CONNECTED"
            ? "メルカリShopsに接続できました。"
            : r === "AUTH_REQUIRED"
              ? "メルカリShopsへの再ログインが必要です。"
              : "接続を確認できませんでした。";
      } else {
        const r = await checkYahooHttpsConnectionAction();
        text = r.ok ? "ヤフオクに接続できました。" : "ヤフオクのログイン状態を確認してください。";
      }
      setMessages((m) => ({ ...m, [target]: text }));
    } catch {
      setMessages((m) => ({
        ...m,
        [target]: "接続を確認できませんでした。時間を空けて再試行してください。",
      }));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="max-w-5xl">
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold">出品設定</h2>
          <p className="mt-1 text-sm text-gray-500">
            販売先の接続と、繰り返し使う配送・文章・画像の設定を管理します。
          </p>
        </div>
        <Link href="/inventory/listings" className="text-sm text-blue-700 underline">
          EC商品一覧へ
        </Link>
      </div>
      <EcPresetManager isAdmin={isAdmin} />
      <h3 className="mb-3 text-sm font-bold">販売先との接続</h3>
      <div className="grid gap-4 md:grid-cols-3">
        <section className={card}>
          <h4 className="font-bold">メルカリShops</h4>
          <p className="mt-2 text-sm text-gray-600">出品・出品停止に使う接続を確認します。</p>
          {isAdmin && (
            <button type="button" disabled={!!busy} onClick={() => void check("mercari")} className={button}>
              {busy === "mercari" ? "確認中…" : "接続を確認・更新"}
            </button>
          )}
          {messages.mercari && (
            <p role="status" className="mt-2 text-sm">
              {messages.mercari}
            </p>
          )}
          {isAdmin && (
            <details className="mt-4 text-xs">
              <summary className="cursor-pointer text-gray-500">PC連携・既存商品の照合</summary>
              <button className="mt-2 block text-blue-700 underline" onClick={() => onOpen("mercariBridge")}>
                PC連携の設定
              </button>
              <Link className="mt-2 block text-blue-700 underline" href="/inventory/mercari-bridge">
                既存の商品を照合する
              </Link>
            </details>
          )}
        </section>
        <section className={card}>
          <h4 className="font-bold">ヤフオク!</h4>
          <p className="mt-2 text-sm text-gray-600">個人アカウントの接続を確認します。</p>
          {isAdmin && (
            <button type="button" disabled={!!busy} onClick={() => void check("yahoo")} className={button}>
              {busy === "yahoo" ? "確認中…" : "接続を確認"}
            </button>
          )}
          {messages.yahoo && (
            <p role="status" className="mt-2 text-sm">
              {messages.yahoo}
            </p>
          )}
          <p className="mt-4 text-xs text-gray-500">
            商品別のカテゴリ・価格・終了日時は、商品情報のヤフオク!タブで編集します。
          </p>
        </section>
        <section className={card}>
          <h4 className="font-bold">BASE</h4>
          <p className="mt-2 text-sm text-gray-600">ショップとの連携、商品登録権限を設定します。</p>
          {isAdmin && (
            <button type="button" onClick={() => onOpen("base")} className={button}>
              BASE連携を開く
            </button>
          )}
          <p className="mt-4 text-xs text-gray-500">商品一覧から、画像の準備・公開・出品停止を行います。</p>
        </section>
      </div>
      <h3 className="mb-3 mt-6 text-sm font-bold">共通設定</h3>
      <div className="grid gap-4 md:grid-cols-2">
        <section className={card}>
          <h4 className="font-bold">配送・送料</h4>
          <p className="mt-2 text-sm text-gray-600">
            家財便の料金表と配送条件を管理します。商品ごとの家財便・佐川急便の選択は商品編集にあります。
          </p>
          {isAdmin && (
            <button type="button" onClick={() => onOpen("shipping")} className={button}>
              送料設定
            </button>
          )}
        </section>
        <section className={card}>
          <h4 className="font-bold">商品説明・定型文</h4>
          <p className="mt-2 text-sm text-gray-600">説明文の構成、配送案内、繰り返し使う文章を管理します。</p>
          <button type="button" onClick={() => onOpen("productDescription")} className={button}>
            商品説明文の設定
          </button>
        </section>
        <section className={card}>
          <h4 className="font-bold">出品画像</h4>
          <p className="mt-2 text-sm text-gray-600">写真の仕上がりと画像処理の共通設定を管理します。</p>
          {isAdmin && (
            <button type="button" onClick={() => onOpen("photoProfile")} className={button}>
              画像の設定
            </button>
          )}
        </section>
        <section className={card}>
          <h4 className="font-bold">自動値下げ</h4>
          <p className="mt-2 text-sm text-gray-600">値下げの間隔、金額、下限価格を管理します。</p>
          {isAdmin && (
            <Link href="/inventory/listings/pricing-rules" className={button}>
              値下げルール
            </Link>
          )}
        </section>
      </div>
    </div>
  );
}
