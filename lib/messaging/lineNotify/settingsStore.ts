import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * 2026-09-03 指示書 §4-3/§6: 社内通知Botの接続設定。1行だけ(id: "singleton")。
 *
 * 秘密情報はここに入らない。Channel Secret / Access Token は
 * lib/messaging/lineNotify/secretStore.ts(AWS Secrets Manager)だけが持つ。
 * このモデルが持つのは「誰へ送るか」「画面に何を出すか」という、
 * 漏れても直接の被害が無い情報に限る。
 */

export interface LineNotifySettings {
  /** follow イベントで自動登録された通知先。未登録なら null。 */
  targetUserId: string | null;
  targetDisplayName: string | null;
  followedAt: string | null;
  addFriendUrl: string | null;
  qrImageUrl: string | null;
  botDisplayName: string | null;
  lastNotifiedAt: string | null;
  lastNotifyStatus: string | null;
  /** 通知BotのWebhookを最後に受信した日時と結果(登録できない原因の切り分け用)。 */
  lastWebhookAt: string | null;
  lastWebhookResult: string | null;
}

export const LINE_NOTIFY_SETTINGS_DEFAULT: LineNotifySettings = {
  targetUserId: null,
  targetDisplayName: null,
  followedAt: null,
  addFriendUrl: null,
  qrImageUrl: null,
  botDisplayName: null,
  lastNotifiedAt: null,
  lastNotifyStatus: null,
  lastWebhookAt: null,
  lastWebhookResult: null,
};

const SINGLETON_ID = "singleton";

export async function getLineNotifySettings(): Promise<LineNotifySettings> {
  const { data, errors } = await serverDataClient.models.LineNotifySettings.get({ id: SINGLETON_ID }, inventoryAuthMode);
  if (errors) {
    // 読めないことを黙って「未設定」と言い換えない。ただし例外にすると
    // メッセージ画面ごと落ちるので、警告を残して既定値で続ける。
    console.warn("[lineNotifySettings] 設定を読めませんでした。既定値で続行します。", errors.map((e) => e.message).join("; "));
    return LINE_NOTIFY_SETTINGS_DEFAULT;
  }
  if (!data) return LINE_NOTIFY_SETTINGS_DEFAULT;
  return {
    targetUserId: data.targetUserId ?? null,
    targetDisplayName: data.targetDisplayName ?? null,
    followedAt: data.followedAt ?? null,
    addFriendUrl: data.addFriendUrl ?? null,
    qrImageUrl: data.qrImageUrl ?? null,
    botDisplayName: data.botDisplayName ?? null,
    lastNotifiedAt: data.lastNotifiedAt ?? null,
    lastNotifyStatus: data.lastNotifyStatus ?? null,
    lastWebhookAt: data.lastWebhookAt ?? null,
    lastWebhookResult: data.lastWebhookResult ?? null,
  };
}

/**
 * 1行しか無いので create/update を呼び分ける。get で存在確認してから
 * 分岐すると、同時に2つのリクエストが来たときに両方 create へ入って
 * 片方が落ちる。**まず update を試し、行が無いときだけ create** にする
 * (Secrets Manager 側の Put→Create フォールバックと同じ考え方)。
 */
async function upsert(fields: Record<string, unknown>): Promise<void> {
  const updated = await serverDataClient.models.LineNotifySettings.update(
    { id: SINGLETON_ID, ...fields },
    inventoryAuthMode,
  );
  if (updated.data) return;
  const created = await serverDataClient.models.LineNotifySettings.create(
    { id: SINGLETON_ID, ...fields },
    inventoryAuthMode,
  );
  if (created.errors) {
    throw new Error(`通知Bot設定の保存に失敗しました: ${created.errors.map((e) => e.message).join("; ")}`);
  }
}

/**
 * friend追加(follow イベント)で通知先を登録する。
 *
 * **手入力の口を用意しない。** LINEのユーザーIDは人が読んで意味の分かる
 * 値ではないので、コンソールから転記させると高確率で間違える。間違えた
 * まま保存されると通知は「成功」したまま誰にも届かない —— 一番気づき
 * にくい壊れ方になる。実際に友だち追加したイベントからしか登録しない。
 */
export async function registerNotifyTarget(params: { userId: string; displayName: string | null }): Promise<void> {
  await upsert({
    targetUserId: params.userId,
    targetDisplayName: params.displayName ?? undefined,
    followedAt: new Date().toISOString(),
  });
}

/** ブロック(unfollow)されたら通知先を外す。送れない宛先へ延々と再試行しない。 */
export async function clearNotifyTarget(): Promise<void> {
  await upsert({ targetUserId: null, targetDisplayName: null, followedAt: null });
}

/**
 * Webhookで受け取ったイベントと、その処理結果を残す。
 *
 * **成功も失敗も残す。** 失敗だけ記録すると、「そもそも届いていない」のか
 * 「届いたが失敗した」のかが区別できず、今回まさにそこで詰まった。
 * 記録自体の失敗で登録処理を巻き添えにしないよう、例外は握りつぶす。
 */
export async function recordWebhookEvent(result: string): Promise<void> {
  try {
    await upsert({ lastWebhookAt: new Date().toISOString(), lastWebhookResult: result });
  } catch (err) {
    console.warn("[lineNotifySettings] Webhook受信を記録できませんでした。", err instanceof Error ? err.message : String(err));
  }
}

/** 接続確認できた Bot の情報と、友だち追加の案内(QR/URL)を保存する。 */
export async function saveNotifyBotProfile(params: {
  botDisplayName?: string | null;
  addFriendUrl?: string | null;
  qrImageUrl?: string | null;
  updatedBy?: string | null;
}): Promise<void> {
  const fields: Record<string, unknown> = {};
  if (params.botDisplayName !== undefined) fields.botDisplayName = params.botDisplayName;
  if (params.addFriendUrl !== undefined) fields.addFriendUrl = params.addFriendUrl;
  if (params.qrImageUrl !== undefined) fields.qrImageUrl = params.qrImageUrl;
  if (params.updatedBy) fields.updatedBy = params.updatedBy;
  if (Object.keys(fields).length === 0) return;
  await upsert(fields);
}

/** §6「最終通知日時」「直近の通知結果」。送信の成否にかかわらず記録する。 */
export async function recordNotifyResult(status: string): Promise<void> {
  try {
    await upsert({ lastNotifiedAt: new Date().toISOString(), lastNotifyStatus: status });
  } catch (err) {
    // 表示用の記録が失敗しても、通知そのものの成否を覆さない。
    console.warn("[lineNotifySettings] 直近の通知結果を記録できませんでした。", err instanceof Error ? err.message : String(err));
  }
}
