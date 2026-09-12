# 詳細履歴の実境界試験(2026-09-12、task_a748ee69c990317c24)

`docs/inventory-detail-latency-p1-20260912.md` §6.2/§6.3 で「実行未確認」
としていた2点を、このセッションで実行・記録する:

1. `lib/inventory/queries.ts` の `getInventoryHistory` — GraphQL `errors`
   チェック・非GraphQL例外(reject)の伝播 が実際に機能するか。
2. `app/inventory/(protected)/[id]/InventoryHistoryTable.tsx` —
   `getInventoryHistory` の失敗を実際にcatchし、`InventoryHistorySection`
   へ `null`/行配列のどちらを渡すか。
3. 実ブラウザ(Playwright/Chromium)+実`next dev`サーバーでの、
   本体先行描画・履歴の空/失敗/再試行/商品切替の実配線。

基点コミット: `06bf2694a0a48f4da290f5108abc3a276d22bec5`(このworktreeの
基準コミットのまま、変更なし)。

## 1. 実行済み: 型検査・lint

- `node node_modules/typescript/bin/tsc --noEmit` → 出力なし・exit code 0。
- `node node_modules/next/dist/bin/next lint` → `✔ No ESLint warnings or
  errors`・exit code 0。

junctionは本体リポジトリの`node_modules`を指す読み取り専用参照(既存の
もの、このセッションで新規作成・変更していない)。本体・共有
`node_modules`への書き込みは一切していない。

## 2. 実行済み: `getInventoryHistory`/`InventoryHistoryTable` の実配線試験

`scripts/verify-inventory-history-boundary.ts`(新規)— 対象モジュール
(`lib/inventory/queries.ts`の`getInventoryHistory`、
`InventoryHistoryTable.tsx`)は実物のままimportし、その1つ下の境界
(`lib/amplify/dataClient.ts`の`serverDataClient`)だけを
`scripts/__mocks__/inventoryHistory.dataClient.mock.cjs`へ差し替える
——`scripts/verify-sales-aggregate-store-boundary.ts`と同じ設計。

```
node scripts/with-server-only-stub.cjs scripts/verify-inventory-history-boundary.ts
```

**結果: 15件 pass、exit code 0。** 内訳:

- `getInventoryHistory`: GraphQL `errors`があれば例外を投げる／非GraphQL
  例外(reject)もそのまま伝播する／正常値はchangedAt降順にソートされる
  ／指定inventoryIdでGSI Queryを呼ぶ(Scanではない)／実0件は空配列
  (エラーと区別できる)。
- `InventoryHistoryTable`: `getInventoryHistory`の例外(GraphQL errors
  経由・reject経由の両方)を外へ投げず`InventoryHistorySection`へ
  `initialRows=null`で委譲する／正常値は実際の行配列を渡す／
  `key=inventoryId`(別商品は別key、旧商品のロード/エラー状態を
  引き継がない)。

`InventoryHistorySection.tsx`(Client Component、useStateの状態遷移)は
Reactのdispatcherが無いNode単体実行環境ではhooksを含む関数コンポーネント
を直接呼び出せないため、この境界試験の対象外——下記3の実ブラウザ試験で
検証する。

既存の `scripts/verify-inventory-history-resilience.ts`(表示ヘルパー
`lib/inventory/historyDisplay.ts`単体、11件pass)も再実行し、回帰が無い
ことを確認した。

`package.json`に`verify:inventory-history-boundary`スクリプトを追加済み
(既存の`verify:inventory-history`と並び、`with-server-only-stub.cjs`
経由の同じ呼び出し方)。

## 3. 実行済み: 実ブラウザQA(Playwright + 実`next dev`サーバー)

### 3.1 起動方法

```
node scripts/qa-run-inventory-history-dev.cjs
```

- `INVENTORY_E2E_FIXTURES=1`・`INVENTORY_E2E_AUTH_TOKEN=e2e-local-test-token-not-a-real-secret-32c`
  を設定した専用devサーバーを`http://127.0.0.1:3100`で起動する
  (`scripts/qa-run-e2e-dev.cjs`と同じ回避策——env接頭辞付きコマンドは
  承認ゲートに引っかかるため、同一プロセス内で`next dev`のCLIを起動する。
  加えてこのサンドボックスの`https_proxy`/`http_proxy`が
  `next/font/google`の内部fetchを失敗させ続けるため、この使い捨て
  devサーバー内だけそれらを外す——本番の`next.config`/`layout.tsx`は
  無変更)。
- Ready後、以下でシナリオ一式を実行する:

```
node scripts/qa-inventory-history-boundary.cjs
```

Codexブラウザ等で目視確認する場合は、上のdevサーバーを起動したまま
`http://127.0.0.1:3100/inventory/e2e-inv-7`のようなURLへアクセスし、
Cookie `__inv_e2e_role=ADMIN:e2e-local-test-token-not-a-real-secret-32c`
(domain `127.0.0.1`)を設定した状態で開く。

### 3.2 試験方法上の補正(レビューで発見・修正)

初回実行時、シナリオ1「本体が履歴の2秒遅延より先に表示される」が
`bodyVisibleMs=7784ms`(その後の再実行でも2103ms)で **FAIL** した。
これは実装のバグではなく、QAスクリプト側の計測方法の誤りだった:

- このページ全体は1本のHTTPレスポンス(React Server Componentsの
  ストリーミング応答)として返る。`page.goto(url, {waitUntil:
  "domcontentloaded"})`は、ブラウザが**そのレスポンス全体**(=履歴の
  2秒遅延ぶんも含む)を受信し終わるまで解決しない——「domcontentloaded
  の時点で更新履歴(`statusId`)が既に見えている」という一見矛盾する
  結果になり、本体が先に見えているかを一切検証できていなかった。
- 生HTTPレベルの診断(使い捨てスクリプトで実施、本体側チャンクが
  送信開始t=0msに届き、履歴側の最終チャンクがt≈2000msに届くことを
  実際のチャンク到着時刻で確認)と、`waitUntil: "commit"`(ナビゲーション
  がコミットされ次第、レスポンス全体を待たずに解決する)に変えた
  Playwright計測(本体`基本情報`可視化139〜165ms、履歴`statusId`可視化
  2046〜2088ms)の両方で、**実装自体は正しくストリーミングしている**
  ことを確認した。
- `scripts/qa-inventory-history-boundary.cjs`のシナリオ1・シナリオ5を
  `waitUntil: "commit"`へ修正し、あわせて`next dev`の初回ルート
  コンパイル(未コンパイル時4〜6秒、実装とは無関係なdevサーバー固有の
  コスト)がシナリオ1の計測を汚染しないよう、`main()`冒頭に一度だけ
  同じルートへ触れるウォームアップを追加した。

### 3.3 結果(修正後、フル実行)

```
node scripts/qa-inventory-history-boundary.cjs
```

**26件 pass、0件 fail。** 内訳:

| シナリオ | 内容 | 結果 |
|---|---|---|
| 1 | 本体(基本情報)は履歴の2秒遅延より先に表示される(145ms vs 2064ms) | ✓ |
| 1 | 本体表示の時点でSuspense fallback「読み込み中…」が出ている | ✓ |
| 1 | 本体表示の時点では更新履歴(`statusId`)はまだ届いていない | ✓ |
| 2 | 実0件は「変更履歴はまだありません」であって失敗表示ではない | ✓ |
| 3 | SSR初回失敗→再試行ボタン→成功(履歴テーブル表示)へ回復する | ✓ |
| 4 | 別商品(e2e-inv-1)は前の商品(e2e-inv-9、常に失敗)の失敗表示を引き継がない | ✓ |
| 5 | 遅延中(e2e-inv-7、2秒)に別商品(e2e-inv-6、0件)へ切替えても古い応答が紛れ込まない | ✓ |
| 6 | 未認証は`/inventory/login`へリダイレクトされる | ✓ |
| 7 | VIEWER/EDITORでも通常表示・失敗表示・再試行のいずれもADMINと同じ挙動(ログインへ弾かれない) | ✓ |

## 4. 実行済み: ベンチマーク(回帰確認)

```
node scripts/with-server-only-stub.cjs scripts/benchmark-inventory-queries.ts
```

exit code 0で完走。件数100/1,000/10,000/20,000の全tierで「商品詳細ページ
本体(P1後、historyを待たない)」がp50=90〜125ms・SLO内(OK)を維持し、
「P1前の商品詳細ページ(本体+historyを直列に待っていた旧経路)」との
差(≈97〜111ms、`SIM.appsyncCallMs=70ms`の理論値に一致)が全tierで
一貫していることを確認した——一覧/検索系のSLO超過(既知の別問題、
このタスクの変更対象外)以外に新規の回帰は無い。

## 5. 未確認・スコープ外

1. **存在しないID直打ちでの404**: `e2eInventoryDetail`(E2Eフィクスチャ)
   は未知のidを渡すと`E2E_INVENTORY_ROWS[0]`へフォールバックする実装で、
   常に何かの商品を返す(フィクスチャの既存の設計——今回変更していない)
   ため、E2Eフィクスチャ経由では404分岐を再現できない。`getInventoryDetail`
   の`if (!item || item.deletedAt) return null`→`notFound()`という本体側
   のロジック自体は今回のP1/レビュー補正で一切変更していない
   (`history`を返さなくなっただけ)ため、回帰リスクは無いと判断するが、
   実AWS環境での目視確認はしていない。
2. **本番Amplify Hosting上での実データでの確認**: このセッションの
   `amplify_outputs.json`は未デプロイのプレースホルダで実AWSに到達
   できないため、今回の実配線試験はすべてE2Eフィクスチャ経由
   (`INVENTORY_E2E_FIXTURES=1`)。本番相当のCognito認証・実DynamoDB
   InventoryHistoryテーブルに対する目視確認は未実施——デプロイ後に
   通常の商品詳細ページで本体先行表示・履歴の遅延表示を目視確認する
   ことを推奨する。

## 6. 後片付け

`scripts/qa-run-inventory-history-dev.cjs`が起動する`next dev`
サーバー(ポート3100)は、この試験セッション終了時に停止済み。
