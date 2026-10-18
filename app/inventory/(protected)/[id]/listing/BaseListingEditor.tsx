"use client";
import { useEffect, useState } from "react";
import {
  getBaseChannelListingAction,
  saveBaseChannelOverrideAction,
} from "@/app/actions/listing";
import { EcPresetPicker } from "../../listings/EcPresetPicker";
import { presetDescription } from "@/lib/listing/ecPresets";
import type { ListingDraftRecord } from "@/lib/listing/types";
const field = "mt-1 w-full rounded border border-gray-300 p-2 text-sm";
export function BaseListingEditor({
  inventoryId,
  draft,
}: {
  inventoryId: string;
  draft: ListingDraftRecord | null;
}) {
  const [title, setTitle] = useState(""),
    [description, setDescription] = useState(""),
    [price, setPrice] = useState("");
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    let live = true;
    getBaseChannelListingAction(inventoryId)
      .then((row) => {
        if (!live) return;
        setTitle(row?.overrideTitle ?? "");
        setDescription(row?.overrideDescription ?? "");
        setPrice(row?.overridePrice == null ? "" : String(row.overridePrice));
        setReady(true);
      })
      .catch(() => {
        if (live)
          setMessage(
            "BASE用の商品情報を読み込めませんでした。再読み込みしてください。",
          );
      });
    return () => {
      live = false;
    };
  }, [inventoryId]);
  async function save() {
    if (!draft || busy || !ready) return;
    setBusy(true);
    setMessage("");
    try {
      await saveBaseChannelOverrideAction(inventoryId, {
        categoryMapping: null,
        overrideTitle: title || null,
        overrideDescription: description || null,
        overridePrice: price === "" ? null : Number(price),
      });
      setMessage(
        "BASE用の商品情報を保存しました。商品一覧から出品・内容更新できます。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="max-w-2xl rounded-lg border bg-white p-5">
      <h3 className="font-bold">BASEの商品情報</h3>
      {!draft ? (
        <p className="mt-3 text-sm">先に共通の商品情報を保存してください。</p>
      ) : (
        <>
          <p className="mt-2 text-sm text-gray-500">
            空欄の項目は共通の商品情報を使います。写真は共通タブで選んだ
            {draft.images.length}枚です。
          </p>
          <fieldset disabled={!ready || busy} className="mt-3 space-y-4">
            <EcPresetPicker
              channel="BASE"
              disabled={!ready || busy}
              onApply={(p) => {
                if (!draft.channelPrices) setPrice(
                  draft.price == null
                    ? ""
                    : String(draft.price + p.values.priceAddition),
                );
                setDescription(
                  presetDescription(
                    draft.description ?? "",
                    p.values.descriptionSuffix,
                  ),
                );
                setMessage(
                  `「${p.name}」を適用しました。保存するとBASE用の商品情報に反映されます。`,
                );
              }}
            />
            <label className="block text-sm">
              商品名
              <input
                className={field}
                value={title}
                placeholder={draft.title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              商品説明
              <textarea
                className={field}
                rows={7}
                value={description}
                placeholder={draft.description ?? ""}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <label className="block text-sm">
              単価（円）
              <input
                className={field}
                type="number"
                inputMode="numeric"
                min={1}
                step={1}
                value={draft.channelPrices ? draft.channelPrices.BASE ?? "" : price}
                readOnly={!!draft.channelPrices}
                placeholder={draft.price?.toString() ?? "未設定"}
                onChange={(e) => setPrice(e.target.value)}
              />
              {draft.channelPrices && <span className="mt-1 block text-xs text-gray-500">価格は「共通の商品情報」で変更できます。</span>}
            </label>
            <button
              type="button"
              className="rounded bg-blue-700 px-4 py-2 text-sm text-white disabled:opacity-40"
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存"}
            </button>
          </fieldset>
        </>
      )}
      {message && (
        <p role="status" className="mt-3 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
