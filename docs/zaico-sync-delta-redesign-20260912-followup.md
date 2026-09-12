# ZAICO同期差分高速化: BELLO未取込+古い時刻の取りこぼしを塞ぐ追補(2026-09-12)

タスク: task_a320a5430c31975da2
継承元: `e98f6e3079069396470e0318c31bbc2cd0cb69dc`
  (「chore(orchestrator): ZAICO同期の設計見直し：取りこぼしなしで変更分の処理を高速化」、
  未公開・ブランチ`bello/task/task_e5e88ed7be60d57e7b`のみに存在、`main`未マージ)
base(このworktreeの開始コミット): `6a38f1d5278d95e18a834c0b1bf85d7dd968fb77`
公開済み最新(このtask開始時点でのmain想定tip): `3299098a98a289b41131b53b3a76b23762a5ac16`
  (`fix(copy): preserve treatment facts in multiline condition notes` —
  `lib/inventory/conditionPhrasing.ts`/`scripts/verify-listing-description.ts`のみが対象で、
  今回のZAICO同期関連ファイルとは重複しない。このtaskはbase(6a38f1d)からの
  隔離worktreeで作業しており、3299098の内容そのものには一切触れていない——
  「保全」は「このtaskの変更が3299098の変更と衝突/競合しない」という意味で
  満たされている)。

## 1. QAで確認された問題(このtaskの発端)

`docs/zaico-sync-delta-redesign-20260911.md`(§1.2)がその場で確定したとおり、
e98f6e3までの設計は「無人スケジュールLambda(`amplify/functions/zaico-sync-worker/handler.ts`)
が差分同期を一切使っていなかった」という欠陥を塞いだ。しかしQAはさらに、
この修正自体が持ち込んだ**別の取りこぼしリスク**を指摘した:

> `syncPendingItemsWithDelta`は時刻のみで`toProcess`/`skipped`をsplitし、
> 全件がskip側に落ちたページでは`fetchAllZaicoManaged`(BELLO側の実在確認)
> 自体を呼ばない。BELLO未取込だがZAICO側`updated_at`が(前回成功時刻より)
> 古い商品がもし存在すると、その商品は時刻だけを見て「skipしてよい」と
> 誤判定され続け、**存在確認そのものが行われないまま永久にBELLOへ
> 取り込まれない**。

### 1.1 なぜ「自然には回復しない」のか(コード根拠)

- `lib/inventory/zaicoDelta.ts`の`needsSync`は`updated_at`(無ければ`created_at`)
  と`since`の比較だけを行う純粋関数。BELLO側の状態を一切見ない。
- `resolveDeltaSince`は「前回**成功**時刻」を進めるだけで、個々の商品の
  `updated_at`には関知しない——次回の`since`は今回の`since`以上にしか進まない。
- したがって、ある商品のZAICO側`updated_at`が一度`since`を下回ると、その
  商品のZAICO側`updated_at`が将来変わらない限り、`since`はそれよりだけ
  先へ進み続ける一方であり、**`needsSync`は恒久的に`false`を返し続ける**。
- 2026-09-11版の`syncPendingItemsWithDelta`(修正前)は、この`false`判定
  だけで`skipped`側に落とし、`fetchAllZaicoManaged`によるBELLO実在確認
  さえ行わないページでは実在確認の機会そのものが無い。

### 1.2 具体的にどう起こり得るか

「BELLOに一度も取り込まれないままZAICO側`updated_at`が古い」状態は、この
リポジトリの既存コメントが示す既知の不整合パターンから現実に起こり得る:

- `lib/inventory/zaicoSyncPorts.ts`の`releaseSourceLink`コメント: 実際に
  ZAICO ID 48824174が「リンクだけ残りInventoryが無い」状態で取り残された
  実例がある(2026-08-31)。この種の不整合が修正前に発生していた場合、
  該当商品はBELLOに存在しないままZAICO側`updated_at`は当時のまま——
  それ以降の同期はことごとくこの商品を「時刻だけ見てskip」してしまう。
- 同期基盤そのものの過去のバグ(§1で言及した「無人経路が差分を使っていな
  かった」等)により、ある回でcreateInventoryが例外を投げ、かつ
  `resolveNextSyncBasis`導入**前**の実行で基準が誤って進んでしまっていた
  場合も、同じ状態に落ちる。

いずれの原因であっても、直し方(§2)は原因を問わず同じ——「時刻だけで
skipを決めない」という一般的な安全策になる。

## 2. 修正方針

### 2.1 却下した案とその理由

- **「対象0件のページでは何もしない」を維持したまま、既存の
  `findMissingZaicoManagedInventory`(isDone時のみ)に存在確認を委ねる**
  ——却下。この関数は「BELLOにあるがZAICOに無い」方向(削除検出)しか見ない。
  「ZAICOにあるがBELLOに無い」方向の欠落は検出も修復もできない。
- **ZAICO API側のフィルタで対処する**——却下。`lib/inventory/zaicoDelta.ts`
  冒頭の既存実測(2026-09-02)のとおり、ZAICO API v1は差分クエリに一切
  対応していない。API呼び出し側でこの問題を解決する余地は無い
  (`docs/zaico-sync-delta-redesign-20260911.md`§2で確定済み、今回再確認は
  行っていない)。
- **常に`fetchAllZaicoManaged`をページ毎に呼ぶ(2026-09-11以前の設計に戻す)**
  ——却下。取りこぼしは無くなるが、この設計見直しが達成した高速化(1件ごとの
  照合/マージ/書き込み判定の削減)を完全に失う。このtaskの完了条件
  (「高速化の取得削減と取りこぼさない根拠を両立」)に反する。

### 2.2 採用した設計: invocationスコープの実在確認Map

`port.fetchAllZaicoManaged()`(Inventory全件Scan相当)の呼び出しタイミングを、
「ページ毎・対象がある時だけ」から「**1 Lambda invocationにつき1回、
ページloopの外側**」へ移した。

```
[変更前(2026-09-11版)]
handler.ts: for (各ページ) {
              syncPendingItemsWithDelta(pending, since, ..., port) {
                splitByDelta(pending, since)  // 時刻だけで判定
                if (toProcess.length === 0) return;  // ← ここでBELLO実在確認をしないまま抜ける
                prefetched = await port.fetchAllZaicoManaged();  // 対象がある時だけ、ページ毎に
                ...
              }
            }

[変更後(このtask)]
handler.ts: existingBySourceId = await port.fetchAllZaicoManaged();  // invocationにつき1回、loopの外
            for (各ページ) {
              syncPendingItemsWithDelta(pending, since, ..., port, existingBySourceId) {
                splitByDelta(pending, since, (item) => existingBySourceId.has(String(item.id)));
                // 時刻でskip判定された商品も、existingBySourceIdに無ければtoProcessへ復帰
                ...  // fetchAllZaicoManagedはこの関数からは一切呼ばない
              }
            }
```

`lib/inventory/zaicoDelta.ts`の`splitByDelta`に第3引数
`existsInBello?: (item) => boolean`を追加した。時刻だけなら`skip`と判定
された商品について、この関数が渡されていて、かつ`false`を返す(＝BELLOに
実在しない)場合は、時刻がどれだけ古くても`toProcess`へ回す。省略時
(既存呼び出し互換)は従来どおり時刻だけで判定する。

ブラウザ経路(`lib/inventory/zaicoBackgroundSync.ts`の`advanceOnePage`)は
元々**ページ毎に無条件で**`fetchAllZaicoManaged`を呼んでいた(§30.7の
prefetch最適化、2026-09-11版でも変更されていない)ため、その`prefetched`を
そのまま`existsInBello`として渡すだけで済んだ——追加のDB呼び出しは一切
発生しない。

### 2.3 なぜこれが「低コストな存在判定」なのか

- `existingBySourceId`は`Map<string, InventoryModel>`——`.has()`はO(1)。
  `splitByDelta`自体は追加のDB往復もAPI呼び出しも行わない(純粋関数のまま)。
- Lambda1 invocationにつき`fetchAllZaicoManaged`(Inventory全件Scan相当)の
  呼び出しは**高々1回**——ページを何回処理しても増えない。これは
  2026-09-11版(「対象0件のページでは呼ばない」が「対象があるページでは
  ページ毎に呼ぶ」)より**さらに強い削減**であり、かつ全ページ・全skip
  候補についてBELLO実在確認がタダで行えるようになる(§4で計測)。
- ZAICO API側への追加の往復は一切無い(§2.1で却下した案と違い、この方針は
  BELLO側の既存データだけで完結する)。

## 3. 変更したファイル(このtask)

| ファイル | 変更 |
|---|---|
| `lib/inventory/zaicoDelta.ts` | `splitByDelta`に`existsInBello?`引数を追加(後方互換)。時刻だけでskip判定された商品でも、BELLOに実在しないなら`toProcess`へ回す。 |
| `lib/inventory/zaicoSyncPageProcessor.ts` | `syncPendingItemsWithDelta`が`fetchAllZaicoManaged`を自分で呼ぶのをやめ、呼び出し元が渡す`existingBySourceId`を受け取る signature に変更。`prefetchUsed`(もう意味を持たないため)を削除。 |
| `amplify/functions/zaico-sync-worker/handler.ts` | `port.fetchAllZaicoManaged()`をページを回す`for`ループの**外側で1回だけ**呼び、`syncPendingItemsWithDelta`の全呼び出しへ使い回す。 |
| `lib/inventory/zaicoBackgroundSync.ts` | `advanceOnePage`が元々ページ毎に取得している`prefetched`を、`splitByDelta`の`existsInBello`としてもそのまま渡す(追加のDB呼び出し無し)。 |
| `scripts/verify-zaico-delta.ts` | `splitByDelta`の`existsInBello`引数の新規テスト(既存互換+取りこぼし再現+修正確認)。 |
| `scripts/verify-zaico-sync.ts` | (a) 新しい静的ガード`testHandlerFetchesExistingSetOncePerInvocation`(`zaicoSyncPageProcessor.ts`が`fetchAllZaicoManaged`を呼ばないこと、`handler.ts`がloop外で1回だけ呼ぶこと)。(b) `testDeltaPageProcessorScenarios`を新signatureに合わせて更新、複数ページ相当の呼び出しでも追加Scanが発生しないことを確認するよう強化。(c) 新規シナリオ7: BELLO未取込+ZAICO側`updated_at`が古い商品が正しく処理されることを直接確認(このtaskの再発防止テストそのもの)。 |
| `docs/zaico-sync-delta-redesign-20260912-followup.md`(このファイル) | 追補設計書。 |

このtaskは`amplify/functions/zaico-sync-worker/resource.ts`(スケジュール定義)・
ZAICO側の書き込み・本番DB・クラウドリソース・課金・顧客操作のいずれにも
触れていない。実同期(Lambda/ブラウザ経路)を起動・停止する操作も行っていない
——変更は「未公開のロジックファイル+テスト+設計書」の範囲に閉じている。

## 4. テスト結果(このworktree内、AWS/ZAICO/実DBには一切接続していない)

`fs.symlinkSync`で本体リポジトリの`node_modules`へjunctionを張り、
`amplify_outputs.json`(gitignore対象)を一時コピーして型解決を通した上で
実行し、**検証後に両方とも削除済み**(このworktreeの成果物として残らない、
既知の回避策——`docs/zaico-sync-delta-redesign-20260911.md`§4と同じ手順)。

```
node scripts/with-server-only-stub.cjs scripts/verify-zaico-delta.ts
  → 52 passed, 0 failed
    (既存44件は無改変で通過。新規8件: splitByDeltaのexistsInBello後方互換
     +取りこぼし再現+修正確認+全件同期時の扱い)

node scripts/with-server-only-stub.cjs scripts/verify-zaico-sync.ts
  → 120 passed, 0 failed
    (既存108件は無改変で通過——重複防止/idempotency/prefetch・masterCache/
     purchasePrice/売上集計/画像処理/一覧ソート等、既存の回帰スイート。
     新規12件: 静的ガード1件+シナリオ更新+新規シナリオ7)

node scripts/with-server-only-stub.cjs scripts/verify-zaico-pagination.ts
  → 76 passed, 0 failed(無改変。pagination/resume/重複ページ検知に影響が無いことの確認)

node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  → エラー0件(プロジェクト全体)
```

### 4.1 取りこぼし防止試験(指示書§7の全項目との対応)

| 項目 | 検証方法 | 結果 |
|---|---|---|
| **BELLO未取込+古い時刻**(このtaskの主題) | `testDeltaPageProcessorScenarios`シナリオ7: BELLOに存在しない商品(`existingBySourceId`に無い)+`since`より古い`updated_at`を渡す | `skippedByDelta`に入らず`totalProcessed=1`/`created=1`で正しく新規作成。観測済みにも入る(削除誤検出も防ぐ) |
| 既存未変更(BELLOに実在+時刻が古い) | 同シナリオ7のid=1(対照群) | 正しく`skippedByDelta`に入る(過剰処理していないことの確認) |
| 失敗再試行 | `resolveNextSyncBasis`の既存テスト(基準据え置き)+新規のexistsInBelloは独立した安全策として併存 | 通過(無改変、2026-09-11版の挙動を保持) |
| 日付なし/壊れた日付 | `needsSync`は`updated_at`欠如/不正時に`true`を返す既存挙動——`existsInBello`分岐に到達する前にtoProcessへ入るため無影響 | 既存テスト+シナリオ4で確認 |
| 途中再開(ページ内/ページ間) | `pending = zaicoItems.filter(!seenSourceIds.has)`は無改変。`existingBySourceId`はinvocation開始時のスナップショットだが、同一invocation内での同一idの再出現は`seenSourceIds`が先に弾くため二重処理は起きない(§2.3脚注参照) | シナリオ6(時間切れ→残りは次回)で確認、無改変 |
| 重複ページ | `verify-zaico-pagination.ts`(無改変)+`seenSourceIds`によるページ内dedup | 76件通過 |
| 末尾(ページ端) | `verify-zaico-pagination.ts`(無改変) | 76件通過 |
| FULL | `since=null`では`existsInBello`の有無に関係なく全件`toProcess` | `testSplitExistsInBello`で確認 |
| 削除検出の観測済集合 | `observedSourceIds`は「処理した分+スキップした分」で従来通り全件を含む——existsInBelloによる復帰分も`toProcess`経由で観測済みに入る | シナリオ7で観測済み合計=渡した件数と一致することを確認 |
| DB読取回数 | `testHandlerFetchesExistingSetOncePerInvocation`(静的ガード)+シナリオ1〜3(mockPortの呼び出し回数) | invocationにつき`fetchAllZaicoManaged`は高々1回。複数ページ相当を呼んでも増えない(§4.2) |
| 実worker外部境界mock/型/build | 全テストは`ZaicoSyncPort`のin-memory mockのみで実行。`tsc --noEmit`はプロジェクト全体でエラー0件 | 上記コマンド出力の通り |

## 4.2 読取削減量(mockPortの呼び出し回数、決定論的な指標)

| 指標 | 2026-09-11版(未修正・仮に本番投入されていた場合) | このtask後 |
|---|---|---|
| `fetchAllZaicoManaged`(Inventory全件Scan相当)/1 invocation | 「変更ありページの数」に比例(例: 106ページ中10ページに変更があれば10回) | **高々1回**(ページ数・変更有無に関係なく) |
| BELLO未取込+古い時刻の商品の取り込み機会 | 無し(時刻だけでskipされ続け、再試行の機会が来ない) | 毎invocationで確認される(existingBySourceIdに無ければ必ずtoProcessへ回る) |
| 1件ごとの照合/マージ/書き込み判定(`syncOneZaicoItem`呼び出し) | 変更分のみ(2026-09-11版の削減を維持) | 変更分のみ(同左、退行なし——シナリオ1: 5,000件中20件更新で20回のみ) |

**取得を省けない事実の明記(2026-09-11版からの継承)**: ZAICO API側の
ページ取得(HTTP往復)は今回も減っていない——`lib/inventory/zaicoDelta.ts`
冒頭の実測のとおりサーバー側フィルターが無いため、全ページを辿る必要が
あるという制約は変わらない。今回のtaskが削減したのは(a) 1件ごとの
照合/マージ/書き込み判定(2026-09-11版からの継承)と、(b) BELLO側
Inventory全件Scanの呼び出し回数(このtaskの新規の削減)。

## 5. 公開後にQAが実画面/ログで検証できる手順

1. `docs/zaico-sync-delta-redesign-20260911.md`§8の手順(1〜4)がそのまま
   引き続き有効(`ZaicoSyncJob.mode`/`skippedByDelta`の確認、CloudWatch
   Logsでの`skippedByDelta=...`ログ確認等)。
2. **このtask固有の確認**: 過去にBELLO未取込のままZAICO側`updated_at`が
   古い商品が実在した場合(§1.2の`releaseSourceLink`失敗事例等)、デプロイ後
   最初のDELTA同期tickで、その商品が`created`として1件だけ計上される
   はず——`ZaicoSyncJob.created`が通常より僅かに大きい値で1回だけ動く
   ことが、この修正が実際に効いた直接証拠になる(2回目以降は通常のunchanged
   扱いに落ち着く)。
3. 実際にBELLO未取込の既知の在庫があるかどうかは、読み取り専用の
   `npm run verify:zaico-reconciliation`(既存script)、または
   AWS profile Bello読み取り専用アクセスでのInventory/ZaicoSourceLink
   突き合わせで、デプロイ前に事前確認できる(このtask自体は実AWSへの
   接続を行っていない——§3参照)。

## 6. 残課題

1. **本番実測は行っていない**——mockPortでの呼び出し回数という決定論的な
   指標のみで検証しており、実際のCloudWatch Duration/Scan消費キャパシティ
   単位(RCU)での削減量は計測していない。`docs/zaico-sync-delta-redesign-
   20260911.md`§6-3と同じ理由(実AWS環境が必要、このサンドボックスでは
   実施不可)。
2. **ブラウザ経路(`advanceOnePage`)は`syncPendingItemsWithDelta`への一本化
   を見送ったまま**(2026-09-11版の残課題1を継承)——今回は既存の
   ページ毎`fetchAllZaicoManaged`呼び出しに`existsInBello`を追加で
   渡しただけで、呼び出し頻度自体(ページ毎)は変えていない。ブラウザ経路は
   ADMINの手動操作でありLambda(5分毎・無人)ほど頻度が高くないため、
   このtaskの優先度としては許容範囲と判断した。
3. `existingBySourceId`はinvocation開始時点のスナップショットであるため、
   理論上は「同一invocation内で、既に作成済みの商品と同じsourceInventoryId
   を持つ別アイテムが後続ページに(ZAICO側APIの不整合等で)再出現する」
   ケースで、既存の`seenSourceIds`によるdedupだけに頼ることになる
   (§2.3脚注)。これは2026-09-11版・このtaskのどちらでも同じ前提であり、
   新規に持ち込んだリスクではない——`claimSourceLink`のDB層原子性
   (`lib/inventory/zaicoSyncPorts.ts`)が最終防衛線として機能する。

## 7. task_1606b70(本追補): prefetchのtry境界回帰を修正し、実handler境界試験を追加

`existingBySourceId = await port.fetchAllZaicoManaged();`(§2.2)をページloop
の外側・**`try`の外側**に置いたまま`amplify/functions/zaico-sync-worker/
handler.ts`を書き上げていたことが、後続QA(task_a320作業ツリー、未commit)で
判明した。この配置だと、prefetch自体が例外を投げた場合に:

- `catch`ブロック(`retryCount`の記録・`MAX_RETRIES_BEFORE_FAILED`超過時の
  `FAILED`遷移)を一切通らない——失敗が記録に残らない。
- `finally`ブロック(`releaseLease`)も通らない——leaseが`LEASE_DURATION_MS`
  (4分)の自然失効まで解放されず、他の実行主体(ブラウザの「今すぐ1ページ
  進める」やこのLambda自身の次tick)を無用に排他し続ける。

直し方は1行の移動のみ: `existingBySourceId`の取得を`try {`の**内側**
(ループの直前)へ移す。これにより他の全ての`await`と同じくcatch/finallyを
必ず通るようになった(`handler.ts`本体のコメント参照)。

この修正を固定するため、`scripts/verify-zaico-worker-boundary.ts`
(新規)で実`handler`関数そのものを、DynamoDB(`DynamoDBDocumentClient.
prototype.send`のprototype置換)・ZAICO API・port(`createLambdaSyncPort`/
`findMissingZaicoManagedInventory`)の3つの外部境界だけをmockして通す
合成境界試験を追加した——`syncOneZaicoItem`/`syncPendingItemsWithDelta`/
`resolveNextSyncBasis`等の実worker関数自体は一切差し替えない。

### 7.1 実行して初めて分かった追加のバグ(このtaskで発見・修正)

当初案はZAICO API/portの2境界も`Object.defineProperty`でモジュール
名前空間のexportを直接書き換える設計だった(DynamoDBと同じ発想)。
だが実際に実行すると`TypeError: Cannot redefine property: listInventories`
で落ちた——tsxの実行環境ではESMの名前付きexportはnon-configurableな
bindingとして公開されており、「CJSへ変換されるためconfigurableになる」
という当初の想定は誤りだった(推測ではなく実行して確認した事実)。

原因を追ったところ、`handler.ts`には元々`HandlerTestOverrides`という
引数経由の差替え口(`listInventories`/`createLambdaSyncPort`/
`findMissingZaicoManagedInventory`)が用意されていたが、そのうち2つ
(`listInventoriesFn`/`findMissingZaicoManagedInventoryFn`)は変数として
計算されるだけで、実際の呼び出し箇所(ページ取得・missing判定)は
オーバーライドを無視して直接importを呼んでいた——**このバグのため
オーバーライドが常に無効化されており、試験スクリプト側がモジュール
export書き換えという壊れやすい代替手段に頼らざるを得なくなっていた**。
`createLambdaSyncPortFn`だけは正しく配線されていたため気づかれずに
残っていた。

修正は`handler.ts`の2箇所(`listInventories(...)`→`listInventoriesFn(...)`、
`findMissingZaicoManagedInventory(...)`→`findMissingZaicoManagedInventoryFn(...)`)
のみ。これにより`verify-zaico-worker-boundary.ts`は`handler(testOverrides)`
という引数渡しだけで3境界すべてを差し替えられるようになり、モジュール
export書き換えは不要になった(削除済み)。

### 7.2 テスト結果(このworktree内、AWS/ZAICO/実DBには一切接続していない)

```
node scripts/with-server-only-stub.cjs scripts/verify-zaico-worker-boundary.ts
  → 53 passed, 0 failed
    (prefetch例外→retry記録+lease解放/連続5回失敗でFAILED化/
     ページ取得失敗→checkpoint据え置き/部分失敗→基準据え置き/
     正常完了→開始時刻基準/BELLO未取込+古い時刻の取りこぼし防止/
     ページ内途中再開の二重計上なし/ページ内重複idの排他/
     複数ページに渡る1invocation1prefetchの維持、をすべて実handler経由で確認)

node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json
  → エラー0件(プロジェクト全体)

node scripts/with-server-only-stub.cjs scripts/verify-zaico-delta.ts
  → 52 passed, 0 failed(無回帰)
node scripts/with-server-only-stub.cjs scripts/verify-zaico-sync.ts
  → 122 passed, 0 failed(無回帰)
node scripts/with-server-only-stub.cjs scripts/verify-zaico-pagination.ts
  → 76 passed, 0 failed(無回帰)
```

### 7.3 未確認事項(実AWS/実ZAICO未検証)

- 実Lambda環境でのデプロイ後動作・実CloudWatch Logsでの`skippedByDelta`/
  `retryCount`確認は行っていない(§8の既存QA手順のまま)。
- 実DynamoDBの`ConditionExpression`構文をこの合成境界試験のin-memory
  実装(`verify-zaico-worker-boundary.ts`の`evaluateCondition`)が完全に
  再現しているとは限らない——handler.tsが現状発行する2種類(SET-only/
  REMOVE-only)のUpdateExpressionのみを解釈する簡易パーサーであり、
  汎用DynamoDB式パーサーではない(ファイル冒頭コメントに明記)。
- lease機構自体の並行実行(複数Lambda invocationが同時に走るレース)は
  この試験は検証していない(1プロセス内で順に`handler()`を呼ぶだけ)。
