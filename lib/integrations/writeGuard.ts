/**
 * 外部サービスへの**書き込みを既定で禁止する**中央スイッチ。
 *
 * ## なぜ要るのか
 *
 * BELLOは複数の外部サービスとAPI連携している。読み取り（在庫の取り込み、
 * 商品情報の参照）は運用の役に立つが、**書き込みは相手側の実データを
 * 変えてしまう** —— 実運用で十分に確認できるまでは、コードが存在する
 * ことと、それが実際に走れることを分けておきたい。
 *
 * 特に危ないのは無人実行の経路である。pricing-scheduler Lambdaは
 * EventBridgeで1時間ごとに動いており、条件が揃えば人の操作なしに
 * BASEの価格を書き換える。「対象データがまだ0件だから安全」は
 * 運用が始まれば崩れる保証なので、データではなく**構造**で止める。
 *
 * ## 既定は禁止（fail-closed）
 *
 * 環境変数 `EXTERNAL_WRITES_ENABLED` に、許可するチャネル名を
 * 明示的に列挙したときだけ書き込みが通る。未設定・空文字・解釈できない
 * 値は**すべて禁止**として扱う。設定を忘れた結果が「書き込めてしまう」
 * 側に倒れることは無い。
 *
 *     EXTERNAL_WRITES_ENABLED=BASE                  # BASEのみ許可
 *     EXTERNAL_WRITES_ENABLED=BASE,MERCARI_SHOPS    # 両方許可
 *     （未設定）                                     # すべて禁止
 *
 * `ALL` や `true` のような一括指定は**受け付けない**。ひとつずつ名前を
 * 書かせることが目的で、「全部オン」を一語で書けてしまうと、
 * このスイッチが守ろうとしているものが失われる。
 *
 * ## なぜ管理画面のトグルではなく環境変数なのか
 *
 * 「実運用で確認できたら開ける」種類の判断だからで、ブラウザから
 * 押せてしまうと、確認が済む前に誰かが押せる。環境変数の変更はAWS側の
 * 操作＋再デプロイを伴うので、意図しない有効化が起きない。
 * 現在の状態は設定画面に表示する（値の変更はできない、表示のみ）。
 *
 * ## このファイルの依存関係について
 *
 * `server-only` もAWS SDKもimportしない純粋なモジュールにしてある ——
 * Next.jsのサーバー側だけでなく、**pricing-scheduler Lambdaのバンドル
 * からも同じ判定を使う**ため（handler.tsが lib/listing/pricing を
 * importしているのと同じ経路）。判定が2箇所に分かれると、片方だけ
 * 直して安心する事故が起きる。
 */

/**
 * 書き込み先。ZAICOがここに無いのは意図的で、`lib/zaico/client.ts` は
 * そもそもGET専用（post/put/patch/deleteのヘルパーが存在しない）ため、
 * このスイッチ以前に構造として書き込めない。
 *
 * LINEのメッセージ送信もここには含めない。あれは相手のデータを
 * 書き換える操作ではなく、担当者が確認した返信を送る通常の業務動作で、
 * 既に運用されている。止める必要が出た場合はここへ `LINE` を足し、
 * `lib/messaging/line/adapter.ts` の `callLineApi` で同じ関数を呼べばよい。
 */
export const EXTERNAL_WRITE_CHANNELS = ["BASE", "MERCARI_SHOPS"] as const;
export type ExternalWriteChannel = (typeof EXTERNAL_WRITE_CHANNELS)[number];

const ENV_KEY = "EXTERNAL_WRITES_ENABLED";

/** 画面表示用の日本語名。 */
export const EXTERNAL_WRITE_CHANNEL_LABELS: Record<ExternalWriteChannel, string> = {
  BASE: "BASE",
  MERCARI_SHOPS: "Mercari Shops",
};

export class ExternalWriteBlockedError extends Error {
  constructor(
    public readonly channel: ExternalWriteChannel,
    /** 何をしようとしたか（例: "items/edit"）。原因調査のために残す。 */
    public readonly operation: string,
  ) {
    super(
      `${EXTERNAL_WRITE_CHANNEL_LABELS[channel]}への書き込み（${operation}）は現在停止されています。` +
        `実運用での確認が済むまで、外部サービスへの書き込みは既定で禁止されています。` +
        `有効化するにはAWS側で環境変数 ${ENV_KEY} に ${channel} を追加してください。`,
    );
    this.name = "ExternalWriteBlockedError";
  }
}

/**
 * 許可されているチャネルの一覧。
 * @param env テストから差し替えるための注入口。既定は実プロセスの環境変数。
 */
export function listEnabledExternalWrites(env: { [key: string]: string | undefined } = process.env): ExternalWriteChannel[] {
  const raw = env[ENV_KEY];
  if (typeof raw !== "string" || raw.trim() === "") return [];

  const requested = raw
    .split(",")
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);

  // 知らない名前は黙って無視する（禁止側に倒す）。`ALL` や `TRUE` を
  // 書いても何も許可されないのは仕様 —— チャネル名を明示させるため。
  return EXTERNAL_WRITE_CHANNELS.filter((channel) => requested.includes(channel));
}

export function isExternalWriteEnabled(
  channel: ExternalWriteChannel,
  env: { [key: string]: string | undefined } = process.env,
): boolean {
  return listEnabledExternalWrites(env).includes(channel);
}

/**
 * 書き込み直前に必ず通す関門。許可されていなければ投げる。
 *
 * 呼ぶ場所は**実際にHTTPリクエストを出す直前**にする。呼び出し側の
 * 分岐に置くと、新しい呼び出し経路が増えたときに素通りする。
 */
export function assertExternalWriteAllowed(
  channel: ExternalWriteChannel,
  operation: string,
  env: { [key: string]: string | undefined } = process.env,
): void {
  if (isExternalWriteEnabled(channel, env)) return;
  // 遮断は異常ではなく既定の状態なので error ではなく warn。
  // ただし「黙って何もしない」ことはしない —— 止めたことは必ず残す。
  console.warn("[writeGuard] blocked an external write", { channel, operation });
  throw new ExternalWriteBlockedError(channel, operation);
}
