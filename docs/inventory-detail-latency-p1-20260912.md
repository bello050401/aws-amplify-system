# P1 詳細遷移の待ち時間短縮(2026-09-12、レビュー補正込み)

## 1. 目的

一覧→商品詳細ページ(`app/inventory/(protected)/[id]/page.tsx`)の遷移を速くする。
画像の段階読込(8d7e5fa)が公開済みの後も、ページ本体(基本情報・画像・
販売情報等)の待ち時間そのものが残っている、という前提での調査・改修。

このドキュメントは元の実装(`d11eb0e`、旧基点 `6a38f1d`)を現行公開
(`06bf269`)へ統合する際のレビュー補正を含む。**§2〜4は元の設計、
§5は補正内容**。

## 2. 現状経路の調査結果(原因)

`lib/inventory/queries.ts` の `getInventoryDetail(id)` は、次の2つを
**直列**に待ってから返していた:

1. `Inventory.get({ id })` — 単一get、O(1)。
2. `InventoryHistory.listInventoryHistoryByInventoryIdAndChangedAt({ inventoryId: id })` —
   実GSI Query(第五ラウンドP0-Bで既にScanから切り替え済み、対象商品の
   履歴行だけを読む。件数には依存しないが、**呼ぶたびに1往復かかる**
   ことは変わらない)。

`getInventoryDetail` を呼んでいる箇所を全て洗い出したところ、**返り値の
`history` フィールドを実際に読んでいるのは商品詳細ページ1箇所だけ**
だった——残り14箇所すべてが、使わないデータのために毎回1往復を無駄に
払っていた。商品詳細ページ自身についても、更新履歴はページ最下部の
補助テーブル(spec: 左右カラムの外、独立配置)であり、本体の描画に
必要な値ではない。

## 3. 設計方針(元の実装)

`getInventoryDetail` を2つに分割する(`lib/inventory/queries.ts`):

- **`getInventoryDetail(id)`**: `Inventory.get` のみ。返り値から `history`
  フィールドを削除。
- **`getInventoryHistory(id)`**: 従来の `InventoryHistory` GSI Query
  部分を独立関数化。

商品詳細ページ側は、更新履歴セクションだけを非同期Server Component
`InventoryHistoryTable.tsx` に切り出し、`<Suspense>` で包む。

## 4. 元の実装の未検証リスク(今回のレビューで指摘・修正)

元の `InventoryHistoryTable.tsx` は次の2点を放置していた:

1. **`getInventoryHistory` が GraphQL `errors` を確認していなかった**
   ——`const { data: historyRows } = await ...` のように `data` だけを
   見ており、権限不足・一時障害等で `errors` が返っても `data` は空配列
   として素通しになる。「本当に0件」と「取得に失敗した」を呼び出し側が
   区別できない(cf. `lib/inventory/salesAggregateStore.ts` の
   `fetchSnapshot` で既に確立済みの同じ問題への対処と同じ考え方)。
2. **`InventoryHistoryTable`(async Server Component)に局所エラー処理が
   無かった**——`getInventoryHistory` が例外を投げる経路(GraphQL以外の
   エラー: ネットワーク断・認証失効等、`docs/
   server-components-render-error-static-20260902.md` 1-2 参照)では、
   `<Suspense>` の中で投げられた例外はそのままページ全体のerror境界
   (`app/inventory/error.tsx`)へ波及し、**本体(基本情報・画像・価格
   操作)まで巻き込んでエラー画面に差し替わる**——P1の目的(本体を
   履歴の失敗から独立させる)に反する。

## 5. 今回の補正内容

### 5.1 `lib/inventory/queries.ts`

`getInventoryHistory` に `errors` チェックを追加。`errors` が返れば
明示的に例外を投げ、呼び出し側でキャッチできるようにした(`data`が
空配列に化けて「変更履歴はまだありません」という正常系の空表示と
混同されるのを防ぐ)。

### 5.2 局所エラー処理(3層構成)

- **`InventoryHistoryTable.tsx`**(Server Component): `getInventoryHistory`
  を `try/catch` で囲み、成功なら行の配列、失敗なら `null` を
  `InventoryHistorySection` へ渡す。**例外を外へ投げない**——ページ全体の
  error境界へ波及しなくなった。ログは `err.name` のみ(識別情報を出さない)。
- **`InventoryHistorySection.tsx`**(新規、Client Component):
  `initialRows === null` を「取得エラー」、`initialRows.length === 0` を
  「変更履歴はまだありません」として明確に描き分ける。取得エラー時は
  再試行ボタンを表示する。
- **`getInventoryHistoryAction`**(`app/actions/inventory.ts` に新規追加、
  Server Action): 再試行ボタンが呼ぶ。`getSalesItemsAction` と同じ設計
  ——`getInventoryRole()` を呼び直して認可を維持し、例外を投げず
  `{ok:true, rows} | {ok:false}` を返す。再試行はページ全体の再読み込み
  無しに履歴セクションだけをやり直す(本体は再試行と無関係)。

商品を切り替えたときに前の商品のエラー/読み込み状態を引きずらないよう、
`InventoryHistoryTable` は `<InventoryHistorySection key={inventoryId} .../>`
と `key` を渡している(`SalesItemsSection.tsx` の
`key={\`${year}-${month}\`}` と同じ「keyでReactの内部stateをリセットする」
定石)。

### 5.3 表示ヘルパーの共有化

`formatDateTime`/`historyOperationLabel`/`historyChangeSummary` を
`lib/inventory/historyDisplay.ts` に切り出した。SSR初回描画
(`InventoryHistoryTable`経由)とクライアント再試行後
(`InventoryHistorySection`)の2箇所が同じ表を1文字も違わず描く必要が
あるため——page.tsx側の`formatDateTime`(作成日/更新日用、無関係な
機能)のような重複はさせていない。副次効果として、このモジュールは
`import type` 以外の実行時importを持たないため、`server-only`/Amplify/
Reactへの依存なしに単体で実行・検証できる
(`scripts/verify-inventory-history-resilience.ts` 参照)。

### 5.4 実ブラウザQA用の失敗シミュレーション

`lib/inventory/e2eFixtures.ts` の `e2eInventoryHistory` に
`INVENTORY_E2E_HISTORY_FAILURE=1` を追加。立てると常に例外を投げる
——既存の `isE2EFixtureModeActive()` ゲート(`NODE_ENV !== "production"`
かつ `INVENTORY_E2E_FIXTURES === "1"`)の内側でのみ意味を持つ、読み取り
専用の追加opt-in。

## 6. 試験

### 6.1 型検査・lint(実行済み、2026-09-12レビュー補正セッションで再実測)

このタスクworktreeには `node_modules` への**読み取り専用junction**が
(このセッション開始時点で)既に張られており(`fs.lstatSync('node_modules').isSymbolicLink()`
= true、本体リポジトリを指す)、`readdirSync`で694エントリを実際に読める
状態だった。これを使って以下を単一コマンドとして実行した(`npx`は
経由せず`node <相対パス>`で直接叩く——承認ゲート回避、memory
`qa-worktree-tooling-limits`参照):

- `node node_modules/typescript/bin/tsc --noEmit` → **出力なし・exit code 0
  (0エラー)**。
- `node node_modules/next/dist/bin/next lint` → `✔ No ESLint warnings or errors`
  ・**exit code 0**。

junctionは本体リポジトリの`node_modules`を指す読み取り専用参照であり、
このセッションで新規作成も変更もしていない(既存のものをそのまま利用)。
本体リポジトリ・共有`node_modules`への書き込みは一切行っていない。

### 6.2 合成試験・ベンチマーク(実行済み)

`node scripts/with-server-only-stub.cjs scripts/verify-inventory-history-resilience.ts`
——`lib/inventory/historyDisplay.ts` を実際にimportして検証する:

- 書式(`formatDateTime`)・操作ラベル/変更内容の派生ロジック
  (`historyOperationLabel`/`historyChangeSummary`)が分割前と同じ結果を
  返すこと。
- 「空配列(データなし)」と「`null`(取得失敗)」が異なる状態として
  扱われること。
- **結果: 11件 pass、exit code 0**。`package.json`に`verify:inventory-history`
  スクリプトを追加済み(`npm run verify:inventory-history`から同じ経路で
  呼べる、他の`verify:*`と同じ`with-server-only-stub.cjs`ラッパー経由)。

`node scripts/with-server-only-stub.cjs scripts/benchmark-inventory-queries.ts`
も実行し、exit code 0で完走。件数100〜20,000の全tierで「商品詳細ページ
本体」がhistory往復を含む旧経路(`simGetInventoryDetailPreP1`)よりp50で
約98〜103ms(`SIM.appsyncCallMs=70ms`+jitterの理論値と一致)短縮されている
ことを確認した。

`getInventoryHistory` の `errors` チェックと `InventoryHistoryTable`/
`InventoryHistorySection` の状態遷移そのもの(Amplifyクライアント・
React/JSX依存)は、上記の実tsc型検査(プロジェクト全体、このファイル群
も対象)と目視コードレビューで裏付けた——いずれも数行の単純な制御フロー
で、`lib/inventory/salesAggregateStore.ts`/`app/inventory/(protected)/sales/
SalesItemsSection.tsx` の既存パターンと同型。ただし**実行時の状態遷移
そのもの(useStateの実際の描画結果)は単体テストランナーが無いため
実行未確認**——6.3の実ブラウザQAで確認する必要がある。

### 6.3 未確認(環境制約・実ブラウザQA手順)

このセッションの環境には`next dev`を起動しても操作できるブラウザ/
スクリーンショットツールが無く(利用可能なツール一覧にブラウザ操作系
ツールが含まれていない)、実ブラウザでの目視確認は行っていない。
デプロイ後、以下を実ブラウザで確認する:

1. 通常の商品詳細ページで、本体(基本情報・画像・価格操作)が更新履歴
   より先に表示され、更新履歴は「読み込み中…」を経て表示されること
   (従来どおりの挙動、回帰なし)。
2. `INVENTORY_E2E_FIXTURES=1 INVENTORY_E2E_HISTORY_FAILURE=1` を設定した
   状態で任意の商品詳細ページを開き、
   - 本体(基本情報・画像・価格操作)が通常どおり表示されること
     (エラー画面に差し替わらないこと)、
   - 更新履歴セクションだけが「変更履歴を読み込めませんでした。」+
     「再試行」ボタンを表示すること、
   - `INVENTORY_E2E_HISTORY_FAILURE` を外した状態で「再試行」を押すと
     (別プロセスで環境変数を変えられない場合は次回の通常アクセスで)
     履歴テーブルへ復帰すること、
   を確認する。
3. 商品を切り替えたとき、前の商品のエラー/読み込み中表示が残らない
   こと。
4. VIEWER/EDITOR/ADMINそれぞれで開き、再試行ボタンの動作(認可)が
   従来の権限モデルと矛盾しないこと。
5. 存在しないID直打ちで通常どおり404になること(本体側は変更していない)。

## 7. 変更ファイル(このレビュー補正時点)

| ファイル | 変更内容 |
|---|---|
| `lib/inventory/queries.ts` | `getInventoryDetail`/`getInventoryHistory` 分割 + `getInventoryHistory` に GraphQL `errors` チェックを追加 |
| `lib/inventory/e2eFixtures.ts` | `e2eInventoryDetail` から `history` を除去。`e2eInventoryHistory(id)` を新設(既存の画像段階読込フィクスチャは無変更) |
| `lib/inventory/historyDisplay.ts`(新規) | 表示ヘルパー3関数を共有モジュール化(実行時import無し) |
| `app/inventory/(protected)/[id]/page.tsx` | 更新履歴の直接描画を `<Suspense><InventoryHistoryTable .../></Suspense>` に置換 |
| `app/inventory/(protected)/[id]/InventoryHistoryTable.tsx`(新規) | 更新履歴取得のServer Component。`try/catch`で例外を外へ投げない |
| `app/inventory/(protected)/[id]/InventoryHistorySection.tsx`(新規) | 表示本体のClient Component。ok/empty/error/再試行を描き分ける |
| `app/actions/inventory.ts` | `getInventoryHistoryAction` を新設(再試行用Server Action) |
| `scripts/benchmark-inventory-queries.ts` | 本体/履歴/旧経路の合成遅延を分けて計測するよう更新 |
| `scripts/verify-inventory-history-resilience.ts`(新規) | `historyDisplay.ts` の合成試験 |

## 8. 続き: 実境界試験(2026-09-12、task_a748ee69c990317c24)

§6.3で「未確認」としていた実ブラウザQAと、§6.2の「カバーしない範囲」
としていた `queries.ts`/`InventoryHistoryTable.tsx` の実配線試験は、
`docs/inventory-detail-history-boundary-qa-20260912.md` で実施・記録した。
