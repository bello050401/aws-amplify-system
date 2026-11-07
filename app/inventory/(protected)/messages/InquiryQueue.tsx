"use client";
import { useEffect, useRef, useState } from "react";
import {
  readInquiryQueue,
  readInquiryDetail,
  setInquiryMode,
  pollInquiryMailAction,
  editInquiryDraft,
  chooseInquiryProduct,
  setInquiryProcessing,
} from "@/app/actions/inquiryRuntime";
import { RESULT_LABELS } from "@/lib/inquiry/runtime/labels";
import { InquiryPhoto } from "./InquiryPhoto";
type Queue = Awaited<ReturnType<typeof readInquiryQueue>>;
type Detail = Awaited<ReturnType<typeof readInquiryDetail>>;
export function InquiryQueue({ isAdmin }: { isAdmin: boolean }) {
  const request = useRef(0);
  const [queue, setQueue] = useState<Queue | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [draftText, setDraftText] = useState(""),
    [notice, setNotice] = useState("");
  const refresh = async () => {
    setError("");
    try {
      setQueue(await readInquiryQueue());
    } catch {
      setError("受信状況を取得できませんでした。再読み込みしてください。");
    }
  };
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, []);
  async function open(pk: string) {
    const generation = ++request.current;
    setSelected(pk);
    setDetail(null);
    setError("");
    try {
      const value = await readInquiryDetail(pk);
      if (generation !== request.current) return;
      setDetail(value);
      setDraftText(
        value?.drafts.find((d) => d.status !== "DISMISSED")?.draftText ?? "",
      );
      setNotice("");
    } catch {
      if (generation === request.current)
        setError("問い合わせを取得できませんでした。");
    }
  }
  const selectedRow = queue?.items.find((r) => r.pk === selected);
  return (
    <section className="rounded-2xl border bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">お問い合わせ</h2>
          <p className="mt-1 text-sm text-slate-600">
            受信 → 商品・根拠の確認 → 返信案。顧客への自動送信は停止しています。
          </p>
        </div>
        <div className="flex gap-2">
          {isAdmin && queue && (
            <button
              disabled={busy}
              className="rounded-lg border px-4 py-2"
              onClick={async () => {
                setBusy(true);
                try {
                  await setInquiryProcessing(!queue.settings.enabled);
                  await refresh();
                } catch {
                  setError(
                    "処理設定を変更できませんでした。再読み込みしてください。",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {queue.settings.enabled
                ? "返信案の自動作成を停止"
                : "返信案の自動作成を開始"}
            </button>
          )}
          {isAdmin && (
            <button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await pollInquiryMailAction();
                  setNotice(
                    "メールの取得を受け付けました。しばらくしてから再読み込みしてください。",
                  );
                  await refresh();
                } catch {
                  setError(
                    "メール取得に失敗しました。接続状態を確認してください。",
                  );
                } finally {
                  setBusy(false);
                }
              }}
              className="rounded-lg border px-4 py-2"
            >
              メールを取得
            </button>
          )}
          <button
            onClick={() => void refresh()}
            className="rounded-lg border px-4 py-2"
          >
            再読み込み
          </button>
        </div>
      </div>
      {notice && (
        <p
          role="status"
          className="my-3 rounded-lg bg-teal-50 p-3 text-teal-900"
        >
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="my-3 rounded-lg bg-red-50 p-3 text-red-800">
          {error}
        </p>
      )}
      {queue && !queue.settings.enabled && (
        <p className="my-3 rounded-lg bg-amber-50 p-3">
          受信は保存し、解析開始を待っています。
        </p>
      )}
      <div className="mt-5 grid gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="max-h-[70vh] space-y-2 overflow-y-auto">
          {queue?.items.length === 0 && (
            <p className="p-4 text-slate-500">新しい問い合わせはありません。</p>
          )}
          {queue?.items.map((item) => (
            <button
              key={item.pk}
              onClick={() => void open(item.pk)}
              className={
                "w-full rounded-xl border p-3 text-left " +
                (selected === item.pk
                  ? "border-teal-700 bg-teal-50"
                  : "bg-white")
              }
            >
              <div className="flex items-center justify-between text-sm">
                <strong>
                  {item.channel === "LINE" ? "LINE" : "メルカリShops"}
                </strong>
                <time>
                  {new Date(item.lastAt).toLocaleString("ja-JP", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="mt-2 text-sm">
                {item.mode === "STAFF"
                  ? "社員対応中"
                  : (RESULT_LABELS[item.result] ?? "確認待ち")}
              </p>
            </button>
          ))}
        </div>
        <div className="min-w-0 rounded-xl bg-slate-50 p-4">
          {!selected ? (
            <p className="text-slate-600">
              問い合わせを選択すると、本文・写真・商品候補・返信案を確認できます。
            </p>
          ) : !detail ? (
            <p>受信を保存しました。解析結果は処理後に表示されます。</p>
          ) : (
            <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <h3 className="font-bold">
                  {detail.conversation.customerDisplayName ?? "お問い合わせ"}
                </h3>
                <button
                  disabled={busy}
                  className="rounded-lg border bg-white px-4 py-2"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await setInquiryMode(
                        selected,
                        selectedRow?.mode === "STAFF" ? "DRAFT" : "STAFF",
                      );
                      await refresh();
                    } catch {
                      setError("対応状態を変更できませんでした。");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {selectedRow?.mode === "STAFF"
                    ? "返信案作成を再開"
                    : "社員が対応する"}
                </button>
              </div>
              <div className="max-h-[45vh] space-y-3 overflow-y-auto">
                {detail.messages.slice(-30).map((m) => (
                  <article
                    key={m.id}
                    className={
                      "rounded-xl border p-3 " +
                      (m.direction === "INBOUND" ? "bg-white" : "bg-teal-50")
                    }
                  >
                    <small>
                      {m.direction === "INBOUND" ? "お客様" : "社員"} ·{" "}
                      {new Date(m.createdAt).toLocaleString("ja-JP")}
                    </small>
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      {m.body}
                    </p>
                    {detail.attachments.find((a) => a.id === m.id) && (
                      <InquiryPhoto
                        url={detail.attachments.find((a) => a.id === m.id)!.url}
                        urls={detail.attachments.map((a) => a.url)}
                      />
                    )}
                  </article>
                ))}
              </div>
              <h3 className="mb-2 mt-5 font-bold">返信案</h3>
              {detail.drafts
                .filter((d) => d.status !== "DISMISSED")
                .slice(0, 1)
                .map((d) => (
                  <article
                    key={d.id}
                    className="rounded-xl border bg-white p-4"
                  >
                    <label
                      className="block text-sm font-semibold"
                      htmlFor="reply-draft"
                    >
                      返信案を確認・編集
                    </label>
                    <textarea
                      id="reply-draft"
                      className="mt-2 min-h-48 w-full rounded-lg border p-3 leading-7"
                      value={draftText}
                      onChange={(e) => setDraftText(e.target.value)}
                    />
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        disabled={busy || !draftText.trim()}
                        className="rounded-lg bg-teal-800 px-4 py-2 text-white disabled:opacity-50"
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await editInquiryDraft(
                              selected,
                              d.id,
                              d.updatedAt,
                              draftText,
                            );
                            await open(selected);
                            await refresh();
                            setNotice(
                              "編集した返信案を保存しました。社員対応に切り替えました。",
                            );
                          } catch {
                            setError(
                              "保存できませんでした。追加の問い合わせが来ていないか再読み込みして確認してください。",
                            );
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        編集を保存
                      </button>
                      <button
                        className="rounded-lg border px-4 py-2"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(draftText);
                            setNotice("返信案をコピーしました。");
                          } catch {
                            setError(
                              "コピーできませんでした。本文を選択してコピーしてください。",
                            );
                          }
                        }}
                      >
                        コピー
                      </button>
                      <button
                        disabled={busy}
                        className="rounded-lg border px-4 py-2"
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await setInquiryMode(selected, "DRAFT");
                            await refresh();
                            setDetail(null);
                            setNotice(
                              "最新の問い合わせから返信案を作り直します。",
                            );
                          } catch {
                            setError("再作成を開始できませんでした。");
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        作り直す
                      </button>
                    </div>
                    {d.unresolvedFacts.length > 0 && (
                      <div className="mt-3 rounded-lg bg-amber-50 p-3 text-sm">
                        <b>確認が必要な内容</b>
                        <ul className="mt-2 space-y-2">
                          {d.unresolvedFacts.map((f, i) => (
                            <li key={i}>
                              <strong>{f.field}</strong>
                              <p>{f.reason}</p>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <details className="mt-3 text-sm">
                      <summary>商品・回答の根拠を確認</summary>
                      <div className="mt-3 space-y-3">
                        <p>
                          {d.evidence?.product?.name ?? "在庫個体は未確定です"}
                        </p>
                        {d.evidence?.productCandidates.map((p) => (
                          <div
                            key={p.inventoryId}
                            className="rounded-lg border p-3"
                          >
                            <a
                              className="font-medium text-teal-800 underline"
                              href={"/inventory/" + p.inventoryId}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {p.name}
                            </a>
                            <p className="mt-1 text-slate-600">
                              {p.reasons.join(" / ")}
                            </p>
                            <button
                              disabled={busy}
                              className="mt-2 rounded border px-3 py-2"
                              onClick={async () => {
                                if (
                                  !window.confirm(
                                    "この商品で返信案を作り直しますか？",
                                  )
                                )
                                  return;
                                setBusy(true);
                                try {
                                  await chooseInquiryProduct(
                                    selected,
                                    p.inventoryId,
                                    detail.version,
                                  );
                                  await refresh();
                                  setDetail(null);
                                  setNotice(
                                    "選択した商品で返信案を作り直します。",
                                  );
                                } catch {
                                  setError(
                                    "商品を確定できませんでした。最新の候補を確認してください。",
                                  );
                                } finally {
                                  setBusy(false);
                                }
                              }}
                            >
                              この商品を選ぶ
                            </button>
                          </div>
                        ))}
                        {d.evidence?.externalFacts.map((f, i) => (
                          <p key={i}>
                            <b>{f.field}</b> {f.value ?? "確認待ち"}
                            {f.sourceUrl && (
                              <a
                                className="ml-2 text-teal-700 underline"
                                href={f.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                              >
                                根拠を開く
                              </a>
                            )}
                          </p>
                        ))}
                      </div>
                    </details>
                  </article>
                ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
