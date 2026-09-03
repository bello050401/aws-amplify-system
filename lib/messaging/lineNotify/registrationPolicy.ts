/**
 * 通知BotのWebhookで受け取ったイベントを、通知先の登録に使ってよいか決める。
 *
 * ── なぜ純粋関数に切り出すか ────────────────────────────────────
 *
 * ここを間違えると**存在しない宛先が通知先として登録され、通知は「成功」
 * したまま誰にも届かない**。LINEの送信APIは宛先が実在しなくてもエラーを
 * 返さないことがあるため、画面上は正常に見える。一番気づきにくい壊れ方
 * なので、routeの中に埋めずに単体で検証できる形にする。
 */

/** LINE Developers Console の「検証」が送ってくるダミーのユーザーID。 */
export const LINE_WEBHOOK_TEST_USER_ID = "Udeadbeefdeadbeefdeadbeefdeadbeef";

/** LINEのユーザーIDの形式(U + 16進32桁)。 */
const LINE_USER_ID_RE = /^U[0-9a-f]{32}$/;

export interface NotifyRegistrationEvent {
  type?: string;
  source?: { type?: string; userId?: string };
}

export type NotifyRegistrationDecision =
  /** 通知先として登録する。 */
  | { action: "REGISTER"; userId: string }
  /** 通知先を解除する(ブロックされた)。 */
  | { action: "CLEAR" }
  /** 何もしない。reason は受信記録へそのまま残す。 */
  | { action: "IGNORE"; reason: string };

export function decideNotifyRegistration(event: NotifyRegistrationEvent): NotifyRegistrationDecision {
  const label = event.type ?? "不明";

  // 通知先は本人1人を想定している。グループ・ルームからのイベントは無視する。
  // 誤ってグループへ追加されたときに、そのグループ全員へ仕入価格が飛ぶのを防ぐ。
  const userId = event.source?.type === "user" ? event.source.userId : undefined;
  if (!userId) {
    return { action: "IGNORE", reason: `${label}: 個人からのイベントではないため対象外(source=${event.source?.type ?? "無し"})` };
  }

  // 解除の判定は**ID検査より先**に行う。ブロックされたのに宛先が残るほうが、
  // 登録できないことより害が大きい(届かない宛先へ再試行し続ける)。
  if (event.type === "unfollow") return { action: "CLEAR" };

  // 疎通確認は「届いたこと」の確認であって、通知先の登録ではない。
  // follow だけでなく任意のイベントで登録する仕様にしたため、
  // 「検証」ボタンを押しただけで登録されてしまう状態になっていた。
  if (userId === LINE_WEBHOOK_TEST_USER_ID) {
    return { action: "IGNORE", reason: `${label}: LINEのWebhook検証を受信しました(通知先は変更していません)` };
  }
  if (!LINE_USER_ID_RE.test(userId)) {
    return { action: "IGNORE", reason: `${label}: ユーザーIDの形式が想定と違うため登録しません` };
  }

  // ── follow だけに頼らない ──────────────────────────────────────
  //
  // follow は一度きりで、取りこぼすと二度と来ない。実際、Webhook URLの
  // 設定前に友だち追加されていたため、いくら待っても登録されない状態に
  // なった(LINEはfollowを再送しない)。Botへ一言送れば復旧できるように、
  // そのBotへ本人から届く**どのイベントでも**登録する。送信できるのは
  // このBotを友だち追加した本人だけなので、他人が登録されることはない。
  return { action: "REGISTER", userId };
}
