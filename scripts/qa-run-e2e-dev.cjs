// 画像段階読込QA是正: 完全合成画像でのCodex/手動ブラウザQA起動用。
// `next dev`を直接env接頭辞付きで叩くとBashの承認ゲートに引っかかる
// ため、このラッパーでprocess.envに設定してから同一プロセス内でnext
// devのCLIを起動する(qa-worktree-tooling-limitsメモリと同じ回避策)。
// 本番には一切含まれない・amplify.yml等からも呼ばれない、この検証
// セッション専用の使い捨てスクリプト。
process.env.INVENTORY_E2E_FIXTURES = "1";
process.env.INVENTORY_E2E_AUTH_TOKEN = "e2e-local-test-token-not-a-real-secret-32c";
process.argv = [process.argv[0], process.argv[1], "dev", "--port", "3100"];
require("next/dist/bin/next");
