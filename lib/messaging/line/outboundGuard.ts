import "server-only";

/**
 * LINE送信(BELLO → 外部LINE)の**サーバー側ハードロック**。
 *
 * 2026-09-02 指示書 §K / §5-§7:
 *
 *     外部LINE → BELLO = 有効
 *     BELLO → 外部LINE = 無効
 *
 * 現在はテスト段階のため、実顧客のLINEへメッセージを送ってはいけない。
 * **UIのボタンをdisabledにするだけでは不十分**という要件なので、
 * 送信処理そのものの入口で拒否する。
 *
 * ── なぜ「送信関数の中」で見るのか ──────────────────────────────
 *
 * 呼び出し側(Server Action / worker / retry / 直接呼び出し)ごとに
 * チェックを置くと、経路が増えるたびに1つ抜ける。抜けた経路が
 * **実顧客への誤送信**という取り返しのつかない結果を生む。
 * そこで、外部HTTPリクエストを実際に出す唯一の場所
 * (lib/messaging/line/adapter.ts の callLineApi)から必ずこの関数を
 * 通す。UI・server action・API route・worker・retry・直接呼び出しの
 * どれから来ても、同じ1箇所で止まる。
 *
 * ── 既定値が「無効」である理由 ──────────────────────────────────
 *
 * 環境変数が未設定のときに送信できてしまう設計だと、設定を1つ忘れた
 * 環境で本番送信が起きる。既定は常に無効で、**明示的に有効化した場合
 * だけ**送信できる。Stagingであっても実顧客へ届くトークンが存在する
 * 以上、この既定を緩めない。
 *
 * ── 将来の有効化 ────────────────────────────────────────────────
 *
 * 利用者が明示的に許可した時点で、サーバー環境変数
 *
 *     LINE_OUTBOUND_ENABLED=true
 *
 * を設定すればコード変更なしで有効になる。値の解釈は厳密で、
 * "true"(前後空白と大文字小文字は許容)以外はすべて無効として扱う
 * —— "1" や "yes" を通すと、意図しない値で有効になる余地が増える。
 */

export const LINE_OUTBOUND_FLAG = "LINE_OUTBOUND_ENABLED";

/** 送信が拒否されたことを表す専用のエラー。呼び出し側が「設定の問題」と区別できるようにする。 */
export class LineOutboundDisabledError extends Error {
  readonly code = "OUTBOUND_DISABLED";
  constructor() {
    super("現在テスト中のため、LINEへの送信は無効になっています。送信は行われていません。");
    this.name = "LineOutboundDisabledError";
  }
}

/**
 * LINEへの実送信が許可されているか。
 *
 * 毎回 process.env を読む(モジュール読み込み時にキャッシュしない)。
 * キャッシュすると、テストで一時的に切り替えたときや、将来の設定変更が
 * プロセス再起動まで反映されない ——「無効にしたはずなのにまだ送れる」
 * という最悪の方向へ倒れうる。
 */
export function isLineOutboundEnabled(): boolean {
  return (process.env[LINE_OUTBOUND_FLAG] ?? "").trim().toLowerCase() === "true";
}

/** 無効なら例外。外部HTTPリクエストを出す直前に必ず呼ぶ。 */
export function assertLineOutboundAllowed(): void {
  if (!isLineOutboundEnabled()) throw new LineOutboundDisabledError();
}

/** UIへ渡す表示用の状態(クライアントへはこの真偽値と文言だけを渡す)。 */
export interface LineOutboundStatus {
  enabled: boolean;
  /** 無効時に画面へ出す日本語の説明。 */
  message: string;
}

export function getLineOutboundStatus(): LineOutboundStatus {
  const enabled = isLineOutboundEnabled();
  return {
    enabled,
    message: enabled
      ? "LINEへの送信が有効です。"
      : "現在テスト中のため、LINEへの送信は無効です。返信案の作成・下書き保存は行えます。",
  };
}
