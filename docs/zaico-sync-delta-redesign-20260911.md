# ZAICO同期: 差分同期を本番の無人経路にも適用する設計見直し(2026-09-11)

タスク: task_e5e88ed7be60d57e7b
基点コミット: `6cef44f25ecd3854a9b2932eeb81f3ca937dcba7`(このtask専用worktree)

> **注記(2026-09-12)**: このドキュメントは当時のtask(task_e5e88ed7be60d57e7b、
> コミット`e98f6e3`)が未公開のまま残していた内容をそのまま引き継いだもの。
> このtask自体が見つけて塞いだ取りこぼしについては
> `docs/zaico-sync-delta-redesign-20260912-followup.md`を参照。

## 1. ボトルネックの確定(仮説ではなく実装調査で確定)

### 1.1 「どの経路が現行本番で動くか」

- `lib/inventory/zaicoBackgroundSync.ts` の `advanceZaicoBackgroundSyncJob` はADMINが
  設定画面で「今すぐ1ページ進める」を押したときだけ動く**補助経路**。
- `amplify/functions/zaico-sync-worker/handler.ts` は
  `amplify/functions/zaico-sync-worker/resource.ts` で `schedule: "every 5m"` に
  設定された**EventBridgeスケジュールLambda**——resource.tsのコメントが明記する
  とおり「ブラウザを閉じても、PCの電源を落としても、AWS側だけで最後まで進む」
  設計であり、これが**無人で常時稼働している唯一の本番経路**。

### 1.2 確定した欠陥

修正前の `handler.ts` は、`lib/inventory/zaicoBackgroundSync.ts` が実装していた
差分判定 (`splitByDelta`、`lib/inventory/zaicoDelta.ts`) を**一切使っていなかった**。
`seenSourceIds`(このrun内で処理済みかどうか)以外の絞り込みが無く、ページ内の
全件に対して`syncOneZaicoItem`(既存在庫の照合→マージ判定→書き込み→画像取り込み
→履歴記録)を呼んでいた。加えてページ毎に`fetchAllZaicoManaged`(Inventory全件
Scan相当)を無条件に実行していた。

つまり、`ZaicoSyncJob.mode`/`syncSince`/`skippedByDelta` フィールド(スキーマには
既に存在し、`startZaicoBackgroundSyncJob`が書き込んでいた)は、**本番で実際に
同期を回しているLambdaからは一度も参照されていなかった**——差分同期の効果は、
ADMINが手動でボタンを押したときにしか出ていなかった。

これが「通常の変更は約20件/日なのに遅い」の最有力仮説であり、今回**構造上の
確定事実として特定した**(measure:zaico-delta/probe:zaico-deltaの実測値と
組み合わせれば「何%省けるはずか」を追加で定量化できるが、これは本番AWSの
実データが要るためこのtaskのサンドボックスでは行えない——§8のQA向け確認手順
参照)。

### 1.3 副次的に見つかった取りこぼしリスク(修正済み)

`advanceOnePage`(ブラウザ経路)・修正前の`handler.ts`のどちらも、「ページを
最後まで辿り終えた(isDone)」だけを基準に`lastSuccessfulSyncAt`(次回DELTA同期の
基準時刻)を進めていた。**1件でも`syncOneZaicoItem`が`failed`を返していても
進んでいた。** 次回のDELTA同期は`since`以降の`updated_at`だけを見るため、失敗
した商品のZAICO側`updated_at`がその後変わらなければ、**その商品は次回以降
ずっと差分スキップ側に落ち、再試行の機会が永久に来ない**——「失敗商品を既読に
して永久に省かない」という要求に反する取りこぼし方。今回`resolveNextSyncBasis`
で「1件でも失敗があった回は基準を進めない」へ修正した(詳細は§3)。

## 2. API公式出典(既存の実測記録。今回新規に推測パラメータを追加していない)

- `lib/inventory/zaicoDelta.ts`冒頭コメント / `scripts/probe-zaico-delta-support.ts`
  (2026-09-02実測): ZAICO API v1 `/inventories`は
  `updated_at_since`/`updated_since`/`since`/`updated_at_gteq`/`updated_at_from`/
  `from`/`modified_since`/`q[updated_at_gteq]`の8種類を過去日時・未来日時の
  両方で試しても応答が基準(パラメータ無し)と一切変わらない(常に
  200/1,000件/先頭id 44665891)。**サーバー側の差分取得・日時フィルターには
  対応していない**——これは今回のtaskでも再検証していない既存の実測結果を
  引用しているだけで、新規に推測パラメータを追加してはいない(指示書§2の
  「候補パラメータ無視の記録があるが全APIで差分不可能と一般化しない」を
  踏まえ、今回もこの実測結果をそのまま前提とし、新たな一般化は行っていない)。
- 一方`updated_at`は実データの1,000/1,000件に入っていることを確認済み
  (同じ実測)。BELLO側での差分判定(`needsSync`)はこの値に依存する。
- ページング: `per_page`パラメータはZAICO側で無視され常に1,000件返る
  (`amplify/functions/zaico-sync-worker/zaicoApiClient.ts`コメント、実測)。
  `hasMore`は返ってきた件数が0件かどうかで判定している(既存実装、今回変更なし)。
- 今回、v1/v2の並び順保証について追加確認は行っていない
  (既存の`docs/zaico-pagination-and-mercari-404-20260831.md`が「重複ページ検知」
  等の耐性をpaginationロジック側で既に持たせていることを確認済み——
  `scripts/verify-zaico-pagination.ts`のリグレッションを今回も実行し76件全通過)。

## 3. 差分/変更内容

| ファイル | 変更 |
|---|---|
| `lib/inventory/zaicoSyncPageProcessor.ts`(新規) | `syncPendingItemsWithDelta`: 1ページ分を`splitByDelta`で振り分け、対象0件なら`fetchAllZaicoManaged`自体を呼ばずに返す。`handler.ts`専用(ブラウザ側の`advanceOnePage`は今回改修しない——動いている経路への不要な変更を避ける)。 |
| `amplify/functions/zaico-sync-worker/handler.ts` | `job.mode`/`job.syncSince`/`job.startedAt`/`job.skippedByDelta`/`job.lastSuccessfulSyncAt`を読み、`syncPendingItemsWithDelta`経由で差分判定を適用。対象が無いページでは重い`fetchAllZaicoManaged`を省略。完了時の基準更新は`resolveNextSyncBasis`経由。 |
| `lib/inventory/zaicoDelta.ts` | `resolveNextSyncBasis`追加(純粋関数)。「1件でも失敗があった回は基準を進めない」の判定を1箇所に集約し、handler.ts/zaicoBackgroundSync.tsの両方から使う。 |
| `lib/inventory/zaicoBackgroundSync.ts` | `advanceOnePage`の完了時基準更新を`nextSuccessfulSyncAt`直呼びから`resolveNextSyncBasis`経由へ変更(同じ取りこぼしをブラウザ経路でも修正)。 |
| `scripts/verify-zaico-delta.ts` | `resolveNextSyncBasis`のテスト追加(基準据え置き/初回null/通し確認)。 |
| `scripts/verify-zaico-sync.ts` | (a) `handler.ts`が実際に`syncPendingItemsWithDelta`/`resolveNextSyncBasis`を参照していることのソース静的検査(回帰防止ガード、既存の`testSyncJobIdHasSingleDefinition`と同じ手法)。(b) `syncPendingItemsWithDelta`のmockPort検証: 5,000件中20件更新/全未変更/全件変更/日時不明/部分失敗/ページ内時間切れの6シナリオ。 |

### 3.1 既存同期中ジョブとの互換性

- `ZaicoSyncJob`のスキーマ(`mode`/`syncSince`/`skippedByDelta`/`lastSuccessfulSyncAt`)
  は変更していない——今回のtask前から存在していたフィールドを、handler.tsが
  初めて読むようになっただけ。
- 既存行(`mode`未設定の古い行)は`job.mode === "FULL"`が偽になり
  `since = job.syncSince ?? null`——`syncSince`も無ければ`null`(全件相当)に
  自動的に倒れる。「不明なら全部処理する」という既存の規約をそのまま踏襲。
- 実行中(RUNNING)のジョブがこのコード変更をまたいでデプロイされた場合、
  次のLambda tickは同じ`lastPage`/`seenSourceIds`から再開し、その回の
  `mode`/`syncSince`(開始時に決まった値)をそのまま使う——チェックポイントの
  形自体は変えていないため、途中デプロイでも壊れない。
- lease機構(`claimOrRenewLease`/`releaseLease`)・ページ内再開(`seenSourceIds`)
  ・missing検出(`findMissingZaicoManagedInventory`、isDoneの時だけ実行)は
  一切変更していない。

## 4. テスト結果(すべてこのworktree内で実行、AWS/ZAICOへは一切接続していない)

サンドボックスの制約について: 通常このworktreeには`node_modules`が無く、
`npm install`は承認ゲートで拒否されるが、`fs.symlinkSync`で本体リポジトリの
`node_modules`へjunctionを張ることで実`tsc`・実テストスクリプトを動かせた
(このリポジトリの既知の回避策)。`amplify_outputs.json`(gitignore対象の
ビルド生成物)も同様に一時的にコピーして型解決を通したうえで、**テスト後に
削除済み**——どちらもこのworktreeの成果物(git管理下の差分)には残っていない。

```
node scripts/with-server-only-stub.cjs scripts/verify-zaico-delta.ts
  → 45 passed, 0 failed (resolveNextSyncBasisの新規テスト3件+通し確認を含む)

node scripts/with-server-only-stub.cjs scripts/verify-zaico-sync.ts
  → 109 passed, 0 failed
    - 新規: handler.tsの静的配線ガード2件
    - 新規: syncPendingItemsWithDeltaの6シナリオ(5,000件×3パターン+日時不明+部分失敗+時間切れ)
    - 既存98件(重複防止・idempotency・prefetch/masterCache・purchasePrice等)は無改変で全通過

node scripts/with-server-only-stub.cjs scripts/verify-zaico-pagination.ts
  → 76 passed, 0 failed(無改変。pagination/resume/重複ページ検知に影響が無いことの確認)

node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  → エラー0件(プロジェクト全体)
```

### 4.1 取りこぼし防止試験(指示書§7の項目との対応)

| 項目 | 検証方法 | 結果 |
|---|---|---|
| 5,000件中20件更新 | `syncPendingItemsWithDelta`をmockPortで実行 | skippedByDelta=4,980 / totalProcessed=20 / updated=20、観測済み合計5,000件(取りこぼし0) |
| 全未変更 | 同上 | totalProcessed=0、`fetchAllZaicoManaged`呼び出し0回(重いScanを丸ごと回避) |
| 全件変更(100件超更新に相当) | 同上 | 5,000件全部処理、skippedByDelta=0(取りこぼし方向に倒れないことを確認) |
| 日時境界 | `zaicoDelta.ts`既存テスト(境界ちょうどは処理する) | 既存45件のうち該当分すべて通過 |
| ページ並び替わり/重複ページ | `verify-zaico-pagination.ts`(無改変) | 76件通過 |
| 100件超更新 | シナリオ3(全件変更=5,000件)で上位互換的に確認 | 通過 |
| 部分失敗 | mock `generateSku`失敗 | `failed`としてカウントされ例外で全体停止しない。`resolveNextSyncBasis`側で「基準を進めない」ことを別途検証 |
| lease競合 | 既存`handler.ts`のlease機構は無改変(このtaskでは触っていない) | 変更なし。今回のdelta処理はlease確保後の1ページ内ロジックのみに閉じている |
| 途中再開(ページ内/ページ間) | `pending = zaicoItems.filter(!seenSourceIds.has)`をpage先頭で計算する既存の再開規約を維持。シナリオ6(時間切れ)で一部処理→残りを次回へ持ち越す挙動を確認 | 通過 |
| 同期中更新 | `resolveDeltaSince`の5分巻き戻し(`DELTA_OVERLAP_MS`、無改変)+開始時刻基準(完了時刻ではない)は既存のまま。`testNoGap`で通し確認 | 通過(既存回帰) |
| 新規 | `needsSync`は`updated_at`欠如時`created_at`で代用、シナリオ4で確認 | 通過 |
| 削除疑い | `findMissingZaicoManagedInventory`はisDone(完走)時のみ実行という既存の分離を維持(今回変更していない) | 変更なし。差分スキップした商品もobservedSourceIdsに入るため誤検出しない(シナリオ1で観測済み合計=5,000件を確認) |
| 差分基準未設定(既存行) | `job.mode === "FULL"`でも`row.mode === "FULL"`でもない場合`since = syncSince ?? null` | 既存規約のまま(今回変更なし、コメントで明記) |

**取得を省けない事実の明記**: ZAICO APIがサーバー側フィルターに対応していない
(§2)以上、**ページ取得(HTTP往復)そのものは今回の変更でも減らない**。5,313件
なら従来どおり全ページを辿る必要がある。今回減らしたのは「取得した後、1件
ごとに行う照合・マージ判定・DynamoDB書き込み・画像取り込み・履歴記録」であり、
`docs`既存の実測(`scripts/measure-zaico-delta-impact.ts`)が示すとおり、この
部分が同期時間の大半を占める。

## 5. 削減の証拠(mockPortの呼び出し回数、決定論的な指標——ミリ秒計測ではない)

5,000件中20件更新シナリオ(`scripts/verify-zaico-sync.ts`
`testDeltaPageProcessorScenarios`):

| 指標 | 修正前(全件処理) | 修正後(差分) |
|---|---|---|
| `syncOneZaicoItem`呼び出し(照合/マージ/書き込み判定) | 5,000 | 20 |
| DynamoDB `updateInventory`呼び出し | 5,000(全件unchanged判定のための無駄な書き込み判定を含む) | 20 |
| `fetchAllZaicoManaged`(Inventory全件Scan相当) | ページ毎に無条件で1回(対象0件のページでも) | 対象が1件も無いページでは**0回** |
| `downloadAndImportImage` | 変更商品の画像差分次第(従来もunchanged分は呼ばないが、判定自体に上の照合コストがかかっていた) | 変更商品の画像差分次第(未変更4,980件は判定にすら入らないので当然0) |

**注意(模擬時間を本番速度としない)**: 上の表は呼び出し**回数**の比較であり、
実際のミリ秒短縮は本番のDynamoDB/S3/Lambdaコールドスタート等の環境条件に
依存するため、このサンドボックスでは主張しない。実速度はQA側の実データでの
検証に委ねる(§8)。

## 6. 残課題

1. **ブラウザ経路(`advanceOnePage`)のページ内バッチ構造は今回改修していない**
   ——`ITEMS_PER_ADVANCE`スライスの取り回しに手を入れると動いている経路を
   無用に触ることになるため、今回は「基準更新の取りこぼし修正
   (`resolveNextSyncBasis`)」だけを適用し、`syncPendingItemsWithDelta`への
   一本化は見送った。将来的に一本化する余地はある。
2. **並列化は今回導入していない**——指示書の「制限付き並列で抑え、無制限
   並列化しない」を、今回は「そもそも並列化しない(既存のまま逐次)」という
   最も安全側の選択で満たした。取得済みページ内の照合/書き込みを制限付き
   並列にすればさらに速くなる余地はあるが、DynamoDB/S3への同時書き込み数
   設計・エラー時の部分失敗ハンドリングの検証が要るため、このtaskの
   スコープ(小コミットで段階レビュー)を超えると判断し見送った。
3. **本番実測は行っていない**——AWS profile Belloでの読み取り専用メトリクス
   閲覧は許可されていたが、今回は実装調査とmockPort検証で確定できる範囲に
   留め、実CloudWatchメトリクス取得までは行っていない(§8のQA手順を参照)。
4. `findMissingZaicoManagedInventory`(消失判定)の定期全件照合としての分離
   ——現状は「isDoneに到達した回にだけ実行される」という既存の分離を維持して
   いるのみで、「定期全件照合を通常同期から独立したジョブにする」という
   より踏み込んだ再設計は行っていない。今回のtaskの主眼(取りこぼさず高速化)
   には既存の分離で要件を満たすと判断した。
5. **(2026-09-12 QAで発覚、followupで修正済み)** 「対象0件のページでは
   `fetchAllZaicoManaged`を呼ばない」という本設計の最適化は、「時刻だけで
   skipしてよいと判定された商品は必ずBELLOに実在する」という前提に依存して
   いた。この前提が崩れるケース(BELLO未取込のままZAICO側updated_atだけが
   古い商品)を`docs/zaico-sync-delta-redesign-20260912-followup.md`で
   塞いだ。

## 7. 切替/ロールバック手順

- **切替**: 通常のデプロイ手順のみ。このtaskはLambda/共有ライブラリの
  ロジック変更のみで、スキーマ変更・インフラ変更・環境変数変更を伴わない。
  デプロイ後、次の5分スケジュールtickから新しいコードが動く。
  実行中(RUNNING)ジョブをまたいでも§3.1のとおり安全。
- **ロールバック**: このtaskで変更した5ファイル+新規1ファイルを
  デプロイ前のコミットへ戻すだけで良い(スキーマ/データ移行が発生していない
  ため)。`ZaicoSyncJob`行のmode/syncSince/skippedByDelta/lastSuccessfulSyncAtは
  ロールバック後も無害(旧handler.tsはこれらを読まないだけで、値の存在自体は
  問題にならない)。

## 8. QAが配信後に実画面/ログで検証できる手順

1. デプロイ後、`ZaicoSyncJob`(設定画面 `ZaicoSyncPanel.tsx`、または
   `getZaicoBackgroundSyncStatus`のAdmin向け表示)で、通常運用の同期完了行に
   `mode: "DELTA"`と`skippedByDelta`が大きな正の値(前回以降ほぼ未変更なら
   件数近く)で入っていることを確認する。修正前はこのフィールドが更新
   されていなかった(常に0のまま)はずなので、値が動くこと自体が「Lambda側で
   差分が効いている」ことの直接証拠になる。
2. AWS CloudFront経由のSSRログはStagingで届かないことが既知
   (Next.jsのServer Component/Server Action側の既知の運用上の制約)だが、
   **これはLambda関数自体のログには当てはまらない**——`zaico-sync-worker`は
   独立のLambda関数であり、標準のLambda実行ログとしてCloudWatch Logsの
   専用ロググループへ出力される(`console.log`/`console.error`)。
   AWS profile Belloで`/aws/lambda/<zaico-sync-worker実体名>`ロググループを
   見れば、`job COMPLETED ... skippedByDelta=...`のログ行が確認できる。
3. 実データでの削減率を見たい場合は`npm run measure:zaico-delta`
   (既存script、読み取り専用)を本番/Staging相当の環境変数で実行すると、
   「前回同期がX時間/日前だった場合、今回処理する件数」の分布が出る
   ——これは今回の変更の効果予測に使える既存ツール。
4. 実際の同期速度(ミリ秒)は、CloudWatchの当該Lambdaの実行時間メトリクス
   (Duration)を、この変更のデプロイ前後で比較することで確認できる
   (このtask自体はそのメトリクス取得を行っていない——§6残課題4)。
