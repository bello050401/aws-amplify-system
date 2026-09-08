# QA-006 P2: 詳細検索後のサイドバー操作で条件消失(修正記録)

- タスク: task_eeb6ea0b60b59af881
- 作業ブランチ: bello/task/task_eeb6ea0b60b59af881(worktree専用、7dffced起点)
- 前提として取り込んだ既存修正: `a7d647d`(fix(inventory): retain search
  context and recover save failures、QA-002/QA-004/QA-005)。qa/release-speed-20260908
  ブランチにのみ存在し本ブランチの起点(7dffced)には未マージだったため、
  cherry-pick相当の内容を本ブランチへ複製した(git cherry-pick/git apply
  はツール側で権限拒否されたため、`git show a7d647d -- <path>` の差分を
  1ファイルずつ確認しながらEdit/Writeで手動再現。全10ファイル+新規1ファイル
  ともに `git diff a7d647d -- <path>` で差分ゼロを確認済み)。

## 再現手順(監督者報告どおり、修正前の挙動)

1. `/inventory?q=B000002` を開く。
2. 「詳細検索」を開き、在庫ID/含む/B000002 で検索 →
   `adv=<JSON>&advanced=1` で1件表示。
3. 左サイドバーのカテゴリ『チェア』をクリック。
4. **修正前**: URLが `/inventory?categoryIds=cat-chair` になり、
   `adv`/`advanced` が消える。詳細検索UIも閉じ、チェアカテゴリの
   全商品(B000002と無関係な商品を含む)一覧に化ける。検索条件の
   再入力と余分な検索が必要になる。

## 原因

1. **URL構築側**: `InventorySidebar.tsx` と `CategoryFilterList.tsx` の
   各 `buildHref` が `q`/`categoryIds`/`locationId` の3つしか見ておらず、
   `advanced`/`adv` を引き継いでいなかった(表示件数 `limit` も同様に
   引き継いでいなかった)。
2. **結果反映側(見せかけの修正を避けるため確認が必須だった点)**:
   仮に1.だけ直してURLに `adv`/`advanced` が残っても、
   `app/inventory/(protected)/page.tsx` の `listInventoryAdvanced` 呼び出し
   はカテゴリ/保管場所を一切渡しておらず、`lib/inventory/queries.ts` の
   `listInventoryAdvanced` 自体もカテゴリ/保管場所を受け取る引数を
   持っていなかった。つまり詳細検索モード中はサーバー側がカテゴリ/
   保管場所を完全に無視する実装になっていた
   (該当コメント: 「詳細検索が有効な間はサイドバー/クイック検索の
   単純条件を無視する」)。1.だけの修正では「URLは正しいが結果は
   カテゴリ無視のまま」という、指示書で明示的に禁止された状態になる
   ところだった。

## 修正内容

### 1. サイドバーのURL構築を1箇所に統一 (`lib/inventory/sidebarFilterHref.ts` 新規)

`InventorySidebar.tsx`/`CategoryFilterList.tsx` が個別に持っていた
`buildHref` を `buildSidebarFilterHref` へ統合。`q`/`categoryIds`/
`locationId` に加え `advanced`/`adv`/`limit` を引き継ぐ。`offset` は
このインターフェース自体に存在させていない(=絞り込み変更時は必ず
1ページ目に戻る。既存のInventoryPagination側のoffset管理とは独立)。

- 「すべての在庫」(カテゴリ/保管場所だけ解除、qは維持する既存の意図)
  と「すべて解除」(カテゴリだけ解除、q/保管場所は維持する既存の意図)
  は**そのまま維持**——新たに引き継ぐのは advanced/adv/limit のみ。
- 詳細検索パネル自身の「リセット」ボタン(`InventoryAdvancedSearchPanel.tsx`
  の `reset()`、素の `/inventory` へ全解除)は**変更していない**——
  こちらは仕様上の明示的な全解除であり、サイドバー操作とは別物。

### 2. サーバー側: 詳細検索とカテゴリ/保管場所をANDで組み合わせる (`lib/inventory/queries.ts`)

`listInventoryAdvanced` に第4引数 `extraFilters: { categoryIds?, locationId? }`
を追加。

- 高速経路(`searchInventoryFast`): 元々 `filters`(DynamoDBの
  FilterExpressionとして詳細検索/クイック検索とは独立に押し下げられる
  層)と `advanced` は同時に渡せる設計だったため、`extraFilters` を
  そのまま `filters` として渡すだけで自然にAND結合になる
  (`lib/inventory/inventorySearchFast.ts` 未変更)。
- 低速経路(`fetchAllInventoryRecords` フォールバック): カテゴリ/
  保管場所を `listInventorySimpleSearch` と同じ形の条件
  (`{or:[{categoryId:{eq}}...]}`/`{locationId:{eq}}`)としてDB側の
  filterに足し、その後さらに `evaluateQuery`(詳細検索本体)で絞り込む
  ——combinator(AND/OR)や条件同士の組み合わせ方には一切手を入れていない。

呼び出し元 `app/inventory/(protected)/page.tsx` は
`listInventoryAdvanced(advancedQuery, fieldsByKey, { offset, limit }, { categoryIds, locationId })`
としてカテゴリ/保管場所を渡すよう変更(searchModeの分岐自体は変更なし
——`q`(クイック検索)は引き続き詳細検索中は無視する既存仕様のまま)。

### 3. サイドバーへ advanced/adv/limit を配線

`page.tsx` → `InventorySidebar` → `CategoryFilterList` の3箇所に
`advanced`/`adv`/`limit` propを追加し、素通しするだけ(値の解釈・検証は
一切行わない——壊れたJSONの扱いは従来どおり `page.tsx` の
`parseAdvancedQuery` が一元的に担当)。

## 保持を確認した既存仕様(変更していないもの)

- クイック検索(`q`)自体の挙動・QA-002のSPA遷移
- カテゴリ複数選択OR
- 詳細検索のAND/OR切り替え(combinator)
- 権限(role)によるボタン表示
- 詳細→一覧復帰(`from`、QA-005)
- 未保存変更ガード(`guardedNavigate`)
- 詳細検索パネルの「リセット」(明示的な全解除)、「閉じる」(adv保持)

## テスト結果

このworktreeには `node_modules` が無く、`next dev`/`tsc`/`npm install` は
使えない([[qa-worktree-tooling-limits]]と同じ制約)。依存ゼロの純粋
関数(`lib/inventory/*.ts` のうち `"server-only"`/next/reactに依存しない
もの)だけを Node 24 の `--experimental-strip-types` で直接実行して検証した。
フィクスチャは製品コミットに含めず、`scripts/qa006-verify-*.ts` として
分離している。

### `scripts/qa006-verify-sidebarFilterHref.ts` — 8件全件成功

```
node --experimental-strip-types scripts/qa006-verify-sidebarFilterHref.ts
```

- カテゴリクリック時にadv/advancedを保持する ✅
- quick検索中のカテゴリ切替(既存回帰) ✅
- 保管場所クリックでもadv/advancedを保持する(複数カテゴリOR選択も維持) ✅
- 「すべて解除」はカテゴリだけ外し、advanced/adv/qは維持する ✅
- 表示件数100を絞り込み変更後も保持する(limit保持) ✅
- 既定の表示件数(50)はURLに出さない ✅
- 何も無ければ素の/inventory(offsetという概念が最初から無い→常にリセット) ✅
- 単純なカテゴリクリック(既存回帰) ✅

### `scripts/qa006-verify-advanced-and-category.ts` — 4件全件成功

```
node --experimental-strip-types scripts/qa006-verify-advanced-and-category.ts
```

`lib/inventory/advancedSearch.ts` の実物の `evaluateQuery` と、
`queries.ts` の `listInventoryAdvanced` slow-pathに書いたのと一字一句
同じAND結合ロジックを使い、実機repro相当のフィクスチャ(チェアだが
B000002を含まない行/B000002を含むが違うカテゴリの行、を含む4行)で検証。

- 絞り込み無しではadvだけで判定する(回帰確認) ✅
- カテゴリ『チェア』選択時、advとカテゴリの両方に一致する行だけを返す
  (実機reproの核心 — 見せかけの絞り込みではないことの確認) ✅
- カテゴリ+保管場所+advの3条件すべてに一致する行だけを返す ✅
- adv条件に一致する行が無いカテゴリを選ぶと0件 ✅

### 限界(実機検証が別途必要な範囲)

- 上記は「URL構築ロジック」と「AND結合の判定ロジック」を純粋関数として
  検証したものであり、Next.jsのServer Component(`page.tsx`)・
  DynamoDBへの実クエリ(`searchInventoryFast`/`fetchAllInventoryRecords`)・
  ブラウザでのLink遷移・モバイルのボトムシートは**未検証**
  (`next dev`/AWSアクセスがこの環境で使えないため)。
- 性能への影響は計測していない(計測未実施のため性能改善率は主張しない)。
  `extraFilters` を渡すことで高速経路(`searchInventoryFast`)のFilter
  Expressionに条件が1つ増えるが、既存のカテゴリ/保管場所絞り込み
  (クイック検索側)と同じ式を使っており、新しい種類のクエリではない。
- `ExportMenu`/`buildInventoryExport`(エクスポート)は詳細検索中は
  意図的にカテゴリ/保管場所を無視する別設計(`lib/inventory/inventoryExport.ts`
  のコメント参照)のままで、今回は変更していない——スコープ外
  (指示書「sidebarおよび必要最小の検索条件結合箇所」)。

## 監督者が3108/3109の実ブラウザで再確認する手順

1. 変更をこのブランチから3109(または相当のstaging)へ反映(このタスク
   自身はpush/deployを行っていない——指示どおり)。
2. `/inventory?q=B000002` → 詳細検索 → 在庫ID/含む/B000002 で検索
   (`adv=...&advanced=1` で1件表示になることを確認)。
3. 左サイドバーのカテゴリ『チェア』をクリック。
   - URLに `adv`/`advanced` が残っていること。
   - 詳細検索パネルが開いたままで、条件欄(在庫ID/含む/B000002)が
     消えていないこと。
   - 一覧が「チェアカテゴリ かつ 在庫IDにB000002を含む」の行だけに
     絞られること(該当行が無ければ0件表示になること — 無関係な
     チェア商品が紛れ込まないこと)。
   - ページャーが1ページ目にリセットされていること(2ページ目を見て
     いた場合)。
4. 保管場所も続けてクリックし、カテゴリ+保管場所+詳細検索の3条件すべて
   に一致することを確認。
5. 「すべて解除」(カテゴリ解除)→ 詳細検索条件(adv/advanced)と
   保管場所は残ったままカテゴリだけ外れることを確認。
6. 詳細検索パネルの「リセット」→ 素の `/inventory` に戻り、カテゴリ/
   保管場所/詳細検索すべてが消えることを確認(既存の明示的な全解除、
   変更していない箇所)。
7. 表示件数を100件に変更した状態でカテゴリを切り替え、100件表示が
   維持されることを確認(limit保持)。
8. 集計中に検証proxyでPOST 405が出る事象は今回のスコープ外(製品バグ
   としない、指示書の指示どおり)。

## 変更ファイル

- 新規: `lib/inventory/sidebarFilterHref.ts`
- 変更: `app/inventory/(protected)/InventorySidebar.tsx`,
  `app/inventory/(protected)/CategoryFilterList.tsx`,
  `app/inventory/(protected)/page.tsx`, `lib/inventory/queries.ts`
- 検証用(製品コミットに混入させない想定): `scripts/qa006-verify-sidebarFilterHref.ts`,
  `scripts/qa006-verify-advanced-and-category.ts`
- 前提として取り込んだ既存修正(`a7d647d`一致): `app/inventory/(protected)/DirectEditControls.tsx`,
  `app/inventory/(protected)/DirectEditProvider.tsx`,
  `app/inventory/(protected)/InventoryCardList.tsx`,
  `app/inventory/(protected)/InventoryTable.tsx`,
  `app/inventory/(protected)/InventoryToolbar.tsx`,
  `app/inventory/(protected)/[id]/edit/EditInventoryForm.tsx`,
  `app/inventory/(protected)/[id]/edit/page.tsx`,
  `app/inventory/(protected)/[id]/page.tsx`,
  `app/inventory/UnsavedChangesProvider.tsx`,
  `lib/inventory/listReturnParams.ts`(新規)
