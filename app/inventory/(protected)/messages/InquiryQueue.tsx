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
  refreshInquiryPhoto,
  retryInquiryReadAction,
  sendInquiryDraftAction,
} from "@/app/actions/inquiryRuntime";
import { RESULT_LABELS } from "@/lib/inquiry/runtime/labels";
import { detectUnverifiedFulfillment } from "@/lib/inquiry/fulfillmentSafety";
import { InquiryPhoto } from "./InquiryPhoto";
import { copyInquiryText } from "@/lib/inquiry/copyText";
import { InventoryThumbnail } from "@/app/inventory/InventoryThumbnail";
type Queue = Awaited<ReturnType<typeof readInquiryQueue>>;
type Detail = Awaited<ReturnType<typeof readInquiryDetail>>;
export function InquiryQueue({ isAdmin,compact=false }: { isAdmin: boolean;compact?:boolean }) {
  const request = useRef(0);
  const [copied,setCopied]=useState('');
  async function copy(text:string,key:string){
    try{await copyInquiryText(text);setCopied(key);setError('');}
    catch{setError('コピーできませんでした。本文を長押ししてコピーしてください。');}
  }
  const queueRequest = useRef(0);
  const [loadingDetail, setLoadingDetail] = useState(false),
    [loadingMore, setLoadingMore] = useState(false),
    [messageCount, setMessageCount] = useState(30);
  const [queue, setQueue] = useState<Queue | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [draftText, setDraftText] = useState(""),
    [notice, setNotice] = useState("");
  const refresh = async () => {
    const generation = ++queueRequest.current;
    setError("");
    try {
      const value = await readInquiryQueue();
      if(generation === queueRequest.current) setQueue(value);
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
    setCopied('');
    setDetail(null);
    setLoadingDetail(true);
    setMessageCount(30);
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
    } finally {
      if (generation === request.current) setLoadingDetail(false);
    }
  }
  const selectedRow = queue?.items.find((r) => r.pk === selected);
  const displayMessages=detail?.remoteRead?.snapshot?.messages.map((m,index)=>({id:'remote-'+index,body:m.body,direction:m.speaker==='BUYER'?'INBOUND':'OUTBOUND',externalSentAt:m.sentAt,createdAt:m.sentAt}))??detail?.messages??[];
  return (
    <section className={compact?"rounded-2xl border bg-white p-3":"rounded-2xl border bg-white p-4 sm:p-6"}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">お問い合わせ</h2>
          <p className="mt-1 text-sm text-slate-600">
            {compact?'会話を確認して、返信案をコピーできます。':<>受信 → 商品・根拠の確認 → 返信案。{queue?.settings.automaticDelivery?'評価を通過した種類のみ自動送信します。':'顧客への自動送信は停止しています。'}</>}
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
        <div className={"max-h-[70vh] space-y-2 overflow-y-auto " + (selected ? "hidden lg:block" : "")}>
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
                  {new Date(item.messageAt ?? item.lastAt).toLocaleString("ja-JP", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </div>
              <p className="mt-2 line-clamp-2 break-words font-medium text-slate-900">{item.subject || item.customerName || (item.preview ? "お問い合わせ" : "本文を確認中")}</p>
              {item.preview && <p className="mt-1 line-clamp-2 break-words text-sm leading-relaxed text-slate-600">{item.preview}</p>}
              <p className="mt-2 text-xs text-teal-800">
                {item.mode === "STAFF"
                  ? "社員対応中"
                  : (RESULT_LABELS[item.result] ?? "確認待ち")}
              </p>
            </button>
          ))}
          {queue?.cursor && <button disabled={loadingMore} className="min-h-12 w-full rounded-xl border bg-white p-3" onClick={async()=>{
            const generation=queueRequest.current;
            setLoadingMore(true);
            try {
              const page=await readInquiryQueue(queue.cursor!);
              if(generation===queueRequest.current) setQueue(previous=>previous?{...page,items:[...previous.items,...page.items.filter(item=>!previous.items.some(p=>p.pk===item.pk))]}:page);
            } catch { setError("続きを取得できませんでした。もう一度お試しください。"); }
            finally { setLoadingMore(false); }
          }}>{loadingMore ? "読み込み中…" : "以前の問い合わせを表示"}</button>}
        </div>
        <div className={"min-w-0 rounded-xl bg-slate-50 p-4 " + (!selected ? "hidden lg:block" : "")}>
          {selected && <button className="mb-4 min-h-11 rounded-lg border bg-white px-4 lg:hidden" onClick={()=>{request.current++;setSelected(null);setDetail(null);setLoadingDetail(false);}}>← 問い合わせ一覧に戻る</button>}
          {!selected ? (
            <p className="text-slate-600">
              問い合わせを選択すると、本文・写真・商品候補・返信案を確認できます。
            </p>
          ) : loadingDetail ? (
            <p role="status">問い合わせを読み込んでいます…</p>
          ) : !detail ? (
            <div>
              <p>{error ? "会話の読み込みが完了していません。もう一度読み込めます。" : "受信を保存しました。解析結果は処理後に表示されます。"}</p>
              <button className="mt-3 min-h-11 rounded-lg border bg-white px-4" onClick={()=>void open(selected)}>問い合わせを再読み込み</button>
            </div>
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
              {detail.remoteRead&&<div className="mb-3 rounded-lg border bg-white p-3 text-sm">
                <p>{detail.remoteRead.status==='DONE'?'メルカリの問い合わせ画面から全文を取得済み':detail.remoteRead.status==='READING'?'問い合わせ画面を確認しています':'問い合わせ画面の取得待ちです。確認用ブラウザが接続されると再開します。'}</p>
                {isAdmin&&detail.remoteRead.status==='BLOCKED'&&<button disabled={busy} className="mt-2 min-h-11 rounded-lg border px-3" onClick={async()=>{setBusy(true);try{await retryInquiryReadAction(selected);await open(selected);setNotice('問い合わせ画面の取得を再開します。');}catch{setError('取得を再開できませんでした。接続状態を確認してください。');}finally{setBusy(false);}}}>本文の取得を再試行</button>}
              </div>}
              <div className="max-h-[45vh] space-y-3 overflow-y-auto">
                {displayMessages.length > messageCount && <button className="min-h-12 w-full rounded-lg border bg-white p-3" onClick={()=>setMessageCount(n=>n+30)}>以前のメッセージを表示</button>}
                {displayMessages.slice(-messageCount).map((m) => (
                  <article
                    key={m.id}
                    className={
                      "rounded-xl border p-3 " +
                      (m.direction === "INBOUND" ? "bg-white" : "bg-teal-50")
                    }
                  >
                    <small>
                      {m.direction === "INBOUND" ? "お客様" : "社員"} ·{" "}
                      {new Date(m.externalSentAt ?? m.createdAt).toLocaleString("ja-JP")}
                    </small>
                    <p className="mt-1 whitespace-pre-wrap break-words">
                      {m.body}
                    </p>
                    <button type="button" className="mt-2 min-h-11 rounded-lg border px-3 text-sm text-teal-900"
                      onClick={()=>void copy(m.body,m.id)}>{copied===m.id?'コピーしました':'本文をコピー'}</button>
                    {detail.attachments.find((a) => a.id === m.id) && (
                      <InquiryPhoto
                        url={detail.attachments.find((a) => a.id === m.id)!.url}
                        urls={detail.attachments.map((a) => a.url)}
                        refreshUrl={index=>refreshInquiryPhoto(selected, detail.attachments[index].id)}
                      />
                    )}
                  </article>
                ))}
              </div>
              <h3 className="mb-2 mt-5 font-bold">返信案</h3>
              {detail.delivery&&<p role="status" className="mb-3 rounded-lg border bg-white p-3 text-sm">{({QUEUED:'送信前の最終確認を待っています。',SENDING:'送信結果を確認しています。',ACCEPTED:'サービス側で送信を受け付けました。既読・到達を保証する表示ではありません。',UNKNOWN:'送信結果を確認できません。二重送信を防ぐため、公式画面で履歴を確認してください。',CANCELLED:'情報が更新されたため、送信を取りやめました。最新の返信案を確認してください。',REJECTED:'サービス側で送信が受け付けられませんでした。接続状態を確認してください。'} as Record<string,string>)[detail.delivery.status]??'送信状態を確認してください。'}</p>}
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
                      className="mt-2 min-h-48 w-full rounded-lg border p-3 text-base leading-7"
                      value={draftText}
                      onChange={(e) => {setDraftText(e.target.value);setCopied('');}}
                    />
                    {detectUnverifiedFulfillment(draftText).length > 0 && (
                      <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
                        配送日時や手配を約束する表現があります。この画面では手配の完了を確認できません。配送会社・担当者へ確認し、未確定の場合は返信案を修正してください。
                      </p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {isAdmin&&queue?.settings.deliveryEnabled&&<button disabled={busy||draftText!==d.draftText||!!detail.delivery&&['QUEUED','SENDING','ACCEPTED','UNKNOWN'].includes(detail.delivery.status)} className="min-h-11 rounded-lg bg-teal-800 px-4 text-white disabled:opacity-50" onClick={async()=>{if(!window.confirm('表示中の会話・商品・返信内容を確認しましたか？このお客様に返信を送信します。'))return;setBusy(true);try{await sendInquiryDraftAction(selected,d.id,d.updatedAt);await open(selected);setNotice('送信前の最終確認を受け付けました。結果は再読み込みで確認できます。');}catch{setError('送信を予約できませんでした。最新の会話・返信案と接続を確認してください。');}finally{setBusy(false);}}}>内容を確認して送信</button>}
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
                        className="min-h-11 rounded-lg border px-4 py-2"
                        disabled={!draftText.trim()}
                        onClick={()=>void copy(draftText,'draft')}
                      >
                        {copied==='draft'?'コピーしました':compact?'返信案をコピー':'コピー'}
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
                        {d.evidence?.replyHistory && <section className="rounded-lg bg-slate-50 p-3">
                          <h4 className="font-semibold">参考にした過去の返信</h4>
                          <p className="mt-1 text-xs text-slate-500">別のお客様への実際の返信から選択。過去の金額・寸法・個人情報は引き継ぎません。</p>
                          {d.evidence.replyHistory.status === 'UNAVAILABLE' && <p className="mt-2 text-amber-800">履歴を読み込めませんでした。今回の返信案には履歴を使用していません。</p>}
                          {d.evidence.replyHistory.status === 'EMPTY' && <p className="mt-2 text-slate-600">今回の相談に合う取得済みの履歴はありません。</p>}
                          {d.evidence.replyHistory.examples.map(example=><details key={example.id} className="mt-2 rounded border bg-white p-3">
                            <summary>{example.question} · {example.channel === 'MERCARI_SHOPS' ? 'メルカリShops' : example.channel} · {example.sentAt.slice(0,10)}</summary>
                            <p className="mt-2 whitespace-pre-wrap text-slate-600">{example.reply}</p>
                            {example.sourceUrl && <a className="mt-2 inline-block text-teal-800 underline" href={example.sourceUrl} target="_blank" rel="noreferrer">元のやり取りを開く</a>}
                          </details>)}
                        </section>}
                        <p>
                          {d.evidence?.product?.name ?? "在庫個体は未確定です"}
                        </p>
                        {d.evidence?.productCandidates.map((p) => (
                          <div
                            key={p.inventoryId}
                            className="rounded-lg border p-3"
                          >
                            <div className="mb-2 flex items-center gap-3">
                              <InventoryThumbnail storageKey={detail.products.find(item=>item.id===p.inventoryId)?.storageKey??null} alt={p.name} size="list" />
                              <p className="text-slate-600">{detail.products.find(item=>item.id===p.inventoryId)?.sku ?? ""} · 在庫 {detail.products.find(item=>item.id===p.inventoryId)?.quantity ?? "未確認"}</p>
                            </div>
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
