"use client";

import { useEffect, useRef, useState } from "react";
import { listImageProcessingVersionsBatchAction, listPendingImageProcessingJobStatusesAction, reprocessAllImagesAction, reprocessImageAction, adoptImageVersionAction,
  rollbackImageVersionAction, type ImageProcessingVersionSummary } from "@/app/actions/imageProcessing";
import { BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES } from "@/lib/imageProcessing/types";
import { useInventoryImageUrl } from "./useInventoryImageUrl";

/**
 * BELLO画像自動加工システム(2026-08-30指示書)§13: 「各サムネイルに
 * 『未加工』『加工待ち』『加工中』『加工済』『要確認』『再加工中』
 * 『失敗』をテキスト＋アイコン等で表示」「商品単位に『10/10加工完了』
 * 等を表示」の実装。InventoryImageGallery.tsx自体は変更しない
 * (既存のnormal/damage両対応・lightbox実装を触らずに済む、この
 * パネルは商品画像セクションの下に独立して表示する構成)。
 *
 * 「Profile再解析」「基準値の自動調整」は実装していない
 * (SubjectSegmentationProvider未実装のため、composition confidenceは
 * 常にnull——このパネルのSTATUS_LABELSでは「要確認」表示に現れる)。
 *
 * 【不具合修正・ZAICO同期重複根絶指示書(2026-08-30) §12での追加】
 * 以前はこのパネル自体は既に存在していたが、(1) 商品全体を1回で
 * 加工開始する明確なボタンが無く、画像1枚ごとの小さな「再加工」
 * テキストリンクしか無かった(「カテゴリを『出品待ち』に変更しないと
 * 何も起きない」という誤解の直接の原因——実際には未加工画像でも
 * 「再加工」を押せば処理は始まるが、ラベルが「再加工」のままで
 * 分かりにくかった)、(2) 加工前/加工後を実際の画像で見比べる手段が
 * 無かった(状態ラベルの文字だけ)。この2点を追加する——
 * 加工ロジック自体(enqueueProcessingJob/idempotencyKey)は一切変更
 * しない。
 */
const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  UNPROCESSED: { label: "未加工", className: "text-gray-400" },
  QUEUED: { label: "加工待ち", className: "text-gray-500" },
  PROCESSING: { label: "加工中…", className: "text-blue-600" },
  READY: { label: "加工済", className: "text-emerald-700" },
  NEEDS_REVIEW: { label: "要確認", className: "text-amber-700" },
  FAILED: { label: "失敗", className: "text-red-600" },
  REPROCESSING: { label: "再加工中…", className: "text-blue-600" },
  DEAD_LETTER: { label: "失敗(リトライ上限)", className: "text-red-600" },
  // 【状態表示読取性能P3、2026-09-13夜——表示先行】スキーマ上のstatusでは
  // なく、このパネル内だけで作る一時的な擬似状態(サーバーへは一切送らない)。
  // currentStatus()参照——版取得(バッチ、速い)がpending確認(ProcessingJob
  // のScan、遅くなり得る)より先に終わったとき、versionが0件の画像は
  // 「未加工」と決め打たず、pendingが確認できるまでこの表示に留める。
  CHECKING: { label: "確認中…", className: "text-gray-400" },
};

/** 処理中・待機中は二重実行防止のため個別/一括ボタンとも無効化する。CHECKING(pending未確認)も同じ理由で無効化対象——未確認のまま「未加工」の書込操作を許すと、実際には予約済み/処理中の画像へ二重予約し得る。 */
const BUSY_STATUSES = new Set(["QUEUED", "PROCESSING", "REPROCESSING", "CHECKING"]);

/**
 * 【状態表示読取性能P2、2026-09-13】ProcessingJobの予約状況(pending)
 * 確認が必要な画像だけを選ぶ。currentStatus()がpendingJobを参照するのは
 * 「その画像にImageProcessingVersionが1件も無い」ときだけ(下の
 * currentStatus参照)——既にversionがある画像は、pendingJobの値に
 * 関わらず表示が変わらないため、対象から外してよい。
 *
 * ProcessingJobにはGSIが無く(意図的、jobService.tsのコメント参照)、
 * このAction自体はテーブル全体のScanのまま——ここでの絞り込みは
 * Scan1回のコスト自体を下げるものではなく、「対象が0件ならこのScanを
 * まるごと呼ばない」ことで、全画像が既に加工済みの商品を開くたび/
 * ポーリングのたびに発生していた無駄な呼び出しを消す。
 *
 * `versionsByKey`の値が`undefined`(まだ結果が無い=初回読込前)・
 * `null`(直前のバッチ取得が失敗した画像)のキーは、実際の版数が
 * 不明なので安全側(=対象に含める)へ倒す。
 */
export function selectPendingStatusLookupKeys(
  images: { storageKey: string }[],
  versionsByKey: Record<string, ImageProcessingVersionSummary[] | null | undefined>,
): string[] {
  return images.filter((img) => (versionsByKey[img.storageKey]?.length ?? 0) === 0).map((img) => img.storageKey);
}

/**
 * バッチ結果の値は本来`配列 | null`だが、Server Action境界がネットワーク
 * 層の異常(GET専用proxy等、下のisE2EFixtureStorageKey手前のコメント
 * 参照)で期待した形を返さなかった場合、そのキー自体が結果オブジェクトに
 * 欠けることがあり得る(`undefined`)。これを「バージョン0件(未加工)」の
 * 配列と取り違えると、状態不明の画像が誤って書込操作の対象になって
 * しまう——`null`(取得を試みて失敗)と`undefined`(欠損)を同列に
 * 「取得失敗」として扱う。`batch`自体がオブジェクトでない(想定外の
 * 戻り値)場合も同様に空扱いにして、直後の添字アクセスで例外にしない。
 *
 * listImageProcessingVersionsBatchActionの結果(画像ごとに成功=配列/
 * 失敗=null)を、画面用の状態へ合成する。失敗したキーは「取得失敗」
 * として別枠(failedKeys)へ分け、byKey自体は直前に分かっていた値
 * (previousByKey、無ければ空配列)を維持する——ボタンの活性/非活性や
 * アクション自体は直前の既知状態のまま動作させ、バッジ表示だけを
 * 「取得失敗」に切り替えるため(refreshのJSDoc参照)。refreshから切り
 * 出したのは、reprocessButtonLabel等と同じ理由 — React/ネットワーク
 * 無しでテストで固定できるようにするため。
 */
export function mergeVersionsBatchResult(
  imageStorageKeys: string[],
  batch: Record<string, ImageProcessingVersionSummary[] | null | undefined>,
  previousByKey: Record<string, ImageProcessingVersionSummary[]> | null,
): { byKey: Record<string, ImageProcessingVersionSummary[]>; failedKeys: Set<string> } {
  const safeBatch = batch && typeof batch === "object" ? batch : {};
  const byKey: Record<string, ImageProcessingVersionSummary[]> = {};
  const failedKeys = new Set<string>();
  for (const key of imageStorageKeys) {
    const versions = safeBatch[key];
    if (Array.isArray(versions)) {
      byKey[key] = versions;
    } else {
      failedKeys.add(key);
      byKey[key] = previousByKey?.[key] ?? [];
    }
  }
  return { byKey, failedKeys };
}

/**
 * ProcessingJob予約状況の取得(pending lookup)が失敗した場合、以前は
 * 無条件で`{}`へ戻していた——その結果、直前のpollingで分かっていた
 * 「予約済み(PENDING/PROCESSING)」という情報が消え、その画像は(version
 * もまだ0件のため)UNPROCESSEDに見えてしまい、書込系ボタン(「加工する」)
 * がisBusy=falseで解禁されて二重予約を誘発し得た。取得を試みて実際に
 * 失敗した場合は、直前の既知状態をそのまま維持する
 * (mergeVersionsBatchResultと同じ方針)。
 *
 * 対象0件(lookupKeys.length===0、全画像が既にversionを持つ)の場合は
 * pendingJobsの値がどのkeyからも参照されないため、空へリセットして
 * 問題ない(直前に別画像分の値が残っていても表示には影響しない)。
 *
 * 対象があり取得に成功した場合は、lookupKeysに含まれる分だけを新しい
 * 結果で置き換える(予約が無くなった=完了して当然消える、を反映する)
 * ——lookupKeys以外のkeyは元々表示に使われないので触れる必要がない。
 */
export function mergePendingJobsResult(
  lookupKeys: string[],
  result: Record<string, "PENDING" | "PROCESSING"> | null,
  previousPendingJobs: Record<string, "PENDING" | "PROCESSING">,
): { pendingJobs: Record<string, "PENDING" | "PROCESSING">; unavailable: boolean } {
  if (lookupKeys.length === 0) return { pendingJobs: {}, unavailable: false };
  if (result === null) return { pendingJobs: previousPendingJobs, unavailable: true };
  const pendingJobs = { ...previousPendingJobs };
  for (const key of lookupKeys) delete pendingJobs[key];
  for (const [key, status] of Object.entries(result)) pendingJobs[key] = status;
  return { pendingJobs, unavailable: false };
}

export interface RefreshOutcome {
  byKey: Record<string, ImageProcessingVersionSummary[]>;
  failedKeys: Set<string>;
  pendingJobs: Record<string, "PENDING" | "PROCESSING">;
  pendingStatusUnavailable: boolean;
}

/**
 * refresh()のI/Oが終わった後、その結果を画面へ反映してよいかを判定
 * してから合成する。
 *
 * 【レビュー補正、2026-09-13——実React境界試験で確認した不具合】以前の
 * 実装は「呼んだ時点のimages(storageKeyの並びをJSON化したもの)」を
 * signatureとして比較しており、商品が切り替わっていないかは検出できた
 * が、**同じ商品に対して複数回呼ばれたrefresh()同士の新旧**は区別
 * できなかった——signatureは商品を切り替えない限り同じ値のままなので、
 * 手動で「状態を再取得」を連打した場合や、書込操作後のawait refresh()と
 * ポーリングのrefresh()が重なった場合、後から発火したが先に届いた
 * 新しい応答を、後から届いた古い(遅い)応答が上書きしてしまい得た
 * (単一のbyKey/pendingJobs stateを複数の非同期I/Oが競合して書き込む
 * 典型的なrace condition)。
 *
 * `requestId`はrefresh()を呼うたびに1ずつ増える単調増加のカウンタ
 * (呼び出し順そのもの)。`latestRequestId`はこの関数を呼ぶ時点
 * (=応答が返ってきた時点)での「最後に発行されたrequestId」。両者が
 * 一致しなければ、自分より後に発行された(=より新しい)refresh()が
 * 既に存在するということなので`null`を返し、呼び出し側は一切setState
 * しない——それがどんな理由(商品切替・手動連打・ポーリングとの重複)
 * であっても、常に「一番最後に発行したrequestの応答」だけを信頼する、
 * という1つのルールで両方のケースをまとめて正しく扱える。
 *
 * ロジック自体をrefresh()(非同期I/O)から切り出したのは、他のexport
 * 関数と同じ理由——実タイマー/実Server Action無しでテストするため。
 */
export function applyRefreshResult(
  requestId: number,
  latestRequestId: number,
  imageStorageKeys: string[],
  batch: Record<string, ImageProcessingVersionSummary[] | null | undefined>,
  previousByKey: Record<string, ImageProcessingVersionSummary[]> | null,
  pendingLookupKeys: string[],
  pendingFetch: Record<string, "PENDING" | "PROCESSING"> | null,
  previousPendingJobs: Record<string, "PENDING" | "PROCESSING">,
): RefreshOutcome | null {
  if (requestId !== latestRequestId) return null;
  const { byKey, failedKeys } = mergeVersionsBatchResult(imageStorageKeys, batch, previousByKey);
  const { pendingJobs, unavailable } = mergePendingJobsResult(pendingLookupKeys, pendingFetch, previousPendingJobs);
  return { byKey, failedKeys, pendingJobs, pendingStatusUnavailable: unavailable };
}

/**
 * バージョン取得(バッチ)が失敗した画像の表示。STATUS_LABELSの実際の
 * 状態(UNPROCESSED等)とは別軸——「versionが0件(=未加工)」と「取得
 * できなかった(=実際の状態は不明、直前に分かっていた表示を暫定的に
 * 維持しているだけ)」を混同しないための専用ラベル
 * (§13.2「エラーや取りこぼしを0件と混同しない」)。
 */
const FETCH_FAILED_META = { label: "取得失敗", className: "text-red-500" };

interface ImagePanelRow {
  storageKey: string;
  originalHash: string | null;
}

/**
 * pendingJob: ImageProcessingVersionがまだ無い間だけ意味を持つ、ProcessingJobの状態(listPendingImageProcessingJobStatusesAction由来)。
 *
 * 【状態表示読取性能P3、2026-09-13夜——表示先行】`pendingConfirmed`は
 * このrefresh()内でversion0件の画像に対するpending確認が実際に一度でも
 * 成功しているか。版取得(バッチ、GSI Query)はpending確認(ProcessingJob
 * のScan)より速く終わり得るため、その差の間だけ`versions.length===0`
 * の画像は「未加工」と決め打てない(実際は予約済み/処理中かもしれない)。
 * `pendingConfirmed=false`の間は専用の"CHECKING"を返し、確定した時点で
 * 初めてUNPROCESSED/QUEUED/PROCESSINGへ倒す——`docs/
 * image-status-read-perf-followup-20260913.md`参照。exportは
 * `scripts/verify-image-processing.ts`が純粋ロジックとして直接検証
 * できるようにするため(reprocessButtonLabel等と同じ理由)。
 */
export function currentStatus(versions: ImageProcessingVersionSummary[], pendingJob: "PENDING" | "PROCESSING" | undefined, pendingConfirmed: boolean): string {
  const active = versions.find((v) => v.active);
  if (active) return active.status;
  if (versions.length === 0) {
    if (!pendingConfirmed) return "CHECKING";
    // ImageProcessingVersionがまだ無い=workerがまだ拾っていない状態。
    // ProcessingJobが実際に予約されているなら、UNPROCESSEDのままにせず
    // 「予約済み/加工中」と分かる表示にする(2026-08-31フィードバック
    // 「加工するを押しても反応がない」対応——上のコメント参照)。
    if (pendingJob === "PROCESSING") return "PROCESSING";
    if (pendingJob === "PENDING") return "QUEUED";
    return "UNPROCESSED";
  }
  // ACTIVEが無い(処理中/失敗のみ)場合は最新versionの状態を見せる。
  return versions[versions.length - 1].status;
}

/** ボタンの文言を状態に応じて出し分ける — 「未加工の画像に『再加工』と書いてある」という分かりにくさの直接の対処。exportは`scripts/verify-image-processing.ts`が純粋ロジックとして直接検証できるようにするため。 */
export function reprocessButtonLabel(status: string): string {
  if (status === "UNPROCESSED") return "加工する";
  if (status === "FAILED" || status === "DEAD_LETTER") return "再試行";
  if (status === "READY" || status === "NEEDS_REVIEW") return "再加工";
  return "加工する";
}

/**
 * 「要確認」で止まっている加工結果のうち、採用候補として見せる1件を選ぶ。
 *
 * workerは`active: status === "READY"`でしかACTIVEにせず、被写体
 * セグメンテーションが未実装の間は判定が必ずNEEDS_REVIEWへ倒れる。
 * そのため、この関数が拾わないと**生成済みの加工結果を画面から一切
 * 見られない**(比較UIもACTIVEなversionを前提にしていた)。
 *
 * 複数溜まっている場合は最新(配列の末尾側)を採る。ロジックをJSXの中に
 * 埋めずここへ出してあるのは、reprocessButtonLabelと同じ理由 —
 * 実機ログインなしにテストで固定できるようにするため。
 */
export function pickPendingReviewVersion(
  versions: ImageProcessingVersionSummary[],
  status: string,
): ImageProcessingVersionSummary | null {
  if (status !== "NEEDS_REVIEW") return null;
  return [...versions].reverse().find((v) => v.status === "NEEDS_REVIEW") ?? null;
}

/** §12.5: 加工前/加工後を実際の画像で見比べる、原本を破壊しないside-by-side表示。トグルで開閉する(常時表示すると画像が多い商品で重くなるため)。 */
function BeforeAfterToggle({ originalKey, processedKey, label }: { originalKey: string; processedKey: string; label: string }) {
  const [open, setOpen] = useState(false);
  const { url: originalUrl } = useInventoryImageUrl(open ? originalKey : null);
  const { url: processedUrl } = useInventoryImageUrl(open ? processedKey : null);

  return (
    <div className="mt-1">
      <button type="button" onClick={() => setOpen((v) => !v)} className="text-gray-400 hover:text-gray-900">
        {open ? "閉じる" : "加工前/加工後を見る"}
      </button>
      {open && (
        <div className="mt-1 flex gap-2">
          <div>
            <p className="mb-0.5 text-[10px] text-gray-400">加工前（原本）</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- S3署名URL、InventoryThumbnail等と同じ理由 */}
            {originalUrl && <img src={originalUrl} alt={`${label} 加工前`} className="h-24 w-24 border border-gray-200 object-cover" />}
          </div>
          <div>
            <p className="mb-0.5 text-[10px] text-gray-400">加工後</p>
            {/* eslint-disable-next-line @next/next/no-img-element -- 同上 */}
            {processedUrl && <img src={processedUrl} alt={`${label} 加工後`} className="h-24 w-24 border border-gray-200 object-cover" />}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * 画像段階読込QA是正(2026-09-12、Codexブラウザ実描画エラー切分け) —
 * `lib/inventory/e2eFixtures.ts`が返す合成画像("e2e-fixture:"接頭辞、
 * app/inventory/useInventoryImageUrl.tsのコメント参照)はS3/DynamoDBに
 * 実体が無いため、本物のImageProcessingVersion/ProcessingJobは存在し
 * 得ない——このパネルの対象から除外する。
 *
 * 【実機で確認した根本原因】この除外が無いと、詳細画面(ADMIN/EDITOR)
 * を開くたびにrefresh()がこの合成キーで実Amplify Data(Server Action
 * 経由のAppSync)へ問い合わせに行っていた。通常のブラウザ直アクセスでは
 * この問い合わせ自体の失敗(未デプロイ/到達不可)がPromiseの通常の
 * rejectionとして返るため、下のrefresh().catch()がsetErrorで安全に
 * 吸収していた。ところがCodex CUAが使うGET専用proxy(POSTを405で拒否)
 * 経由だと、Next.jsのServer Action呼び出しがこの405応答を正常な
 * rejectionとして扱わず、listPendingImageProcessingJobStatusesAction
 * の戻り値が`undefined`のまま`setPendingJobs(undefined)`されてしまう
 * ことを実機(合成GET専用proxyとの比較)で確認した。次のrenderで
 * `pendingJobs[img.storageKey]`が`undefined`への添字アクセスとなり
 * `TypeError: Cannot read properties of undefined (reading '<key>')`が
 * render中に(catchで守られていない場所で)投げられ、
 * app/inventory/error.tsxの境界まで届いていた
 * (「画面の表示中に問題が発生しました」の直接原因)。
 * fixture画像をそもそも対象から外せば、この経路自体が発生しない。
 */
function isE2EFixtureStorageKey(storageKey: string): boolean {
  return storageKey.startsWith("e2e-fixture:");
}

export function ImageProcessingPanel({ inventoryId, images: allImages }: { inventoryId: string; images: ImagePanelRow[] }) {
  const images = allImages.filter((img) => !isE2EFixtureStorageKey(img.storageKey));
  const imagesSignature = JSON.stringify(images.map((i) => i.storageKey));
  const [byKey, setByKey] = useState<Record<string, ImageProcessingVersionSummary[]> | null>(null);
  const [pendingJobs, setPendingJobs] = useState<Record<string, "PENDING" | "PROCESSING">>({});
  // バージョン取得(バッチ)が失敗した画像のstorageKey。「versionが0件
  // (未加工)」と区別して表示するためのもの——byKey自体には直前に分かって
  // いた値(無ければ空配列)をそのまま残し、表示は継続する。
  const [failedKeys, setFailedKeys] = useState<Set<string>>(new Set());
  // ProcessingJob予約状況の取得が(呼んだのに)失敗したか。呼ぶ必要が
  // 無くてスキップした場合はfalseのまま——「取得しなかった」と
  // 「取得を試みて失敗した」を区別する。
  const [pendingStatusUnavailable, setPendingStatusUnavailable] = useState(false);
  // 【状態表示読取性能P3、2026-09-13夜】pending確認(ProcessingJobの
  // Scan)が実際に一度でも成功した画像のstorageKey。一度確認できた画像を
  // 再び「未確認」へ戻すことはない(monotonic、取得失敗時は追加しない
  // だけ——pendingJobs自体は失敗時に直前の既知状態を保つ既存の
  // mergePendingJobsResultに任せる)。currentStatus()のCHECKING判定に使う。
  const [pendingConfirmedKeys, setPendingConfirmedKeys] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // useInventoryImageUrl.tsと同じ「最新値をrefへ常時ミラーする」パターン。
  // 以前はrefresh()がimages/byKey/pendingJobsを直接クロージャで参照して
  // いたため、ポーリング用useEffectが[anyBusyGlobally]にしか依存して
  // いないことと合わさって、「商品を切り替えてもanyBusyGloballyの値が
  // 変わらなければ、古いeffectが古いrefresh(=古いimages/byKeyを閉じ
  // 込めたもの)を呼び続ける」という古いclosure問題が起きていた。refへ
  // 切り替えることで、interval自体を再生成しなくても常にその時点の
  // 最新値を読む。
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const byKeyRef = useRef(byKey);
  byKeyRef.current = byKey;
  const pendingJobsRef = useRef(pendingJobs);
  pendingJobsRef.current = pendingJobs;
  // 【レビュー補正、2026-09-13——実React境界試験で確認した不具合】
  // 「refresh()が呼ばれた回数」をそのまま単調増加のrequestIdとして使う。
  // 応答を反映してよいかどうかは、この時点(=応答が返ってきた時点)での
  // latestRequestIdRef.currentと、自分が発行された時点のrequestIdが
  // 一致するかどうかだけで判定する(applyRefreshResult参照)——
  // imagesの並びが変わったかどうか(商品切替)だけを見ていた以前の判定
  // では、同じ商品に対する複数回のrefresh()同士の新旧(手動連打・
  // 書込操作後のrefresh()とポーリングの重複等)を区別できなかった。
  const latestRequestIdRef = useRef(0);
  // 現在進行中のrefresh()の件数。0より大きい間は「何か進行中」——
  // 以前は単一のbooleanをtry/finallyで立て下げしていたため、複数の
  // refresh()が重なると、後から終わった側のfinallyが先に終わった側の
  // 「進行中」を消してしまい得た(このbooleanは複数呼び出しの状態を
  // 正しく表せない)。カウンタにすることで、何本重なっていても
  // 「全部終わるまでは進行中」を正しく表せる——ポーリング用
  // useEffect(下)がこれを見て、進行中は次のtickで新しい呼び出しを
  // 重ねて投げない、という判定にだけ使う(手動操作直後のawait
  // refresh()自体は常に実行させる——こちらは重複抑制の対象ではない)。
  const inFlightCountRef = useRef(0);

  /**
   * 【状態表示読取性能P3、2026-09-13夜——表示先行】以前はここで
   * `Promise.allSettled`により版取得(バッチ)とpending確認の両方の完了を
   * 待ってから、まとめて1回でsetStateしていた。版取得(GSI Query、
   * listVersionsForKeys)はpending確認(ProcessingJobのScan、テーブル
   * 全体走査、jobService.tsのコメント参照)より先に終わり得るのに、
   * 表示は遅い方(pending)に引きずられて止まっていた——
   * `docs/image-status-read-perf-followup-20260913.md`参照。
   *
   * 両方の呼び出し自体・呼び出し回数は変更しない(根拠なくpending確認を
   * 省略しない——`selectPendingStatusLookupKeys`による「対象0件なら
   * 呼ばない」判定はそのまま維持)。変えるのは反映のタイミングだけ:
   * 版取得が先に終われば先に画面へ出す。ただしversionが0件の画像の
   * 状態はpending確認の結果が要るため、確認が済むまでは
   * `pendingConfirmedKeys`が持たない=`currentStatus`がCHECKING(確認中)
   * を返し、書込操作は禁止し続ける(状態不明のまま「未加工」と誤判定
   * して二重予約させない)。
   */
  async function refresh() {
    const requestId = ++latestRequestIdRef.current;
    inFlightCountRef.current += 1;
    try {
      const requestImages = imagesRef.current;
      const keys = requestImages.map((img) => img.storageKey);
      // 直前の(このrefresh呼び出し開始時点での)byKeyを使う——新しい
      // バッチ結果を待ってから判定すると2呼び出しが直列化して待ち時間が
      // 伸びるため、両方を並行実行できるようにするための選択。初回読込
      // 時はbyKeyがまだnullなので、全画像を対象にする(既存の「初回は
      // 必ず両方引く」という安全側の挙動を保つ)。
      const pendingLookupKeys = selectPendingStatusLookupKeys(requestImages, byKeyRef.current ?? {});
      // Promise.allSettledではなく、両方を即時発行(並行実行は変わらない)
      // した上で個別にthen変換し、片方の完了をもう片方が待たないように
      // する。reject自体は起こさない(then(onFulfilled, onRejected)で
      // 常に解決済みの結果オブジェクトへ変換する)——下のawaitが例外で
      // 打ち切られて、まだ発行前のもう片方の呼び出しがunhandled
      // rejectionになる事態を避けるため。
      const batchPromise = listImageProcessingVersionsBatchAction(keys).then(
        (value) => ({ ok: true as const, value }),
        (reason) => ({ ok: false as const, reason }),
      );
      const pendingPromise =
        pendingLookupKeys.length > 0
          ? listPendingImageProcessingJobStatusesAction(pendingLookupKeys).then(
              (value) => ({ ok: true as const, value }),
              () => ({ ok: false as const, value: null as Record<string, "PENDING" | "PROCESSING"> | null }),
            )
          : Promise.resolve({ ok: true as const, value: {} as Record<string, "PENDING" | "PROCESSING"> });

      const batchResult = await batchPromise;
      // 待っている間に自分より新しいrefresh()が既に発行されていたら、
      // それはこの応答の出る幕ではないので黙って捨てる(その新しい
      // refresh()が自分の結果で反映し直す)。
      if (requestId !== latestRequestIdRef.current) return;
      if (!batchResult.ok) {
        // 個別キーの話ではなく全体が届かなかった(ネットワーク断・認可拒否等)。
        throw batchResult.reason;
      }
      const { byKey, failedKeys } = mergeVersionsBatchResult(keys, batchResult.value, byKeyRef.current);
      setByKey(byKey);
      setFailedKeys(failedKeys);
      // 取得に成功した(=もう「全体が読み込めませんでした」ではない)ので、
      // その旨のエラー表示は消す。個別画像の取得失敗はfailedKeys/
      // FETCH_FAILED_METAが別枠で表示するので、ここでは上書きしない。
      setError(null);

      // ここから先はpending確認の反映——版取得の表示を巻き込まない。
      const pendingOutcome = await pendingPromise;
      if (requestId !== latestRequestIdRef.current) return;
      // 防御的措置(上記isE2EFixtureStorageKey手前のコメント参照) — Server
      // Action呼び出しがネットワーク層の異常(GET専用proxy等)で期待した
      // 形の値を返さなかった場合でも、以後のrender(pendingJobs[key]と
      // いう添字アクセス)が「undefinedへの添字アクセスで例外」という
      // エラーバウンダリ行きの壊れ方をしないようにする——実際のジョブ
      // 状態を偽装するのではなく、「取得できなかった」をnullとして
      // mergePendingJobsResultへ渡すだけで、書き込み系には一切影響しない。
      const pendingValue =
        pendingLookupKeys.length === 0
          ? ({} as Record<string, "PENDING" | "PROCESSING">)
          : pendingOutcome.ok && pendingOutcome.value && typeof pendingOutcome.value === "object"
            ? pendingOutcome.value
            : null;
      const { pendingJobs, unavailable } = mergePendingJobsResult(pendingLookupKeys, pendingValue, pendingJobsRef.current);
      setPendingJobs(pendingJobs);
      setPendingStatusUnavailable(unavailable);
      if (pendingLookupKeys.length > 0 && !unavailable) {
        setPendingConfirmedKeys((prev) => {
          let changed = false;
          const next = new Set(prev);
          for (const key of pendingLookupKeys) {
            if (!next.has(key)) {
              next.add(key);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      }
    } finally {
      inFlightCountRef.current -= 1;
    }
  }

  useEffect(() => {
    if (images.length === 0) return;
    // 商品が切り替わった(imagesSignatureが変わった)瞬間、前の商品の
    // エラー表示だけは持ち越さない——「読み込み中…」に一旦戻し、直後の
    // refresh()が実際の結果で上書きする。byKey/failedKeys自体は
    // クリアしない(storageKeyが違うので新しい画像には元々効かない——
    // 上のrefresh()と同じ「安全側は対象外の値をそのまま残す」方針)。
    setError(null);
    refresh().catch((err) => setError(err instanceof Error ? err.message : "読み込みに失敗しました。"));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- imagesは親から毎レンダー新配列で渡り得るため、storageKeyの並びをJSON化した依存にする
  }, [imagesSignature]);

  const statusOf = (img: ImagePanelRow) => currentStatus(byKey?.[img.storageKey] ?? [], pendingJobs?.[img.storageKey], pendingConfirmedKeys.has(img.storageKey));
  const anyBusyGlobally = images.some((img) => BUSY_STATUSES.has(statusOf(img)));
  // 状態が不明(直前のバッチ取得に失敗)な画像、またはpending確認自体が
  // 失敗している間も、busy判定と同じ枠でポーリングを続ける——そうしない
  // と「取得失敗」の画像がBUSY_STATUSESに該当しない限り自動では二度と
  // 再取得されず、ユーザーは下の手動再試行ボタンか全体リロードしか
  // 復帰手段が無くなる。
  const shouldPoll = anyBusyGlobally || failedKeys.size > 0 || pendingStatusUnavailable;

  // 2026-08-31フィードバック対応: 予約中/処理中の画像が1件でもある間
  // だけ、手動リロード無しで進捗が見えるよう軽くポーリングする(常時
  // ポーリングはしない——完了した後は自動的に止まるので、ブラウザへの
  // 負荷は「何か処理中の間だけ」に限定される)。workerは5分毎起動なので、
  // 15秒間隔は十分軽い頻度。
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(() => {
      // 直前のrefresh()がまだ終わっていなければ(=15秒を超えて応答が
      // 遅れている)、ここでもう1本重ねて投げない——次のtickで再度
      // 確認する(inFlightCountRef参照)。
      if (inFlightCountRef.current > 0) return;
      refresh().catch(() => {
        /* ポーリング失敗は無視 — 次回interval or 手動操作で回復する */
      });
    }, 15_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshはrefで最新のimages/byKey/pendingJobsを読むため、shouldPollの変化だけをtriggerにすれば十分
  }, [shouldPoll]);

  if (images.length === 0) return null;

  // 読み込み前/失敗時にパネルごと消していた。setErrorは呼ばれるのに
  // その表示先がこの下のJSXの中にあるため、**エラーが誰にも見えない**
  // 状態になっていた(実際、セッション切れで版一覧の取得が失敗したとき、
  // 画面からは「加工パネルが最初から存在しない」ようにしか見えず、
  // 原因の切り分けに時間がかかった)。状態を必ず何か表示する。
  //
  // 【不具合修正、2026-09-13——実React境界試験で確認】この分岐に入って
  // いる間(初回のbyKey===null)は、下のJSX本体(再試行ボタン含む)が
  // 一切描画されないため、初回のバッチ取得がまるごと失敗すると
  // 「エラー文言が出るだけで、手動での再試行手段がどこにも無い」
  // (全体リロードしか復帰手段が無い)状態になっていた。ここにも
  // 再試行ボタンを置く——refresh()を呼ぶだけの読取専用操作で、
  // 書込系のenqueueProcessingJob等には一切触れない。
  if (byKey === null) {
    return (
      <div className="mt-2 text-[11px]">
        {error ? (
          <p className="text-red-600">
            画像加工の状態を読み込めませんでした: {error}{" "}
            <button
              type="button"
              onClick={() => refresh().catch((err) => setError(err instanceof Error ? err.message : "読み込みに失敗しました。"))}
              className="underline hover:text-red-900"
            >
              再試行
            </button>
          </p>
        ) : (
          <p className="text-gray-400">画像加工の状態を読み込み中…</p>
        )}
      </div>
    );
  }

  const readyCount = images.filter((img) => statusOf(img) === "READY").length;
  const needsReviewCount = images.filter((img) => statusOf(img) === "NEEDS_REVIEW").length;
  const failedCount = images.filter((img) => ["FAILED", "DEAD_LETTER"].includes(statusOf(img))).length;
  // 「状態なし(未加工)」と「取得できなかった」を見分けられるよう別枠で数える。
  const fetchFailedCount = images.filter((img) => failedKeys.has(img.storageKey)).length;
  // 版取得が先行表示された直後、pending確認がまだ済んでいない(版0件の)
  // 画像の件数——表示先行の可視化用(§image-status-read-perf-followup)。
  const checkingCount = images.filter((img) => statusOf(img) === "CHECKING").length;
  // 一括ボタンの対象: 未加工・失敗・要確認(まだ完了扱いではない)の画像のみ。
  // 既にREADYの画像を一括ボタンで巻き込むと「意図せず全部再加工」に
  // なってしまう(付録B「再加工で全画像を巻き込む処理」の禁止と同じ
  // 理由) — 個別の「再加工」ボタンはREADY画像も明示的に選べる。
  //
  // 状態が不明(直前のバッチ取得に失敗)な画像はここでも除外する——
  // failedKeysの画像はbyKeyに直前の既知値(無ければ空配列=UNPROCESSED
  // 扱い)が入ったままなので、除外しないと「実際の状態が分からない画像」
  // が「未加工」と同じ扱いで一括加工の対象に紛れ込み、既に処理中/
  // 完了済みの画像へ重複してジョブを積む可能性がある。
  const bulkTargets = images.filter((img) => !failedKeys.has(img.storageKey) && (BULK_IMAGE_PROCESSING_ELIGIBLE_STATUSES as readonly string[]).includes(statusOf(img)));

  async function handleBulkProcess() {
    setBulkBusy(true);
    setError(null);
    try {
      const result = await reprocessAllImagesAction(
        inventoryId,
        bulkTargets.map((img) => ({ storageKey: img.storageKey, originalHash: img.originalHash })),
      );
      if (result.skippedNoHashCount > 0) {
        // 以前はここで「originalHash未計算のため予約できません(画像を保存し
        // 直すと自己修復されます)」と出していたが、hash未計算はサーバー側の
        // ensureOriginalHashがその場で元画像から計算して予約まで続けるように
        // なったため、この分岐へ来るのは「元画像そのものがS3に無い」場合だけ。
        // 利用者に無関係な操作(保存し直し)を促す文言は残さない。
        setError(`${result.skippedNoHashCount}件の画像は元画像が見つからないため加工できませんでした。該当画像を登録し直してください。`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "画像加工の開始に失敗しました。");
    } finally {
      setBulkBusy(false);
    }
  }

  async function handleReprocess(img: ImagePanelRow) {
    setBusyKey(img.storageKey);
    setError(null);
    try {
      await reprocessImageAction({ inventoryId, imageStorageKey: img.storageKey, originalHash: img.originalHash ?? "" });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "再加工の予約に失敗しました。");
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * 「要確認」の加工結果を採用してACTIVEにする。自動では決してACTIVEに
   * ならない(workerはREADYのみACTIVE化し、confidenceが常に0の現状では
   * 必ずNEEDS_REVIEWになる)ため、ここが唯一の採用経路。
   */
  async function handleAdopt(img: ImagePanelRow, versionId: string) {
    setBusyKey(img.storageKey);
    setError(null);
    try {
      await adoptImageVersionAction(inventoryId, img.storageKey, versionId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "加工結果の採用に失敗しました。");
    } finally {
      setBusyKey(null);
    }
  }

  async function handleRollback(img: ImagePanelRow, versionId: string) {
    setBusyKey(img.storageKey);
    setError(null);
    try {
      await rollbackImageVersionAction(inventoryId, img.storageKey, versionId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "ロールバックに失敗しました。");
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <div className="mt-3 border-t border-gray-100 pt-2">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-bold text-gray-400">
          画像加工状況: {readyCount}/{images.length}加工完了
          {needsReviewCount > 0 && ` ・${needsReviewCount}件要確認`}
          {failedCount > 0 && ` ・${failedCount}件失敗`}
          {/* 「状態が無い(未加工)」と「取得できなかった」の混同を防ぐ——加工の失敗件数(failedCount)とは別枠。 */}
          {fetchFailedCount > 0 && ` ・${fetchFailedCount}件状態取得失敗`}
          {checkingCount > 0 && ` ・${checkingCount}件確認中`}
          {pendingStatusUnavailable && " ・予約状況を確認できませんでした"}
        </p>
        <div className="flex items-center gap-2">
          {/* 状態不明の画像は書込系ボタン/一括対象から除外する一方、
              読取(状態の再取得)自体は常にやり直せるようにする——この
              ボタンはrefresh()を呼ぶだけの読取専用操作で、書込系の
              enqueueProcessingJob等には一切触れない。 */}
          {(fetchFailedCount > 0 || pendingStatusUnavailable) && (
            <button
              type="button"
              onClick={() => refresh().catch((err) => setError(err instanceof Error ? err.message : "状態の再取得に失敗しました。"))}
              className="text-[11px] text-gray-400 underline hover:text-gray-900"
            >
              状態を再取得
            </button>
          )}
          {/* §12.3: 商品詳細の画像エリア付近に設置する明確なボタン——
              カテゴリを変更しなくてもこれだけで処理を開始できる。 */}
          <button
            type="button"
            onClick={handleBulkProcess}
            disabled={bulkBusy || anyBusyGlobally || bulkTargets.length === 0}
            title={bulkTargets.length === 0 ? "加工待ちの画像はありません" : undefined}
            className="bg-gray-900 px-2.5 py-1 text-[11px] font-bold text-white disabled:opacity-40"
          >
            {bulkBusy ? "画像を加工中…" : checkingCount > 0 ? "画像の状態を確認中…" : anyBusyGlobally ? "画像を加工中…" : "画像を自動加工"}
          </button>
        </div>
      </div>
      {error && <p className="mb-1.5 text-[11px] text-red-600">{error}</p>}
      <ul className="space-y-1">
        {images.map((img, i) => {
          const versions = byKey[img.storageKey] ?? [];
          const status = currentStatus(versions, pendingJobs[img.storageKey], pendingConfirmedKeys.has(img.storageKey));
          const fetchFailed = failedKeys.has(img.storageKey);
          // 取得失敗の画像は実際の状態が確認できていないため、STATUS_LABELS
          // (直前に分かっていた値、または未加工)ではなく専用ラベルで示す。
          const meta = fetchFailed ? FETCH_FAILED_META : (STATUS_LABELS[status] ?? { label: status, className: "text-gray-500" });
          const superseded = versions.filter((v) => v.status === "SUPERSEDED" || (!v.active && v.status === "READY"));
          const activeVersion = versions.find((v) => v.active);
          const pendingReview = pickPendingReviewVersion(versions, status);
          const shownVersion = activeVersion ?? pendingReview;
          const processedKey = shownVersion?.webKey ?? shownVersion?.processedMasterKey ?? null;
          // 状態不明(fetchFailed)の画像は、実際には処理中/完了済みかも
          // しれないのに直前の既知値(または空=未加工扱い)しか無い——
          // 書込系ボタン(再加工/採用/ロールバック)を全て無効化し、
          // 二重予約や意図しない上書きを防ぐ。読取(状態を再取得ボタン、
          // 上のヘッダー参照)は別途常に可能なままにする。
          const isBusy = busyKey === img.storageKey || BUSY_STATUSES.has(status) || fetchFailed;
          return (
            <li key={img.storageKey} className="text-[11px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-gray-500">画像{i + 1}:</span>
                <span className={`font-bold ${meta.className}`}>{meta.label}</span>
                <button type="button" onClick={() => handleReprocess(img)} disabled={isBusy} className="text-gray-400 hover:text-gray-900 disabled:opacity-50">
                  {reprocessButtonLabel(status)}
                </button>
                {pendingReview && (
                  <button
                    type="button"
                    onClick={() => handleAdopt(img, pendingReview.id)}
                    disabled={isBusy}
                    className="font-bold text-emerald-700 hover:text-emerald-900 disabled:opacity-50"
                  >
                    この加工を採用する
                  </button>
                )}
                {superseded.length > 0 && (
                  <button
                    type="button"
                    onClick={() => handleRollback(img, superseded[superseded.length - 1].id)}
                    disabled={isBusy}
                    className="text-gray-400 hover:text-gray-900 disabled:opacity-50"
                  >
                    直前版に戻す
                  </button>
                )}
              </div>
              {(status === "READY" || status === "NEEDS_REVIEW") && processedKey && <BeforeAfterToggle originalKey={img.storageKey} processedKey={processedKey} label={`画像${i + 1}`} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
