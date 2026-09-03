/**
 * 直前の確認事項への「答え」を読み取る(2026-09-03 追加指示 §22)。
 *
 * ── なぜ専用の解釈が要るのか ────────────────────────────────────
 *
 *     BELLO「お届け先の都道府県を教えていただけますでしょうか」
 *     顧客 「埼玉です」
 *
 *     BELLO「ご希望のお届け日はございますでしょうか」
 *     顧客 「11日でお願いします」
 *
 * どちらも**それ単体では意味が確定しない**。「11日」は月が書かれて
 * いないので、通常の日付抽出(deliveryWindow.ts)は正しく null を返す ——
 * 月の無い日付を勝手に決めると、配送可否の判定が丸ごとずれるからだ。
 *
 * ところが「いまお届け日を尋ねていて、その答えとして届いた」と分かって
 * いれば、直近の11日と読むのが自然で、しかも安全に確認できる。
 * つまり**確認待ちの項目が分かっているときにだけ**成立する解釈がある。
 *
 * このファイルはその解釈だけを担当する。純粋関数のみ。
 * 確認待ちでない場合は何も読み取らない —— 普通の問い合わせの本文から
 * 「11日」を配送希望日として拾い始めると、別の誤りが生まれる。
 */
import { extractShippingDestination } from "./shippingIntent";
import { extractRequestedDeliveryDate } from "./deliveryWindow";
import type { ConversationContext, PendingQuestionField } from "./conversationContext";
import { isPending } from "./conversationContext";

export interface PendingAnswer {
  field: PendingQuestionField;
  /** 読み取った値(都道府県名、YYYY-MM-DD など)。 */
  value: string;
  /** 何を根拠にそう読んだか。通知と診断へ出す。 */
  reason: string;
}

/** 「11日」「11日で」のように**日だけ**が書かれているか。 */
function extractDayOnly(text: string): number | null {
  const normalized = text.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
  // 月が書いてあるなら、そちらは通常の抽出に任せる。
  if (/\d{1,2}\s*月/.test(normalized)) return null;
  if (/\d{1,2}\s*\/\s*\d{1,2}/.test(normalized)) return null;
  // 「3日後」「3日以内」は起点付きの表現なので、ここでは扱わない。
  if (/\d{1,3}\s*日\s*(?:後|以内|間)/.test(normalized)) return null;
  const m = /(?<!\d)(\d{1,2})\s*日/.exec(normalized);
  if (!m) return null;
  const day = Number(m[1]);
  return day >= 1 && day <= 31 ? day : null;
}

function toIsoDate(year: number, month: number, day: number): string {
  const mm = String(month).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

/**
 * 日だけが書かれた希望日を、**直近の未来の**その日として読む。
 *
 * 今日より前の日付になるなら翌月。過去日として扱うと、配送可否の判定が
 * 常に「日程の再確認が必要」へ落ちてしまう。
 */
export function resolveDayOnlyDate(day: number, now: Date): string {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  let year = jst.getUTCFullYear();
  let month = jst.getUTCMonth() + 1;
  if (day < jst.getUTCDate()) {
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return toIsoDate(year, month, day);
}

/**
 * 確認待ちの項目に対する答えを読み取る。
 *
 * **確認待ちの項目しか読まない。** これがこの関数の安全性の根拠で、
 * 「普通の問い合わせから配送希望日を勝手に読む」回帰を構造的に防ぐ。
 */
export function resolvePendingAnswers(params: {
  context: ConversationContext;
  messageText: string;
  now?: Date;
}): PendingAnswer[] {
  const now = params.now ?? new Date();
  const out: PendingAnswer[] = [];

  if (isPending(params.context, "DESTINATION_PREFECTURE")) {
    const destination = extractShippingDestination(params.messageText);
    if (destination.prefecture) {
      out.push({
        field: "DESTINATION_PREFECTURE",
        value: destination.prefecture,
        reason: `お届け先を確認中で、「${destination.matchedText ?? destination.prefecture}」と回答がありました。`,
      });
    }
  }

  if (isPending(params.context, "REQUESTED_DELIVERY_DATE")) {
    const full = extractRequestedDeliveryDate(params.messageText, now);
    if (full) {
      out.push({
        field: "REQUESTED_DELIVERY_DATE",
        value: full.toISOString().slice(0, 10),
        reason: "お届け日を確認中で、日付の回答がありました。",
      });
    } else {
      const day = extractDayOnly(params.messageText);
      if (day != null) {
        out.push({
          field: "REQUESTED_DELIVERY_DATE",
          value: resolveDayOnlyDate(day, now),
          reason: `お届け日を確認中で、「${day}日」と回答がありました(月の記載が無いため直近の${day}日として扱っています)。`,
        });
      }
    }
  }

  return out;
}
