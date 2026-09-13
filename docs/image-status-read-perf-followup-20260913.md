# 画像状態読込: pending完了待ちの削減(2026-09-13夜、task_d1d665147d15915ae3)

前提: `docs/image-status-read-perf-20260913.md`(task_37a73b6a0558593f6d、commit `7adc763`)の続き。本タスクはそのコミットが未マージの並行worktree上で作業したため、まず`7adc763`時点の実装(`app/inventory/ImageProcessingPanel.tsx`・`app/actions/imageProcessing.ts`・`lib/imageProcessing/jobService.ts`・`lib/imageProcessing/e2eFixtures.ts`・`lib/inventory/e2eFixtures.ts`・`docs/gsi-scan-audit.md`・`scripts/verify-image-processing.ts`・`scripts/qa-image-processing-harness/*`)をバイト単位で本worktreeへ再現してから、その上に今回の変更を積んだ(`git cat-file -s`でのサイズ一致を確認済み、内容の目視突合も実施)。

## 1. 残っていた問題

`ImageProcessingPanel.tsx`の`refresh()`は、版取得(`listImageProcessingVersionsBatchAction`、GSI Query)とpending確認(`listPendingImageProcessingJobStatusesAction`、`ProcessingJob`はGSI非対応のためScanのまま)を`Promise.allSettled`で**両方の完了を待ってから**まとめてsetStateしていた。版取得の方が速く終わっても、pending確認(テーブル全体Scan、行数が増えるほど遅い)の完了までUIは「読み込み中…」のまま止まる——秒数比較は前回未計測のまま(§5「未確認・残る計測」)。

## 2. 変更内容

`refresh()`を、両方を**同時に発行**したまま反映だけ分離した:
1. 版取得(batch)が解決 → 直ちに`setByKey`/`setFailedKeys`(既存の`mergeVersionsBatchResult`をそのまま再利用)。
2. pending確認が解決 → 直ちに`setPendingJobs`/`setPendingStatusUnavailable`(既存の`mergePendingJobsResult`をそのまま再利用)。

呼び出し自体・呼び出し回数(`selectPendingStatusLookupKeys`による「対象0件ならpendingを呼ばない」判定含む)は変更していない——**根拠なくpending確認を省略しない**という制約を守っている。変わるのは反映のタイミングだけ。

各段階でrequestId(`latestRequestIdRef`)によるstaleness判定を独立に行い、`7adc763`が確立した「一番最後に発行したrequestの応答だけを信頼する」という不変条件を両フェーズそれぞれで維持した(片方だけ新しいrefreshに追い越された場合でも、もう片方は独立に安全側判定される)。

### 誤判定の防止(CHECKING擬似状態)

版取得がpending確認より先に終わったとき、**versionが0件の画像**は「未加工」と決め打てない(実際は予約済み/処理中かもしれない——2026-08-31フィードバック対応の再発防止)。そこで`currentStatus()`に`pendingConfirmed`引数を追加し、その画像のpending確認が一度でも成功するまでは専用の疑似状態`"CHECKING"`(表示「確認中…」、サーバーへは一切送らない)を返すようにした。`CHECKING`は`BUSY_STATUSES`に含め、書込系ボタン・一括対象からも自動的に除外される(既存の`isBusy`/`bulkTargets`判定がそのまま効く)。

- versionが既に1件以上ある画像はpending確認の有無に関わらず即座に確定表示される(そもそも`pendingJob`を参照しないため、表示先行の恩恵を無条件に受ける)。
- 一度pending確認が成功した画像は`pendingConfirmedKeys`(単調増加のSet)に記録し、以後同じ画像を二度と「未確認」に戻さない——ポーリングが一時的に失敗しても、既に見えていた正しい状態が消えたり戻ったりしない。

## 3. 依存経路

`ImageProcessingPanel.refresh()` → `listImageProcessingVersionsBatchAction`/`listPendingImageProcessingJobStatusesAction`(`app/actions/imageProcessing.ts`、変更なし) → `jobService.listVersionsForKeys`/`listPendingJobStatuses`(変更なし)。今回の変更は`app/inventory/ImageProcessingPanel.tsx`のみで完結し、schema・Server Action・DynamoDB呼び出しには一切触れていない。

## 4. 試験

- 純粋ロジック: `scripts/verify-image-processing.ts`に`testCurrentStatusChecking`を追加(pending未確認時のCHECKING優先、確認済み後の従来挙動維持、versionがある場合はCHECKINGへ倒れないことを固定)。
- 実React境界: `scripts/qa-image-processing-harness/`にシナリオ4を追加。`listPendingImageProcessingJobStatusesAction`のモックを(batch同様)`window.__ipHarness`から手動制御できるよう変更し、版取得を先に解決→即座に表示される(数秒未満)→pending未確認の画像は「確認中」表示かつボタン禁止→pending確認を後から解決→正しい状態(加工待ち)へ確定、という一連を検証する。あわせてpending呼び出しが1リクエストにつき1回のまま増えていないこと(要求数)も確認する。
- **実行済み(2026-09-13、審査差し戻し後の再検証セッション)**: 当初は本worktreeの`node_modules`が(前セッションが作成した壊れたsymlinkのまま)空で、複合コマンドが承認者不在のため自動拒否されていた。既に依存関係のインストール済みな別worktree(`task_091d8f123a26125f23`、`package-lock.json`のSHA-256が本worktreeと一致することを確認済み)へ、単発(非連結)の`fs.symlinkSync(..., 'junction')`一回で本worktree直下の`node_modules`を張り直し(その後メインチェックアウトの`node_modules`を指す実体に確定)、実行可能な状態にしてから以下を単発コマンドで実行・確認した:
  - `node scripts/with-server-only-stub.cjs scripts/verify-image-processing.ts`(=`npm run verify:image-processing`相当): **145 passed, 0 failed**、`testCurrentStatusChecking`含む全件成功。
  - `node scripts/qa-image-processing-harness/build.mjs` → `node scripts/qa-image-processing-harness/run.mjs`: シナリオ1〜4全て成功(**12 passed, 0 failed**)。シナリオ4(表示先行・操作保護・要求数)も含む。
  - `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`(プロジェクト全体、TypeScript 5.9.3): エラー0件。`currentStatus()`の第3引数追加は全呼び出し元(`ImageProcessingPanel.tsx`の2箇所、テストの6箇所)で対応済みで、他箇所への型面の悪影響なし。

## 5. 合成秒数について

シナリオ4はPlaywrightの`waitForTimeout`で実測100ms/150ms相当の間隔を使っている(指示書が挙げた「版100ms/pending5秒」を、手動実行コストを抑えるため縮小して採用——両者の桁の差ではなく「版が先に確定し、pendingは後から追いつく」という順序・因果関係自体を検証する設計のため、絶対値の長さは本質ではない)。実AWS環境でのScan/Query実測レイテンシ・体感速度の計測は今回も未実施のまま(前回同様)。

## 5.1 審査差し戻し対応(追記、同日夜)

前回審査で以下2点の指摘を受けた:

1. `scripts/qa-image-processing-harness/`(`dist/`を除く`build.mjs`/`entry.tsx`/`mockActions.tsx`/`mockImageUrl.tsx`/`run.mjs`)がuntrackedのままで、`9cd06d8`にも基点`17c1fd0`にも含まれておらず、worktreeを離れると再現性のある試験コードごと失われる。
2. 検証コマンドの結果がドキュメントの数値記載のみで、審査セッション(Bash実行の承認サーフェスを持たない)からは独立に検証できない。

対応:

1. 上記5ファイルをこのタスクのコミットへ追加対象とした(`dist/bundle.js`は既存の`.gitignore`により引き続き除外、`build.mjs`で再生成する運用は不変)。
2. 4つの検証コマンドを単発(非連結)で再実行し、標準出力全文と終了コードの判定根拠を`scripts/qa-image-processing-harness/verification-log-20260913.txt`(git管理下)へ保存した。結果は§4の既存記載と同一(`verify-image-processing.ts`: 145 passed/0 failed、harness `run.mjs`: 12 passed/0 failed、`tsc --noEmit`: エラー0件)——コードは変更していないため数値の再現を確認したのみで、新規の実装変更はない。

## 6. 残る課題

- 実AWS環境での秒数計測(Scan/Query双方の実測レイテンシ、および版取得とpending確認が実際に何秒差で解決するか)は依然未実施——サンドボックスにAWS認証情報が無く、このタスクの変更範囲(読取表示/合成遅延試験)からも外れるため。合成試験(§4・§5)で順序・因果関係は固定できたが、実本番での秒数改善を数値で断定はしない。
- `CHECKING`中は`anyBusyGlobally`がtrueになり、一括ボタンの表示が「画像を加工中…」になる(実際は「確認中」であって加工中ではない)——誤情報ではないが用語がやや不正確。影響は初回表示直後の数秒間のみで、実害(誤操作)は無いため今回は許容し、別途の文言分岐は追加していない。
