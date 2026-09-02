"use client";

import { formatJstDateTime } from "@/lib/inventory/formatJst";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  syncOneZaicoInventoryAction,
  syncLimitedZaicoInventoriesAction,
  previewZaicoCatalogSizeAction,
  startZaicoBackgroundSyncAction,
  advanceZaicoBackgroundSyncAction,
  cancelZaicoBackgroundSyncAction,
  getZaicoBackgroundSyncStatusAction,
} from "@/app/actions/zaicoSync";
import { deleteZaicoTokenAction, setZaicoTokenAction } from "@/app/actions/zaicoSecret";
import type { ZaicoSyncResult, ZaicoCatalogPreview } from "@/lib/inventory/zaicoSync";
import type { ZaicoBackgroundSyncJob } from "@/lib/inventory/zaicoBackgroundSync";
import type { ZaicoTokenSource } from "@/lib/zaico/client";

/**
 * ADMIN-only ZAICO→BELLO 手動同期パネル (spec §18/§27-29). Rendered only
 * for ADMIN by SettingsTabs (this component doesn't re-check the role
 * itself — the Server Actions it calls do that independently, so even a
 * stray render here could never actually perform a write). Never displays
 * the ZAICO API token — nothing here ever receives it in the first place,
 * see lib/zaico/client.ts.
 *
 * Phase 1 (spec's own required order): only the single-item sync (by
 * ZAICO ID) is meant to be exercised until it's fully verified — the
 * "全件同期" section is present per spec §11/§18 but stays a plainly
 * separate, explicitly-labeled action so it's never triggered by
 * accident while testing the single-item path.
 *
 * "全件同期" (BELLO統合改修 master指示書 2026-08-29統合改修版 §6.5):
 * 見た目上はボタン1つだが、内部的には常にlib/inventory/zaicoBackgroundSync.ts
 * のチェックポイント付きジョブを使う。1リクエストで全件を処理する旧経路
 * (syncAllZaicoInventoriesAction)は、大量データでWebリクエストのタイム
 * アウトに引っかかるリスクがあり、UIからもServer Action自体からも削除
 * 済み — ユーザーには常に安全な経路だけを見せる。
 *
 * TOKEN設定UI(夜間開発指示書 §14): password type入力 → Server Action
 * (app/actions/zaicoSecret.ts) → AWS Secrets Manager、という経路のみ。
 * このコンポーネントの state にTOKEN文字列を保持するのは送信するその
 * 一瞬だけで、Server Actionの戻り値には成功/失敗とメッセージしか含ま
 * れない(TOKEN本体は二度とブラウザへ返ってこない) — 保存/削除に成功
 * したら入力欄も即座にクリアする。
 */
export function ZaicoSyncPanel({ zaicoConnected, zaicoTokenSource }: { zaicoConnected: boolean; zaicoTokenSource: ZaicoTokenSource }) {
  const router = useRouter();
  const [zaicoId, setZaicoId] = useState("");
  const [busy, setBusy] = useState<"idle" | "one" | "limited" | "preview">("idle");
  const [result, setResult] = useState<ZaicoSyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // AWSテスト環境構築指示 §8/§26: Phase A(5〜10件)向けの少数件テスト
  // 同期 — 既定値5、上限50(サーバー側app/actions/zaicoSync.tsでも
  // クランプ済み、ここは誤入力を防ぐUI側の一次防御)。
  const [testLimit, setTestLimit] = useState("5");
  const [preview, setPreview] = useState<ZaicoCatalogPreview | null>(null);

  // BELLO統合改修 master指示書 Phase A: ZAICO background full sync。
  // 1リクエストで全件を処理せず(Webリクエストのタイムアウトに引っかか
  // るため)、lib/inventory/zaicoBackgroundSync.tsのチェックポイント付き
  // ジョブを、この画面を開いている間だけクライアント側からポーリングで
  // 少しずつ進める。ページ遷移/リロードしても進行状況はDynamoDB側の
  // ZaicoSyncJobレコードに保存されており、次にこの画面を開いたときに
  // マウント時のuseEffectが自動的に再開する(実行中ジョブがない場合は
  // 何もしない)。
  const [bgJob, setBgJob] = useState<ZaicoBackgroundSyncJob | null>(null);
  const [bgPolling, setBgPolling] = useState(false);
  const [bgBusy, setBgBusy] = useState<"idle" | "starting" | "cancelling">("idle");
  const [bgError, setBgError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmountedRef = useRef(false);

  const [tokenEditing, setTokenEditing] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenBusy, setTokenBusy] = useState(false);
  const [tokenMessage, setTokenMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function handleSaveToken() {
    if (!tokenInput.trim()) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      const res = await setZaicoTokenAction(tokenInput);
      setTokenMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) {
        setTokenInput("");
        setTokenEditing(false);
        router.refresh();
      }
    } catch (err) {
      setTokenMessage({ kind: "error", text: err instanceof Error ? err.message : "保存に失敗しました。" });
    } finally {
      setTokenBusy(false);
    }
  }

  async function handleDeleteToken() {
    if (!window.confirm("ZAICO API TOKENを削除します。削除するとZAICO同期が使用できなくなります。よろしいですか？")) return;
    setTokenBusy(true);
    setTokenMessage(null);
    try {
      const res = await deleteZaicoTokenAction();
      setTokenMessage({ kind: res.success ? "success" : "error", text: res.message });
      if (res.success) router.refresh();
    } catch (err) {
      setTokenMessage({ kind: "error", text: err instanceof Error ? err.message : "削除に失敗しました。" });
    } finally {
      setTokenBusy(false);
    }
  }

  async function runOne() {
    const trimmed = zaicoId.trim();
    if (!trimmed) {
      setError("ZAICO在庫ID（例: 73638418）を入力してください。");
      return;
    }
    setError(null);
    setResult(null);
    setBusy("one");
    try {
      setResult(await syncOneZaicoInventoryAction(trimmed));
    } catch (err) {
      setError(err instanceof Error ? err.message : "同期に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  async function runLimited() {
    const n = Number(testLimit);
    if (!Number.isFinite(n) || n < 1) {
      setError("同期する件数(1〜50)を正しく入力してください。");
      return;
    }
    setError(null);
    setResult(null);
    setBusy("limited");
    try {
      setResult(await syncLimitedZaicoInventoriesAction(n));
    } catch (err) {
      setError(err instanceof Error ? err.message : "同期に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  async function runPreview() {
    setError(null);
    setPreview(null);
    setBusy("preview");
    try {
      setPreview(await previewZaicoCatalogSizeAction());
    } catch (err) {
      setError(err instanceof Error ? err.message : "件数の確認に失敗しました。");
    } finally {
      setBusy("idle");
    }
  }

  // マウント時に、既に実行中(PENDING/RUNNING)のバックグラウンド同期
  // ジョブがないか確認する — 別タブ/前回セッションで開始したまま画面を
  // 閉じていた場合、ここで自動的にポーリングを再開する。
  useEffect(() => {
    unmountedRef.current = false;
    (async () => {
      try {
        const job = await getZaicoBackgroundSyncStatusAction();
        if (unmountedRef.current || !job) return;
        setBgJob(job);
        if (job.status === "PENDING" || job.status === "RUNNING") {
          setBgPolling(true);
          scheduleAdvance(0);
        }
      } catch {
        // 起動時の状態確認に失敗しても致命的ではない — 手動で「開始」す
        // れば通常どおり動作する。
      }
    })();
    return () => {
      unmountedRef.current = true;
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function scheduleAdvance(delayMs: number) {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => {
      void runAdvance();
    }, delayMs);
  }

  // setIntervalではなくsetTimeoutの再帰呼び出しにしているのは、1回の
  // advanceZaicoBackgroundSyncAction呼び出し(ZAICO 1ページ分、最大50件
  // の画像取込を含む)がintervalより長くかかった場合に、次の呼び出しが
  // 重複して発火するのを防ぐため(重複発火はロック機構で安全ではあるが、
  // 無駄な同時リクエストを避ける)。
  async function runAdvance() {
    try {
      const { job, shouldContinue } = await advanceZaicoBackgroundSyncAction();
      if (unmountedRef.current) return;
      setBgJob(job);
      setBgError(null);
      if (shouldContinue) {
        scheduleAdvance(300);
      } else {
        setBgPolling(false);
        router.refresh();
      }
    } catch (err) {
      if (unmountedRef.current) return;
      setBgPolling(false);
      setBgError(err instanceof Error ? err.message : "バックグラウンド同期の進行に失敗しました。");
    }
  }

  /**
   * 同期を開始する。
   *
   * 全件同期は誤操作の代償が大きい(5,000件超を処理する)ので、必ず
   * 確認を挟む。通常同期(差分)は日常操作なので確認しない —— 毎回
   * 確認を出すと読まずに押すようになり、本当に確認したい全件のほうが
   * 効かなくなる。
   */
  async function startBackground(mode: "DELTA" | "FULL" = "DELTA") {
    if (mode === "FULL") {
      const ok = window.confirm(
        "ZAICOの全件同期を実行します。処理に時間がかかる可能性があります。実行しますか？",
      );
      if (!ok) return;
    }
    setBgError(null);
    setBgBusy("starting");
    try {
      const res = await startZaicoBackgroundSyncAction(mode);
      if (!res.started) {
        setBgError(res.reason ?? "バックグラウンド同期を開始できませんでした。");
        return;
      }
      setBgPolling(true);
      scheduleAdvance(0);
    } catch (err) {
      setBgError(err instanceof Error ? err.message : "開始に失敗しました。");
    } finally {
      setBgBusy("idle");
    }
  }

  async function cancelBackground() {
    setBgBusy("cancelling");
    try {
      await cancelZaicoBackgroundSyncAction();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
      setBgPolling(false);
      setBgJob(await getZaicoBackgroundSyncStatusAction());
    } catch (err) {
      setBgError(err instanceof Error ? err.message : "中止に失敗しました。");
    } finally {
      setBgBusy("idle");
    }
  }

  return (
    <div className="max-w-2xl">
      <p className="mb-4 text-[12px] text-gray-500">
        ZAICOの在庫データをBELLOへ取り込みます（ZAICO → BELLOの一方向のみ。BELLOからZAICOへは一切書き込みません）。
      </p>

      {/* ZAICO API接続設定 — トークンの値は表示しない・伏字すら表示しない
          (「接続済み/未設定」の真偽値のみをpage.tsx側で判定し、ここへ渡
          している。lib/zaico/client.tsのisZaicoConnected参照)。設定/変
          更/削除はAWS Secrets Manager経由(app/actions/zaicoSecret.ts)
          — 値は一度もこのコンポーネントの外(Server Actionの戻り値)へ
          は出ない。 */}
      <div className="mb-3 border border-gray-200 p-4">
        <p className="mb-1 text-[12px] font-bold text-gray-700">ZAICO API接続設定</p>
        <p className="text-[13px]">
          {zaicoConnected ? (
            <span className="font-bold text-green-700">● 接続済み</span>
          ) : (
            <span className="font-bold text-red-600">● 未設定</span>
          )}
        </p>
        {/* AWSテスト環境構築指示: 「ZAICO_API_TOKEN env var fallbackが存在
            していても、成功条件はSecrets Manager経由で取得できること。
            fallbackだけで成功扱いしない」— この区別を、値を一切表示せず
            ADMINが画面上で確認できるようにする(lib/zaico/client.tsの
            getZaicoTokenSource参照)。 */}
        {zaicoTokenSource === "secrets-manager" && (
          <p className="mt-1 text-[11px] text-green-700">取得経路: AWS Secrets Manager(SSR Compute Role経由)</p>
        )}
        {zaicoTokenSource === "env-fallback" && (
          <p className="mt-1 text-[11px] text-amber-600">
            取得経路: サーバー環境変数フォールバック(ZAICO_API_TOKEN) — AWS Secrets Managerからは未取得です。SSR Compute
            Roleの設定を確認してください。
          </p>
        )}

        {!tokenEditing ? (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setTokenEditing(true);
                setTokenMessage(null);
              }}
              className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50"
            >
              {zaicoConnected ? "API TOKENを変更" : "ZAICO API TOKENを設定"}
            </button>
            {zaicoConnected && (
              <button
                type="button"
                onClick={handleDeleteToken}
                disabled={tokenBusy}
                className="border border-red-200 px-3 py-1 text-[12px] text-red-500 hover:bg-red-50 disabled:opacity-40"
              >
                ZAICO API設定を削除
              </button>
            )}
          </div>
        ) : (
          <div className="mt-2 border-t border-gray-100 pt-2">
            <label className="block text-[11px] text-gray-500">ZAICO API TOKEN</label>
            <div className="mt-0.5 flex gap-2">
              <input
                type="password"
                autoComplete="off"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                disabled={tokenBusy}
                placeholder="TOKENを貼り付け"
                className="w-72 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleSaveToken}
                disabled={tokenBusy || !tokenInput.trim()}
                className="bg-gray-900 px-3 py-1 text-[12px] font-bold text-white disabled:opacity-50"
              >
                {tokenBusy ? "確認中…" : "保存する"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setTokenEditing(false);
                  setTokenInput("");
                  setTokenMessage(null);
                }}
                disabled={tokenBusy}
                className="border border-gray-300 px-3 py-1 text-[12px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                キャンセル
              </button>
            </div>
            <p className="mt-1 text-[10px] text-gray-400">保存前にZAICO APIへ接続確認します。確認が取れたものだけが保存されます。</p>
          </div>
        )}

        {tokenMessage && (
          <p className={`mt-2 text-[12px] ${tokenMessage.kind === "success" ? "text-green-700" : "text-red-600"}`}>{tokenMessage.text}</p>
        )}

        {!zaicoConnected && !tokenEditing && (
          <p className="mt-1 text-[11px] text-gray-500">
            上のボタンから設定するか、サーバー環境変数 ZAICO_API_TOKEN で設定できます(ローカル開発では
            <code className="mx-1 bg-gray-100 px-1">.env.local</code>)。
          </p>
        )}
      </div>

      <div className="border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">1件同期（テスト用）</p>
        <div className="flex gap-2">
          <input
            value={zaicoId}
            onChange={(e) => setZaicoId(e.target.value)}
            placeholder="ZAICO在庫ID（例: 73638418）"
            disabled={busy !== "idle"}
            className="w-64 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={runOne}
            disabled={busy !== "idle"}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {busy === "one" ? "同期中…" : "同期する"}
          </button>
        </div>
      </div>

      {/* AWSテスト環境構築指示 §8/§26: いきなり全件同期しない安全なテスト
          モード。件数確認(同期しない)→少数件テスト同期、の順で試せる
          ようにする。「全件同期」ボタン自体は既存のまま残すが、
          テスト運用中はまずこちらを使うよう注意書きを添える。 */}
      <div className="mt-3 border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">少数件テスト同期（推奨）</p>
        <p className="mb-2 text-[11px] text-gray-500">
          まずZAICO側の件数を確認してから、少数件（既定5件、最大50件）だけを試すことを推奨します。再実行しても同じZAICO商品が重複作成されることはありません（ZAICOの在庫IDで既存レコードと照合します）。
        </p>
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={runPreview}
            disabled={busy !== "idle"}
            className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            {busy === "preview" ? "確認中…" : "ZAICOの件数を確認（同期しない）"}
          </button>
          {preview && (
            <span className="text-[12px] text-gray-600">
              少なくとも{preview.sampleCount}件{preview.hasMore ? "以上あります（1ページ目のみ確認）" : "（全件確認済み）"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-[12px] text-gray-600">
            同期件数:
            <input
              type="number"
              min={1}
              max={50}
              value={testLimit}
              onChange={(e) => setTestLimit(e.target.value)}
              disabled={busy !== "idle"}
              className="ml-1 w-16 border border-gray-300 px-2 py-1 text-[13px] focus:border-gray-500 focus:outline-none disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={runLimited}
            disabled={busy !== "idle"}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {busy === "limited" ? "同期中…" : "テスト同期する"}
          </button>
        </div>
      </div>

      {/* BELLO統合改修 master指示書(2026-08-29統合改修版) §6.5: 従来は
          「全件同期」(1リクエストで完結、大量データではWebリクエストの
          タイムアウトに引っかかる)と「バックグラウンド全件同期」(チェッ
          クポイント付き)の2系統が並存していたが、ユーザーからは常に安全
          な後者だけを使わせるべきで、UIも1つに統一する — というのが
          §6.5の明示的な指示。ボタンは1つだけ残し、内部的には常に
          lib/inventory/zaicoBackgroundSync.tsのチェックポイント付き
          ジョブを使う(旧runAll/syncAllZaicoInventoriesActionは、この
          変更でUI側の呼び出し元がなくなったためapp/actions/zaicoSync.ts
          からも削除した — 少数件テスト同期はsyncLimitedZaicoInventoriesAction
          経由で同じ内部関数を独立したlimit引数付きで呼んでいるため、
          この削除で少数件テスト同期が壊れることはない)。 */}
      <div className="mt-3 border border-gray-200 p-4">
        <p className="mb-2 text-[12px] font-bold text-gray-700">全件同期</p>
        <p className="mb-2 text-[11px] text-gray-500">
          ZAICOの全在庫を取得し、BELLOへ反映します。1リクエストで全件を処理せず、少しずつ（1回あたり最大50件）進行状況を保存しながら同期するため、件数が多くても安全です。開始後はAWS側のバックグラウンド処理（5分毎）が自動的に続きを進めるため、この画面を開いたままにする必要はなく、ブラウザを閉じてもPCの電源を落としても最後まで同期が完了します（この画面を開いている間は、進行状況をより早く確認したい場合の補助として1ページずつ手動で進めることもできます）。
        </p>
        <p className="mb-2 text-[11px] text-amber-700">
          ※AWS側のバックグラウンド処理はこのラウンドで新規実装（LOCAL_IMPLEMENTED）— 新規商品の作成についてはAWS環境での実同期・一覧画面での表示確認（AWS_VERIFIED）がまだ済んでいません。実AWS環境へのデプロイ後、少数件でのテスト同期による確認を推奨します。
        </p>

        <dl className="mb-3 grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
          <dt className="text-gray-500">最終同期日時</dt>
          <dd className="col-span-3">
            {bgJob?.finishedAt
              ? formatJstDateTime(bgJob.finishedAt)
              : bgJob?.status === "RUNNING" || bgJob?.status === "PENDING"
                ? `実行中…（開始: ${formatJstDateTime(bgJob.startedAt)}）`
                : "-（まだ実行していません）"}
          </dd>
          {bgJob && (
            <>
              <dt className="text-gray-500">状態</dt>
              <dd className="col-span-3">
                {
                  {
                    PENDING: "待機",
                    RUNNING: "実行中",
                    COMPLETED: bgJob.failed > 0 ? "一部失敗" : "完了",
                    FAILED: "失敗",
                    CANCELLED: "中止済み",
                  }[bgJob.status]
                }
              </dd>
              {/* この回が差分だったのか全件だったのかは、件数の読み方が
                  変わるので必ず出す。差分で「新規0・更新0」は正常だが、
                  全件で同じ数字なら異常。 */}
              <dt className="text-gray-500">種類</dt>
              <dd className="col-span-3">
                {bgJob.mode === "DELTA" ? "差分同期" : "全件同期"}
                {bgJob.mode === "DELTA" && (
                  <span className="ml-2 text-[11px] text-gray-500">
                    {bgJob.syncSince
                      ? `${new Date(bgJob.syncSince).toLocaleString("ja-JP")} 以降`
                      : "初回のため全件を対象"}
                  </span>
                )}
              </dd>
              <dt className="text-gray-500">進捗</dt>
              <dd className="col-span-3">
                {bgJob.totalProcessed.toLocaleString("ja-JP")}件（ページ{bgJob.lastPage}）
              </dd>
              <dt className="text-gray-500">新規</dt>
              <dd className="col-span-3">{bgJob.created}件</dd>
              <dt className="text-gray-500">更新</dt>
              <dd className="col-span-3">{bgJob.updated}件</dd>
              <dt className="text-gray-500">変更なし</dt>
              <dd className="col-span-3">{bgJob.unchanged}件</dd>
              {bgJob.skippedByDelta > 0 && (
                <>
                  <dt className="text-gray-500">差分スキップ</dt>
                  <dd className="col-span-3">
                    {bgJob.skippedByDelta.toLocaleString("ja-JP")}件
                    <span className="ml-2 text-[11px] text-gray-500">
                      前回以降ZAICO側で変更されていないため、処理を省きました
                    </span>
                  </dd>
                </>
              )}
              <dt className="text-gray-500">エラー</dt>
              <dd className="col-span-3">{bgJob.failed}件</dd>
            </>
          )}
        </dl>

        {bgJob && (bgJob.imageImported > 0 || bgJob.missingSourceIds.length > 0 || bgJob.lastError) && (
          <details className="mb-3 text-[12px] text-gray-700">
            <summary className="cursor-pointer text-gray-500">詳細</summary>
            <dl className="mt-2 grid grid-cols-4 gap-y-1">
              <dt className="text-gray-500">画像取込</dt>
              <dd className="col-span-3">{bgJob.imageImported}件</dd>
              {bgJob.status === "COMPLETED" && bgJob.missingSourceIds.length > 0 && (
                <>
                  <dt className="text-gray-500">ZAICO側で見つからなかった件数</dt>
                  <dd className="col-span-3 text-amber-700">
                    {bgJob.missingSourceIds.length}件（BELLO側には残しています。手動確認してください）
                  </dd>
                </>
              )}
              {/* 次回の差分がどこを基準にするか。ここが進んでいない＝
                  前回が最後まで通っていない、と読める。 */}
              <dt className="text-gray-500">最終同期成功</dt>
              <dd className="col-span-3">
                {bgJob.lastSuccessfulSyncAt
                  ? new Date(bgJob.lastSuccessfulSyncAt).toLocaleString("ja-JP")
                  : "まだ一度も完了していません（次回は全件が対象）"}
              </dd>
              {bgJob.lastError && (
                <>
                  <dt className="text-gray-500">最終エラー</dt>
                  <dd className="col-span-3 text-red-600">{bgJob.lastError}</dd>
                </>
              )}
            </dl>
          </details>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* 通常運用はこちら。前回の成功時刻以降に変わったものだけを処理する。 */}
          <button
            type="button"
            onClick={() => startBackground("DELTA")}
            disabled={bgPolling || bgBusy !== "idle"}
            className="bg-gray-900 px-3 py-1 text-[13px] font-bold text-white disabled:opacity-50"
          >
            {bgPolling ? "実行中…" : bgBusy === "starting" ? "開始中…" : "通常同期する（差分）"}
          </button>
          {/* 全件は管理者が明示的に選んだときだけ。見た目も控えめにして、
              こちらが既定ではないことが分かるようにする。 */}
          <button
            type="button"
            onClick={() => startBackground("FULL")}
            disabled={bgPolling || bgBusy !== "idle"}
            className="border border-gray-300 px-3 py-1 text-[12px] text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            全件同期する
          </button>
          {bgPolling && (
            <button
              type="button"
              onClick={cancelBackground}
              disabled={bgBusy === "cancelling"}
              className="border border-red-200 px-3 py-1 text-[12px] text-red-500 hover:bg-red-50 disabled:opacity-40"
            >
              {bgBusy === "cancelling" ? "中止中…" : "中止する"}
            </button>
          )}
        </div>

        {bgError && <p className="mt-2 text-[12px] text-red-600">{bgError}</p>}
      </div>

      {error && <p className="mt-3 text-[13px] text-red-600">{error}</p>}

      {result && (
        <div className="mt-4 border border-gray-200 p-4">
          <p className="mb-2 text-[12px] font-bold text-gray-700">同期結果</p>
          <dl className="grid grid-cols-4 gap-y-1 text-[12px] text-gray-700">
            <dt className="text-gray-500">対象件数</dt>
            <dd className="col-span-3">{result.total}</dd>
            <dt className="text-gray-500">新規作成</dt>
            <dd className="col-span-3">{result.created}</dd>
            <dt className="text-gray-500">更新</dt>
            <dd className="col-span-3">{result.updated}</dd>
            <dt className="text-gray-500">変更なし</dt>
            <dd className="col-span-3">{result.unchanged}</dd>
            <dt className="text-gray-500">エラー</dt>
            <dd className="col-span-3">{result.failed}</dd>
            <dt className="text-gray-500">画像取込</dt>
            <dd className="col-span-3">{result.imageImported}</dd>
            <dt className="text-gray-500">カテゴリ追加</dt>
            <dd className="col-span-3">{result.categoryCreated}</dd>
            <dt className="text-gray-500">保管場所追加</dt>
            <dd className="col-span-3">{result.locationCreated}</dd>
          </dl>

          {result.items.some((i) => i.warnings.length > 0 || i.status === "failed") && (
            <div className="mt-3 border-t border-gray-100 pt-3">
              <p className="mb-1 text-[11px] font-bold text-gray-500">エラー・警告のある項目</p>
              <ul className="space-y-1 text-[11px] text-gray-600">
                {result.items
                  .filter((i) => i.warnings.length > 0 || i.status === "failed")
                  .map((i) => (
                    <li key={i.zaicoId} className="border-l-2 border-gray-200 pl-2">
                      <span className="font-mono">{i.zaicoId}</span> {i.name}
                      {i.error && <span className="ml-1 text-red-600">— {i.error}</span>}
                      {i.warnings.map((w, idx) => (
                        <div key={idx} className="text-gray-500">
                          ・{w}
                        </div>
                      ))}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
