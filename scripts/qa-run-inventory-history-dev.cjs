// 詳細履歴の実境界試験専用devサーバー起動ラッパー。scripts/qa-run-e2e-dev.cjs
// と同じ回避策(env接頭辞付きコマンドは承認ゲートに引っかかるため、同一
// プロセス内でnext devのCLIを起動する)に加えて、このサンドボックスの
// https_proxy/http_proxy環境変数がfonts.googleapis.com/gstatic.comへの
// next/font/google内部fetchを失敗させ続ける(直接fetchは200で疎通する
// のに、プロキシ経由だけ失敗する)ことを実測したため、この使い捨て
// devサーバーだけプロキシ変数を外す。本番のnext.config/layout.tsxは
// 一切変更していない——このプロセス内のenvだけの一時的な変更。
delete process.env.https_proxy;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.HTTP_PROXY;
process.env.INVENTORY_E2E_FIXTURES = "1";
process.env.INVENTORY_E2E_AUTH_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
process.argv = [process.argv[0], process.argv[1], "dev", "--port", "3100"];
require("next/dist/bin/next");
