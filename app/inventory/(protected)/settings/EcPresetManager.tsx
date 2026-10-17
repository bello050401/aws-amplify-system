"use client";
import { useEffect, useState } from "react";
import {
  listEcPresetsAction,
  saveEcPresetAction,
} from "@/app/actions/ecListingPresets";
import {
  EC_CHANNELS,
  EC_CHANNEL_LABEL,
  type EcChannel,
} from "@/lib/listing/ecManagement";
import { EMPTY_EC_PRESET, type EcPreset } from "@/lib/listing/ecPresets";
import { MercariFurnitureCategoryPicker } from "../[id]/listing/MercariFurnitureCategoryPicker";
import { searchYahooCategoriesAction } from "@/app/actions/yahooAuctionWorkflow";
const field =
  "mt-1 block w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm";
export function EcPresetManager({ isAdmin }: { isAdmin: boolean }) {
  const [presets, setPresets] = useState<EcPreset[]>([]),
    [channel, setChannel] = useState<EcChannel>("MERCARI_SHOPS");
  const [selected, setSelected] = useState<EcPreset | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [categoryQuery, setCategoryQuery] = useState(""),
    [categories, setCategories] = useState<{ id: string; path: string }[]>([]);
  const original = selected && presets.find((p) => p.id === selected.id);
  const dirty =
    !!selected && JSON.stringify(selected) !== JSON.stringify(original);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  function canLeave() {
    return (
      !busy && (!dirty || window.confirm("保存していない設定を破棄しますか？"))
    );
  }
  useEffect(() => {
    listEcPresetsAction()
      .then(setPresets)
      .catch(() =>
        setMessage("設定を読み込めませんでした。再読み込みしてください。"),
      );
  }, []);
  function add() {
    if (!canLeave()) return;
    setSelected({
      id: crypto.randomUUID(),
      name: "",
      channel,
      revision: 0,
      values: { ...EMPTY_EC_PRESET },
      deleted: false,
    });
    setMessage("");
    setCategories([]);
  }
  async function save(deleted = false) {
    if (!selected || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const saved = await saveEcPresetAction({ ...selected, deleted });
      setPresets((old) => [
        ...old.filter((p) => p.id !== saved.id),
        ...(deleted ? [] : [saved]),
      ]);
      setSelected(deleted ? null : saved);
      setMessage(
        deleted
          ? "設定を削除しました。商品に保存済みの内容は残ります。"
          : "出品設定を保存しました。商品編集で選択して使えます。",
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "保存できませんでした。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mb-6 rounded-xl border bg-white p-4 sm:p-5">
      <h3 className="font-bold">配送・出品設定</h3>
      <p className="mt-1 text-sm text-gray-500">
        名前を付けて保存し、商品編集で選んで適用します。
      </p>
      <div
        className="mt-4 flex gap-1 overflow-x-auto border-b"
        role="tablist"
        aria-label="出品設定の販売先"
      >
        {EC_CHANNELS.map((c) => (
          <button
            key={c}
            role="tab"
            aria-selected={channel === c}
            className={`whitespace-nowrap border-b-2 px-4 py-2 text-sm ${channel === c ? "border-blue-700 text-blue-700" : "border-transparent"}`}
            onClick={() => {
              if (!canLeave()) return;
              setChannel(c);
              setSelected(null);
              setMessage("");
              setCategories([]);
            }}
          >
            {EC_CHANNEL_LABEL[c]}
          </button>
        ))}
      </div>
      <div className="mt-4 grid gap-5 md:grid-cols-[220px_1fr]">
        <div className="space-y-2">
          {presets
            .filter((p) => p.channel === channel)
            .map((p) => (
              <button
                key={p.id}
                className={`block w-full rounded border px-3 py-2 text-left text-sm ${selected?.id === p.id ? "border-blue-600 bg-blue-50" : "border-gray-200"}`}
                onClick={() => {
                  if (!canLeave()) return;
                  setSelected(p);
                  setMessage("");
                  setCategories([]);
                }}
              >
                {p.name}
              </button>
            ))}
          {isAdmin && (
            <button
              onClick={add}
              className="w-full rounded border border-dashed px-3 py-2 text-sm text-blue-700"
            >
              ＋ 設定を追加
            </button>
          )}
        </div>
        {selected ? (
          <fieldset disabled={!isAdmin || busy} className="space-y-4">
            <label className="block text-sm">
              設定名
              <input
                className={field}
                maxLength={30}
                value={selected.name}
                onChange={(e) =>
                  setSelected({ ...selected, name: e.target.value })
                }
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm">
                共通価格に加算する金額（円）
                <input
                  className={field}
                  type="number"
                  inputMode="numeric"
                  value={selected.values.priceAddition}
                  onChange={(e) =>
                    setSelected({
                      ...selected,
                      values: {
                        ...selected.values,
                        priceAddition: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              {channel !== "BASE" && (
                <label className="text-sm">
                  配送方法
                  <select
                    className={field}
                    value={
                      channel === "MERCARI_SHOPS"
                        ? selected.values.shopsDelivery
                        : selected.values.shippingMethod
                    }
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        values: {
                          ...selected.values,
                          ...(channel === "MERCARI_SHOPS"
                            ? {
                                shopsDelivery: e.target.value as
                                  "UNDECIDED" | "MERCARI_SHIPPING_YAMATO",
                              }
                            : {
                                shippingMethod: e.target.value as
                                  "KAZAI" | "SAGAWA",
                              }),
                        },
                      })
                    }
                  >
                    {channel === "MERCARI_SHOPS" ? (
                      <>
                        <option value="UNDECIDED">
                          出品者が手配（名前配送）
                        </option>
                        <option value="MERCARI_SHIPPING_YAMATO">
                          らくらくメルカリ便（匿名配送）
                        </option>
                      </>
                    ) : (
                      <>
                        <option value="KAZAI">家財おまかせ便</option>
                        <option value="SAGAWA">佐川急便</option>
                      </>
                    )}
                  </select>
                </label>
              )}
            </div>
            {channel !== "BASE" && (
              <p className="rounded bg-gray-50 p-3 text-sm">
                送料込み（出品者負担）・埼玉県から発送・
                {channel === "MERCARI_SHOPS" ? "4〜7日" : "3〜7日"}で発送
              </p>
            )}
            {channel === "YAHOO" && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="text-sm">
                  出品から終了まで
                  <select
                    className={field}
                    value={selected.values.endDays}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        values: {
                          ...selected.values,
                          endDays: Number(e.target.value),
                        },
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5, 6, 7].map((n) => (
                      <option key={n} value={n}>
                        {n}日後
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  終了時間（日本時間）
                  <select
                    className={field}
                    value={selected.values.endHour}
                    onChange={(e) =>
                      setSelected({
                        ...selected,
                        values: {
                          ...selected.values,
                          endHour: Number(e.target.value),
                        },
                      })
                    }
                  >
                    {Array.from({ length: 24 }, (_, n) => (
                      <option key={n} value={n}>
                        {n}時
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <label className="block text-sm">
              説明文の末尾に追加する定型文
              <textarea
                rows={3}
                className={field}
                maxLength={3000}
                value={selected.values.descriptionSuffix}
                onChange={(e) =>
                  setSelected({
                    ...selected,
                    values: {
                      ...selected.values,
                      descriptionSuffix: e.target.value,
                    },
                  })
                }
              />
            </label>
            {channel !== "BASE" && (
              <details className="rounded border p-3 text-sm" key={selected.id}>
                <summary>カテゴリの初期設定（任意）</summary>
                <p className="my-2">
                  {selected.values.categoryName || "指定なし・商品ごとに選択"}
                </p>
                {channel === "MERCARI_SHOPS" ? (
                  <MercariFurnitureCategoryPicker
                    inventoryId={selected.id}
                    busy={busy || !isAdmin}
                    currentFullPath={selected.values.categoryName || undefined}
                    onConfirm={(id, path) =>
                      setSelected({
                        ...selected,
                        values: {
                          ...selected.values,
                          categoryId: id,
                          categoryName: path,
                        },
                      })
                    }
                  />
                ) : (
                  <>
                    <label>
                      カテゴリ名
                      <input
                        className={field}
                        value={categoryQuery}
                        onChange={(e) => setCategoryQuery(e.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || !categoryQuery.trim()}
                      className="mt-2 rounded border px-3 py-2"
                      onClick={async () => {
                        setBusy(true);
                        try {
                          const r =
                            await searchYahooCategoriesAction(categoryQuery);
                          if (r.ok) setCategories(r.value);
                          else
                            setMessage(
                              "カテゴリを取得できませんでした。ヤフオクの接続を確認してください。",
                            );
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      検索
                    </button>
                    {categories.map((c) => (
                      <button
                        type="button"
                        key={c.id}
                        className="mt-1 block w-full rounded border p-2 text-left"
                        onClick={() =>
                          setSelected({
                            ...selected,
                            values: {
                              ...selected.values,
                              categoryId: c.id,
                              categoryName: c.path,
                            },
                          })
                        }
                      >
                        {c.path}
                      </button>
                    ))}
                  </>
                )}
                {selected.values.categoryId && (
                  <button
                    type="button"
                    className="mt-2 text-blue-700"
                    onClick={() =>
                      setSelected({
                        ...selected,
                        values: {
                          ...selected.values,
                          categoryId: "",
                          categoryName: "",
                        },
                      })
                    }
                  >
                    指定を解除
                  </button>
                )}
              </details>
            )}
            {isAdmin && (
              <div className="flex flex-wrap gap-2">
                <button
                  className="rounded bg-blue-700 px-4 py-2 text-sm text-white"
                  onClick={() => void save()}
                >
                  保存
                </button>
                <button
                  className="rounded border px-4 py-2 text-sm"
                  onClick={() =>
                    setSelected({
                      ...selected,
                      id: crypto.randomUUID(),
                      name: `${selected.name.slice(0, 25)} コピー`,
                      revision: 0,
                    })
                  }
                >
                  複製
                </button>
                <button
                  className="rounded border px-4 py-2 text-sm text-red-700"
                  onClick={() => {
                    if (
                      window.confirm(
                        `「${selected.name}」の設定を削除しますか？`,
                      )
                    )
                      void save(true);
                  }}
                >
                  削除
                </button>
              </div>
            )}
          </fieldset>
        ) : (
          <p className="py-3 text-sm text-gray-500">設定を選択してください。</p>
        )}
      </div>
      {message && (
        <p role="status" className="mt-4 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
