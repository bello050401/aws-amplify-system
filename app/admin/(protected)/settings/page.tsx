import { isBaseConnected } from "@/lib/base/oauth";
import { disconnectBaseAction } from "@/app/actions/base";

interface Props {
  searchParams: { connected?: string; error?: string };
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "BASE側で連携が許可されませんでした。",
  invalid_state: "連携の検証に失敗しました(セッション切れの可能性があります)。もう一度お試しください。",
};

export default async function SettingsPage({ searchParams }: Props) {
  const connected = await isBaseConnected();

  return (
    <div className="max-w-lg">
      <h1 className="text-lg font-normal text-ink">BASE連携設定</h1>

      {searchParams.connected && (
        <p className="mt-4 border border-line bg-stone px-4 py-3 text-sm text-ink">
          BASEとの連携が完了しました。
        </p>
      )}
      {searchParams.error && (
        <p className="mt-4 border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {ERROR_MESSAGES[searchParams.error] ?? `連携に失敗しました: ${searchParams.error}`}
        </p>
      )}

      <div className="mt-8 border border-line p-6">
        <p className="text-sm text-ink">
          状態:{" "}
          <span className={connected ? "text-ink" : "text-muted"}>
            {connected ? "接続済み" : "未接続"}
          </span>
        </p>
        <p className="mt-2 text-xs text-muted">
          接続すると、BASEショップの商品検索・情報取得が実データで行われるようになります。
        </p>

        <div className="mt-6">
          {connected ? (
            <form action={disconnectBaseAction}>
              <button
                type="submit"
                className="border border-line px-5 py-2 text-xs uppercase tracking-label text-muted hover:text-ink"
              >
                連携を解除する
              </button>
            </form>
          ) : (
            <a
              href="/api/base/oauth/start"
              className="inline-block bg-ink px-5 py-2 text-xs uppercase tracking-label text-white"
            >
              BASEと接続する
            </a>
          )}
        </div>
      </div>

      <p className="mt-6 text-xs text-muted">
        BASE_USE_MOCK=false の場合、未接続のまま商品検索を行うとエラーになります。
      </p>
    </div>
  );
}
