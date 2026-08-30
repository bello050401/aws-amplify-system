import "server-only";
import { createHash } from "node:crypto";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";
import { SHIPPING_ORIGIN_PREFECTURE } from "./prefectures";
import type { ShippingRank } from "./rank";

/**
 * BELLO統合業務OS 第六ラウンド §7-11(P0-2): 家財おまかせ便『埼玉発』
 * 公式料金データの取得・DB投入インフラ。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 【今回のP0-2で実際に確認した事実(推測ではない、機械的に再検証済み)】
 *
 * 公式の料金検索ツール(https://form.008008.jp/mitumori/
 * PKZI0100Action_doInit.action、WebSearchで実際に検索し確認したURL)
 * および同一ドメインの他ページ(www.008008.jp)は、このセッションの
 * 開発sandbox環境から**3つの独立した手段全て**で到達不能だった:
 *   1. WebFetchツール: `EGRESS_BLOCKED`(form.008008.jp/www.008008.jp
 *      いずれも)。
 *   2. WebSearchツール: 検索エンジンの要約は返るが、動的にレンダリング
 *      される料金表本体の実数値までは要約されない。
 *   3. 実Chromiumブラウザ(Playwright)での直接navigation:
 *      `net::ERR_TUNNEL_CONNECTION_FAILED`——ブラウザの実ネットワーク
 *      スタックも同じegress proxy制限を受けており、UIを人間のように
 *      辿る自動化でも回避できない。
 *
 * これは「試行を怠った」結果ではなく、この開発sandbox固有のネットワーク
 * ポリシーによる構造的な制約——AWS Amplify Hosting上の実際のSSR
 * コンピュート/Lambdaは、通常VPC設定次第で全く別のegress経路を持つため、
 * **実デプロイ環境でこのコードが同じ理由で失敗するとは限らない**。
 * そのため以下の`Form008008RateSource`は「動かないふりをする」のでは
 * なく、実際に本物のHTTPリクエストを試みる実装にしてある——この
 * sandbox内では失敗するが、実際に到達可能な環境ではそのまま機能する
 * 設計。
 *
 * 【今回できなかったこと、正直な理由】
 * 上記の理由で公式ページのHTML/フォーム構造(input name、POST先URL、
 * 複数ステップの有無等)を一度も直接観測できていない。このため
 * 「フォームへ何を送信すれば料金が返るか」という実際の契約は今回も
 * 未確認のまま——ここを推測で埋めるのは指示書の「外部サイトの
 * アクセス制御を回避しない」「推測実装禁止」に反するため、初回GETが
 * 成功した場合でも、その先の複数ステップ操作は
 * `ShippingImportUnconfirmedContractError`として明示的に停止する
 * (詳細は`Form008008RateSource.fetchRateMatrix`のコメント参照)。
 * ここから先は、実際に到達可能な環境で人間が一度フォームを操作し、
 * ブラウザの開発者ツールのNetworkタブでリクエスト内容を確認する
 * (§8「まず公式料金検索ページのHTML form...を調査する」)ことでしか
 * 埋められない——完全に自動化しきれない、ユーザー本人の観測が必要な
 * 唯一の残作業として最終報告に明記する。
 * ─────────────────────────────────────────────────────────────────────
 */

export const OFFICIAL_RATE_SEARCH_URL = "https://form.008008.jp/mitumori/PKZI0100Action_doInit.action";

export class ShippingImportNetworkError extends Error {
  constructor(cause: unknown) {
    super(`公式料金検索ページ(${OFFICIAL_RATE_SEARCH_URL})へ到達できませんでした: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ShippingImportNetworkError";
  }
}

export class ShippingImportUnconfirmedContractError extends Error {
  constructor() {
    super(
      "公式料金検索ページへの到達には成功しましたが、実際の料金取得に必要なフォーム送信の契約(入力項目名・複数ステップの有無)がまだ未確認です。" +
        "人間が一度ブラウザでこのページを操作し、開発者ツールのNetworkタブでリクエスト内容を確認した上で、Form008008RateSource.fetchRateMatrixの実装を完成させる必要があります。" +
        "推測でPOSTパラメータを埋めることは指示書により禁止されています。",
    );
    this.name = "ShippingImportUnconfirmedContractError";
  }
}

export interface OfficialRateCell {
  destinationPrefecture: string;
  destinationArea?: string | null;
  rank: ShippingRank;
  /** null = 公式がこのdestination×rankをサービス対象外と明示した(§84、0円にしない)。 */
  price: number | null;
  taxIncluded: boolean;
  /** 差分検出用hashの元になる、公式ページ上の生の表示文字列(パース前)。 */
  rawText: string;
}

export interface OfficialRateSource {
  sourceUrl: string;
  fetchRateMatrix(originPrefecture: string): Promise<OfficialRateCell[]>;
}

/**
 * 実際にHTTPリクエストを試みる、本番想定の実装。上のファイル冒頭コメント
 * の通り、このsandbox環境では`ShippingImportNetworkError`で失敗するが、
 * 到達可能な環境ではまず本物のGETを行う——「動かないふりをするダミー」
 * ではない。
 */
export class Form008008RateSource implements OfficialRateSource {
  readonly sourceUrl = OFFICIAL_RATE_SEARCH_URL;

  async fetchRateMatrix(originPrefecture: string): Promise<OfficialRateCell[]> {
    // originPrefectureは実フォーム送信時のパラメータとして必要になる
    // (フォームの実際のinput name/送信方式が未確認のため、現時点では
    // GETのみでまだ使用していない——上記コメント参照)。
    void originPrefecture;
    let html: string;
    try {
      const res = await fetch(this.sourceUrl, { method: "GET" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      throw new ShippingImportNetworkError(err);
    }
    // ページ自体には到達できたが、複数ステップ/JavaScript動的フォーム
    // である可能性が高く(§8「JavaScript生成/セッションが必要なら
    // Playwright等で...検討する」)、実際の料金取得契約は依然未確認。
    // htmlの中身を一切パースせずここで止める——手探りでform要素を
    // 拾って推測のPOSTを送るくらいなら、明示的に「未確認」として
    // 停止する方が安全(§157 fake success禁止と同じ精神)。
    void html;
    throw new ShippingImportUnconfirmedContractError();
  }
}

// ────────────────────────────────────────────────────────────────────
// §9: 「埼玉発を全て」の完成定義 — 期待matrix生成 + 充足率計算(純粋
// 関数、AWSに一切触れない — scripts/verify-shipping.tsから直接テスト
// できる)。
// ────────────────────────────────────────────────────────────────────

export const ALL_SHIPPING_RANKS: ShippingRank[] = ["SS", "S", "A", "B", "C", "D", "E", "F", "G", "OVERSIZE"];

/**
 * 全47都道府県 × 全rank の期待組合せ。§9「全destination×全rankの組合せ
 * を期待matrixとして生成する」——destinationの地域細分(市区町村単位等)
 * は公式ページの実際の区分が未確認(上記コメント参照)のため、現状は
 * 都道府県単位で生成する。実際の区分が判明次第、この関数だけを差し替え
 * れば済む設計。
 */
export function buildExpectedMatrix(destinationPrefectures: string[], ranks: ShippingRank[] = ALL_SHIPPING_RANKS): { destinationPrefecture: string; rank: ShippingRank }[] {
  const cells: { destinationPrefecture: string; rank: ShippingRank }[] = [];
  for (const destinationPrefecture of destinationPrefectures) {
    for (const rank of ranks) cells.push({ destinationPrefecture, rank });
  }
  return cells;
}

export interface MatrixCompletenessResult {
  expectedCells: number;
  verifiedCells: number;
  unavailableCells: number;
  missingCells: number;
  completenessRatio: number; // (verified+unavailable)/expected — 「取得を試みて結果を得られた」割合。0円/推測で埋めた分は分子に含まれない。
  missingCombinations: { destinationPrefecture: string; rank: ShippingRank }[];
}

/**
 * §9「取得結果をmatrixと照合し、missing cellを列挙する。missingを0円
 * 扱いにしない」——欠損は「未取得」として明示的に返す、埋めない。
 */
export function computeMatrixCompleteness(
  expected: { destinationPrefecture: string; rank: ShippingRank }[],
  actual: { destinationPrefecture: string; rank: ShippingRank; status: "VERIFIED" | "UNAVAILABLE" }[],
): MatrixCompletenessResult {
  const actualByKey = new Map(actual.map((a) => [`${a.destinationPrefecture}|${a.rank}`, a.status] as const));
  let verifiedCells = 0;
  let unavailableCells = 0;
  const missingCombinations: { destinationPrefecture: string; rank: ShippingRank }[] = [];
  for (const cell of expected) {
    const status = actualByKey.get(`${cell.destinationPrefecture}|${cell.rank}`);
    if (status === "VERIFIED") verifiedCells++;
    else if (status === "UNAVAILABLE") unavailableCells++;
    else missingCombinations.push(cell);
  }
  const expectedCells = expected.length;
  return {
    expectedCells,
    verifiedCells,
    unavailableCells,
    missingCells: missingCombinations.length,
    completenessRatio: expectedCells === 0 ? 0 : (verifiedCells + unavailableCells) / expectedCells,
    missingCombinations,
  };
}

/** rawText(公式ページの生表示文字列)から差分検出用hashを計算する——同一値ならDB書き込みを抑制する(§25「rawHash一致はDB writeを抑制する」)。 */
export function computeRawHash(rawText: string): string {
  return createHash("sha256").update(rawText).digest("hex");
}

// ────────────────────────────────────────────────────────────────────
// import batch orchestration(AWS書き込みを伴う——lib/shipping/service.ts
// と同じレイヤー)。
// ────────────────────────────────────────────────────────────────────

const IMPORT_LEASE_DURATION_MS = 10 * 60 * 1000; // 公式サイトへの低頻度・直列アクセス(§8「取得速度より正確性・サイト負荷低減を優先」)を前提に長め

export interface RunImportResult {
  batchId: string;
  status: "COMPLETED" | "FAILED";
  reason?: string;
}

/**
 * §11「同時import二重実行をlease/idempotencyで防止する」。ZaicoSyncJob
 * (amplify/functions/zaico-sync-worker)と同じ「読み取り→未使用/期限切れ
 * を確認→書き込み」の非atomicなapproximation——ここもAmplify Data
 * client経由(生DynamoDB ConditionExpressionが使えない)のため、同じ
 * 制限・同じidempotencyによる安全網という設計を踏襲する
 * (lib/inventory/zaicoBackgroundSync.tsのclaimLeaseコメント参照)。
 */
async function claimAnyRunningBatch(): Promise<boolean> {
  const { data } = await serverDataClient.models.ShippingImportBatch.list({
    filter: { or: [{ status: { eq: "PENDING" } }, { status: { eq: "RUNNING" } }] },
    ...inventoryAuthMode,
  });
  const now = Date.now();
  const stillRunning = data.find((b) => !b.leaseExpiresAt || new Date(b.leaseExpiresAt).getTime() > now);
  return stillRunning == null;
}

/**
 * §11「公式料金を更新」action本体。ADMIN限定(呼び出し元
 * app/actions/shipping.tsで権限強制)。
 *
 * 【失敗時の安全性、§105「公式サイト障害時に既存verified ratesを削除
 * しない」】このsandbox環境では`source.fetchRateMatrix`が必ず例外を
 * 投げる(上記コメント参照)——その場合、ShippingImportBatchを
 * status="FAILED"として記録するだけで、既存のShippingRateテーブルには
 * 一切書き込みを行わない(該当するUPDATE/CREATE呼び出し自体が実行され
 * ない、コード上の構造としてそうなっている)。
 */
export async function runShippingRateImportBatch(
  who: string | null,
  source: OfficialRateSource = new Form008008RateSource(),
  expectedDestinations: string[] = [],
): Promise<RunImportResult> {
  const canRun = await claimAnyRunningBatch();
  if (!canRun) {
    throw new Error("既に実行中のimport batchがあります。完了を待ってから再試行してください。");
  }

  const now = new Date().toISOString();
  const { data: batch, errors: createErrors } = await serverDataClient.models.ShippingImportBatch.create(
    {
      status: "RUNNING",
      sourceUrl: source.sourceUrl,
      startedAt: now,
      leaseOwner: `admin:${who ?? "unknown"}`,
      leaseExpiresAt: new Date(Date.now() + IMPORT_LEASE_DURATION_MS).toISOString(),
      triggeredBy: who ?? undefined,
    },
    inventoryAuthMode,
  );
  if (createErrors || !batch) throw new Error(createErrors?.[0]?.message ?? "import batchの作成に失敗しました。");

  try {
    const cells = await source.fetchRateMatrix(SHIPPING_ORIGIN_PREFECTURE);
    // ここから先(成功時のDB書き込み・matrix完成度計算)は、実際に
    // fetchRateMatrixが値を返せる環境で機能する——このsandbox環境の
    // Form008008RateSourceは必ず例外を投げるため到達しないが、
    // モックsourceを使うテスト(scripts/verify-shipping.ts)では
    // この経路も実行・検証している。
    let verifiedCells = 0;
    let unavailableCells = 0;
    let changedCells = 0;
    let unchangedCells = 0;
    let failedCells = 0;

    for (const cell of cells) {
      const rawHash = computeRawHash(cell.rawText);
      try {
        const { data: existingRows } = await serverDataClient.models.ShippingRate.listShippingRateByDestinationPrefectureAndRank(
          { destinationPrefecture: cell.destinationPrefecture, rank: { eq: cell.rank } },
          inventoryAuthMode,
        );
        const existing = existingRows[0];
        if (existing?.rawHash === rawHash) {
          unchangedCells++;
        } else {
          if (existing) changedCells++;
          const status: "UNAVAILABLE" | "VERIFIED" = cell.price == null ? "UNAVAILABLE" : "VERIFIED";
          const fields = {
            provider: "アートセッティングデリバリー",
            service: "家財おまかせ便",
            originPrefecture: SHIPPING_ORIGIN_PREFECTURE,
            destinationPrefecture: cell.destinationPrefecture,
            destinationArea: cell.destinationArea ?? null,
            rank: cell.rank,
            price: cell.price,
            taxIncluded: cell.taxIncluded,
            sourceReference: source.sourceUrl,
            acquiredAt: new Date().toISOString(),
            verifiedAt: new Date().toISOString(),
            status,
            rawHash,
            importBatchId: batch.id,
            updatedBy: who ?? undefined,
          };
          if (existing) {
            await serverDataClient.models.ShippingRate.update({ id: existing.id, ...fields, version: (existing.version ?? 1) + 1 }, inventoryAuthMode);
          } else {
            await serverDataClient.models.ShippingRate.create({ ...fields, version: 1, createdBy: who ?? undefined }, inventoryAuthMode);
          }
          if (status === "VERIFIED") verifiedCells++;
          else unavailableCells++;
        }
      } catch {
        failedCells++;
      }
    }

    const expected = buildExpectedMatrix(expectedDestinations.length > 0 ? expectedDestinations : cells.map((c) => c.destinationPrefecture));
    const completeness = computeMatrixCompleteness(
      expected,
      cells.map((c) => ({ destinationPrefecture: c.destinationPrefecture, rank: c.rank, status: c.price == null ? ("UNAVAILABLE" as const) : ("VERIFIED" as const) })),
    );

    await serverDataClient.models.ShippingImportBatch.update(
      {
        id: batch.id,
        status: "COMPLETED",
        finishedAt: new Date().toISOString(),
        expectedCells: completeness.expectedCells,
        verifiedCells,
        unavailableCells,
        missingCells: completeness.missingCells,
        failedCells,
        changedCells,
        unchangedCells,
        leaseOwner: null,
        leaseExpiresAt: null,
      },
      inventoryAuthMode,
    );
    return { batchId: batch.id, status: "COMPLETED" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await serverDataClient.models.ShippingImportBatch.update(
      { id: batch.id, status: "FAILED", finishedAt: new Date().toISOString(), lastError: reason, leaseOwner: null, leaseExpiresAt: null },
      inventoryAuthMode,
    );
    return { batchId: batch.id, status: "FAILED", reason };
  }
}

export interface ShippingImportBatchSummary {
  id: string;
  status: string;
  sourceUrl: string;
  expectedCells: number;
  verifiedCells: number;
  unavailableCells: number;
  missingCells: number;
  failedCells: number;
  changedCells: number;
  unchangedCells: number;
  lastError: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/** §11「最終取得日時、verified件数、missing件数、失敗件数、sourceを表示する」——設定画面向け。 */
export async function getLatestShippingImportBatch(): Promise<ShippingImportBatchSummary | null> {
  const { data } = await serverDataClient.models.ShippingImportBatch.list({ ...inventoryAuthMode, limit: 20 });
  if (data.length === 0) return null;
  const latest = [...data].sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))[0];
  return {
    id: latest.id,
    status: latest.status,
    sourceUrl: latest.sourceUrl,
    expectedCells: latest.expectedCells ?? 0,
    verifiedCells: latest.verifiedCells ?? 0,
    unavailableCells: latest.unavailableCells ?? 0,
    missingCells: latest.missingCells ?? 0,
    failedCells: latest.failedCells ?? 0,
    changedCells: latest.changedCells ?? 0,
    unchangedCells: latest.unchangedCells ?? 0,
    lastError: latest.lastError ?? null,
    startedAt: latest.startedAt ?? null,
    finishedAt: latest.finishedAt ?? null,
  };
}
