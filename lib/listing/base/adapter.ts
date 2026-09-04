import "server-only";
import { getAccessToken, isBaseConnected, BaseNotConnectedError } from "@/lib/base/oauth";
import { BaseListingApiError, classifyBaseHttpStatus } from "./errors";
import { assertExternalWriteAllowed } from "@/lib/integrations/writeGuard";
import type { ListingDraftRecord } from "../types";
import { formatDescriptionForChannel } from "../descriptionFormat";
import { fetchWithTimeout } from "@/lib/http/fetchWithTimeout";

/**
 * この経路の外部呼び出し。応答が返らないまま固まらないよう上限を持つ
 * （2026-09-04 健全化 PHASE 8 — lib/http/fetchWithTimeout.ts）。
 * どこが時間切れになったのかがログで分かるよう、名前を付けて渡す。
 */
const fetchExternal = (input: string | URL | Request, init?: RequestInit) =>
  fetchWithTimeout(input, init, { label: "BASE API" });


/**
 * BELLO統合業務OS 第二次完全完遂指示(2026-08-30) §4: BASE
 * (thebase.in)への実際の商品作成/編集。
 *
 * 【前回ラウンドの誤り】「BASEは特集ページ生成専用の別システムだから
 * 対象外」と判断していたが、これは誤りだった — BASEはshop側の商品を
 * 作成・編集できる公式APIを実際に公開しており(WebSearchで確認:
 * https://docs.thebase.in/docs/api/items/add ,
 * https://docs.thebase.in/docs/api/items/edit
 * — POST、title/detail/price/stock/visible等のフィールド名を確認)、
 * Mercari Shopsと同格の「Channel Listing先」として扱える。
 *
 * 【再利用した既存資産】OAuth2のトークン取得・自動リフレッシュは
 * lib/base/oauth.ts(Feature-page生成機能が既に使っている、
 * BaseOAuthTokenをAmplify Dataへ永続化する実装)をそのまま再利用する
 * — 同じBASEショップアカウントへの接続なので、Secrets Manager等を
 * 新設する理由が無い(§26「既存実装を監査して再利用する」)。
 *
 * 【今回の実装範囲、正直に】items/add(商品作成)・items/edit(価格/
 * 在庫/公開状態の更新)のみ。画像アップロード用のエンドポイント
 * (BASEには商品画像追加の別API/multipart手順が存在する可能性が高い
 * が、このsandbox環境のWebFetchがdocs.thebase.inへ到達できず
 * (egress proxyでEGRESS_BLOCKED)、正確なエンドポイント名・
 * multipart構造を確認できなかった)は未実装 — 画像無しで商品自体は
 * 作成できる(BASE商品ページ側で後から画像を追加する運用を想定)。
 * これは§155の「実装範囲を縮小しない」に抵触しないよう明記する:
 * 商品テキスト情報の作成・更新は完全に動作するが、画像同期は
 * 次のステップとして残っている。
 */

const API_BASE = "https://api.thebase.in/1";

async function baseApiCall<T>(path: string, params: Record<string, string | number>): Promise<T> {
  // このファイルの呼び出しは items/add と items/edit の2つだけで、
  // どちらもBASE側の実データを変える。読み取りは lib/base/client.real.ts
  // が別に持っているので、ここを通るものは全部「書き込み」でよい。
  // 関門はトークン取得より前に置く —— 遮断されるのに認証だけ走るのは
  // 無駄だし、失敗の理由も分かりにくくなる。
  assertExternalWriteAllowed("BASE", path.replace(/^\//, ""));

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    if (err instanceof BaseNotConnectedError) throw new BaseListingApiError("NOT_CONNECTED", err.message);
    throw new BaseListingApiError("CONFIG_REQUIRED", err instanceof Error ? err.message : String(err));
  }

  let res: Response;
  try {
    res = await fetchExternal(`${API_BASE}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))),
      cache: "no-store",
    });
  } catch (err) {
    throw new BaseListingApiError("NETWORK_ERROR", err instanceof Error ? err.message : String(err));
  }

  const text = await res.text();
  if (!res.ok) throw classifyBaseHttpStatus(res.status, text);

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BaseListingApiError("UNKNOWN_REMOTE_ERROR", `Expected JSON, got: ${text.slice(0, 300)}`);
  }
}

export interface BaseListingInput {
  draft: ListingDraftRecord;
  overrideTitle?: string | null;
  overrideDescription?: string | null;
  overridePrice?: number | null;
  quantity: number;
}

export interface BaseListingResult {
  externalProductId: string;
}

/** §4: items/add — 商品を新規作成する。確認済みフィールド名(title/detail/price/stock/visible)のみ送る。 */
export async function createBaseProduct(input: BaseListingInput): Promise<BaseListingResult> {
  const title = input.overrideTitle?.trim() || input.draft.title;
  // §25 チャネル別formatter を通す。共通の商品説明は書き換えず、送信用の
  // 文字列だけをここで作る(改行の正規化・制御文字の除去)。
  const detail = formatDescriptionForChannel(
    input.overrideDescription?.trim() || input.draft.description || "",
    "BASE",
  ).text;
  const price = input.overridePrice ?? input.draft.price;
  if (!title) throw new BaseListingApiError("REMOTE_VALIDATION_ERROR", "タイトルが空です。");
  if (price == null || price <= 0) throw new BaseListingApiError("REMOTE_VALIDATION_ERROR", "価格が未設定です。");

  const data = await baseApiCall<{ item?: { item_id?: string | number }; item_id?: string | number }>("/items/add", {
    title,
    detail,
    price,
    stock: input.quantity,
    visible: 1,
  });
  const itemId = data.item?.item_id ?? data.item_id;
  if (!itemId) throw new BaseListingApiError("UNKNOWN_REMOTE_ERROR", `item_idがレスポンスに含まれていません: ${JSON.stringify(data)}`);
  return { externalProductId: String(itemId) };
}

export interface BaseUpdateInput {
  itemId: string;
  price?: number;
  stock?: number;
  visible?: boolean;
}

/** §4/§6: items/edit — 既存商品の価格・在庫・公開状態を更新する(Pricing Rule Engineの実送信先としても使う)。 */
export async function updateBaseProduct(input: BaseUpdateInput): Promise<void> {
  const params: Record<string, string | number> = { item_id: input.itemId };
  if (input.price !== undefined) params.price = input.price;
  if (input.stock !== undefined) params.stock = input.stock;
  if (input.visible !== undefined) params.visible = input.visible ? 1 : 0;
  await baseApiCall<unknown>("/items/edit", params);
}

export { isBaseConnected };
