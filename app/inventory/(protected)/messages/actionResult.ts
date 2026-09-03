/**
 * Server Action の戻り値を安全に受け取る。
 *
 * ── なぜ要るか(実際に起きたこと) ────────────────────────────────
 *
 * 画面で「今すぐ取り込む」を押すと
 *
 *     Cannot read properties of undefined (reading 'ok')
 *
 * が出た。原因は Server Action が **undefined を返した**こと。
 * アクセスログで裏を取ると、失敗した操作はデプロイ完了の4分後に、
 * その**前のデプロイで読み込まれたページ**から呼ばれていた。
 * Next.js の Server Action はデプロイごとにIDが変わるため、古いページが
 * 持っているIDはサーバー側に存在せず、呼び出しが解決しない。
 *
 * これは「たまたま今回だけ」ではなく、**デプロイのたびに、開きっぱなしの
 * タブで必ず起こりうる**。呼び出し側で毎回 `res.ok` を直接触っていると、
 * そのたびに TypeError が利用者に見える。原因も対処も分からないメッセージで、
 * 一番困る形になる。
 *
 * ── optional chaining で隠さない ────────────────────────────────
 *
 * `res?.ok` にすると「失敗したのに何も起きない」になり、もっと悪い。
 * **undefined を明示的に「呼び出しが届かなかった」という失敗として扱い、
 * 何をすればよいか(再読み込み)を伝える。**
 */

export type ActionOutcome<T> = { ok: true; data: T } | { ok: false; error: string };

/** Server Action が返すべき形。undefined は「返ってこなかった」を意味する。 */
type MaybeResult<T> = { ok: true; data: T } | { ok: false; error: string } | undefined | null;

const STALE_PAGE_MESSAGE =
  "操作をサーバーへ届けられませんでした。アプリが更新された可能性があります。ページを再読み込みしてから、もう一度お試しください。";

/**
 * `{ok:...}` を返す Server Action を呼ぶ。
 *
 * 戻り値が無い・形が違う場合も含めて、**必ず** ActionOutcome を返す。
 * 例外も同様に握って結果へ変換するので、呼び出し側は分岐だけ書けばよい。
 */
export async function callAction<T>(fn: () => Promise<MaybeResult<T>>): Promise<ActionOutcome<T>> {
  let raw: MaybeResult<T>;
  try {
    raw = await fn();
  } catch (err) {
    // Server Action が見つからない場合、Next.js は例外として投げてくることも
    // ある。どちらの形で来ても同じ扱いにする。
    const message = err instanceof Error ? err.message : String(err);
    if (/Failed to find Server Action|Server Action .* was not found|fetch failed/i.test(message)) {
      return { ok: false, error: STALE_PAGE_MESSAGE };
    }
    return { ok: false, error: message || "操作に失敗しました。" };
  }

  if (raw == null || typeof raw !== "object" || !("ok" in raw)) {
    return { ok: false, error: STALE_PAGE_MESSAGE };
  }
  return raw;
}

/**
 * `{success, message}` を返す Server Action 用(通知Bot系)。
 * 形が違うだけで、undefined を失敗として扱う考え方は同じ。
 */
export async function callMessageAction(
  fn: () => Promise<{ success: boolean; message: string } | undefined | null>,
): Promise<{ success: boolean; message: string }> {
  let raw: { success: boolean; message: string } | undefined | null;
  try {
    raw = await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Failed to find Server Action|Server Action .* was not found|fetch failed/i.test(message)) {
      return { success: false, message: STALE_PAGE_MESSAGE };
    }
    return { success: false, message: message || "操作に失敗しました。" };
  }
  if (raw == null || typeof raw !== "object" || !("success" in raw)) {
    return { success: false, message: STALE_PAGE_MESSAGE };
  }
  return raw;
}
