import "server-only";
import { inventoryAuthMode, serverDataClient } from "@/lib/amplify/dataClient";

/**
 * §42/§43 AI返信の運用設定。1行だけ(id: "singleton")。
 *
 * 【行が無い場合を「未設定」にしない】設定画面を一度も開いていない環境
 * でも返信案は動くべきなので、行が無いときは既定値を返す。§43の初期値
 * (生成ON・リサーチON・ナレッジON・自動送信OFF)がそのまま既定値。
 *
 * 【autoSendEnabledをこのモジュールから変更できない理由】§41「今回の
 * 実装では無効をデフォルトとする」に加えて、自動送信を有効化する操作は
 * 顧客へ直接影響する。書き込み関数の引数にそもそも含めないことで、
 * UIの実装ミスで有効化されることを防ぐ。
 */

export interface AIReplySettings {
  autoDraftEnabled: boolean;
  webResearchEnabled: boolean;
  knowledgeEnabled: boolean;
  autoSendEnabled: boolean;
}

export const AI_REPLY_SETTINGS_DEFAULT: AIReplySettings = {
  autoDraftEnabled: true,
  webResearchEnabled: true,
  knowledgeEnabled: true,
  autoSendEnabled: false,
};

const SINGLETON_ID = "singleton";

export async function getAIReplySettings(): Promise<AIReplySettings> {
  const { data, errors } = await serverDataClient.models.AIReplySettings.get({ id: SINGLETON_ID }, inventoryAuthMode);
  if (errors) {
    // 設定が読めないことを「既定値」と黙って言い換えない。ただしここで
    // 例外にすると問い合わせ画面ごと落ちるため、警告を残して既定値で続ける。
    console.warn("[aiReplySettings] 設定を読めませんでした。既定値で続行します。", errors.map((e) => e.message).join("; "));
    return AI_REPLY_SETTINGS_DEFAULT;
  }
  if (!data) return AI_REPLY_SETTINGS_DEFAULT;
  return {
    autoDraftEnabled: data.autoDraftEnabled ?? AI_REPLY_SETTINGS_DEFAULT.autoDraftEnabled,
    webResearchEnabled: data.webResearchEnabled ?? AI_REPLY_SETTINGS_DEFAULT.webResearchEnabled,
    knowledgeEnabled: data.knowledgeEnabled ?? AI_REPLY_SETTINGS_DEFAULT.knowledgeEnabled,
    autoSendEnabled: data.autoSendEnabled ?? false,
  };
}

/** 自動送信は引数に含めない(上のコメント参照)。 */
export async function updateAIReplySettings(
  patch: { autoDraftEnabled?: boolean; webResearchEnabled?: boolean; knowledgeEnabled?: boolean },
  who: string | null,
): Promise<AIReplySettings> {
  const current = await getAIReplySettings();
  const next = { ...current, ...patch };
  const { errors: updateErrors } = await serverDataClient.models.AIReplySettings.update(
    { id: SINGLETON_ID, ...next, updatedBy: who },
    inventoryAuthMode,
  );
  if (updateErrors) {
    // 行がまだ無ければupdateは失敗する。その場合だけcreateへ回る。
    const { errors: createErrors } = await serverDataClient.models.AIReplySettings.create(
      { id: SINGLETON_ID, ...next, updatedBy: who },
      inventoryAuthMode,
    );
    if (createErrors) throw new Error(createErrors[0]?.message ?? "AI返信設定の保存に失敗しました。");
  }
  return next;
}
