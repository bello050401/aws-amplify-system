# 実接続の進捗と自動再開

2026-09-16 11時台 JST。前回のstatus.mdを更新する追加記録。

## 進んだ内容

- 既存ClaudeRunner、IndependentVerifier、AmplifyStaticDeliveryを協調engineへつなぐ `existingAdapters.mjs` を実装。
- 独立テスト後は許可されたファイルだけを既存Git安全入口からcommit。Agent自身にはcommit/deployさせない。
- GPTデスクトップworkerとのrun・phase・期限付き応答bridgeを追加。Agentへコード全文を転送せず、仕様とQA結果で連携。
- 単体試験では実ファイル変更、独立Nodeコマンド、commit、結果照合・再利用を確認。全体192件成功。
- 実AWS read-only preflightで専用アプリ／ブランチの隔離を確認。
- GPTが実ブラウザで旧マーカー `BELLO E2E VERIFIED 20260916` を確認。AWS activeJobIdは `0000000001`。
- 初期QAのFAILと仕様を実際のrunに提出し、実ClaudeRunnerを起動した。

## 現在の停止理由

Claude Codeは認証済みだが週間利用枠が不足。実出力はHTTP429、input/output tokens各0、`You've hit your weekly limit · resets 7pm (Asia/Tokyo)`。

別モデル・別アカウントへの迂回、追加API課金は行っていない。ステージングへの新しいデプロイもまだ行っていない。

利用枠不足を論理失敗と誤分類した不具合を修正。`WAITING_CAPACITY`へ訂正し、誤って増えた修正回数だけを証拠付きで訂正した。元の履歴とAgent出力は全保持。現runは `eco_9a7694f2b4634115931f805d670933ac`、データは `C:/Users/win/Documents/Codex/bello-eco-live-20260916`。

## 再開

Codexの同じタスクへ19:05 JSTに戻るheartbeatを登録（automation id: `bello`）。完了時に停止する。ユーザーの「続けて」は不要。PCとCodexが実行可能であることが必要。

古いrunの壁時計予算・bridge期限は延長せず、新しい有限の実行枠を使う。たとえば同じworktreeのtoolディレクトリから、`BELLO_ECO_LIVE_ROOT=C:/Users/win/Documents/Codex/bello-eco-live-20260916-after-reset` を環境変数に設定して `node test/manual/eco-live.mjs`。過去rootは変更・削除しない。

同じ環境変数を指定して `node test/manual/eco-submit-desktop.mjs <phase> <input.json>` で、実観測後のQA／仕様を返す。phaseはqaInitial/specification/qaVerify。入力サンプルは元rootのinitial-qa-input.jsonとspec-input.jsonにあるが、QA観測は新しく行い、古い観測を新しい合格証拠としてコピーしない。

成功後はHTTPの内容hashと実画面の新マーカー・再読込を確認し、QA_VERIFYからCOMPLETED_STAGINGまで記録する。19時以降も枠不足なら待機を維持する。毎日の待機通知はしない。

## 残る区別

- デスクトップbridgeはこのCodexセッションが担当する実worker。常時稼働する独立GPTサービスではない。
- 主サービスのコードへ反映しても、協調モードを主DBで有効化するmigrationは別工程。未承認の稼働DB migrationは実行しない。
- cache／全メトリクス／承認UIなど、status.mdの未完項目は実E2E成功と混同しない。

## 主サービスへのコード反映（11:14 JST確認）

主ブランチ `claude/inventory-management-system-5vbvc7` に `80d073b` と `356a491` を取り込み、安全停止後に既存Scheduled Taskで再起動した。HTTP healthはok、pauseは再起動前後ともfalse。新しい設定画面の表示を実ブラウザで確認した。

既存未コミット `docs/health/final-tests.md` のSHA256は引き続き `A9DD1EA3A5C3878F9AD6B0A3E7302398229CD57E3FDE554F7DDDCD88261A3CF0`。主DBのeco追加schemaは未適用（installed=false）、協調モードは無効のまま。**コード反映済みと、機能有効化／実E2E完了は別である。**

ユーザーに必要な現時点の操作はない。利用枠解除後に自動再開し、承認境界に達した場合だけ具体的な適用内容をまとめて確認する。
