# Inventory 実保護ルート E2E(375/390/430px)実施記録(第五ラウンド §7/P1-A)

作成日: 2026-08-30。実行: `npx playwright test`(`e2e/inventory-mobile.spec.ts`)。

## 何を実測したか(第四ラウンドまでの限界の再監査結果)

第四ラウンドまでの「モバイル対応完了」claimは、実際にはTailwindの
レスポンシブclass設計のコードレビューと、ログインページ(`/inventory/login`
——認証チェック自体が無い、静的に近いページ)のみのE2Eに留まっていた
——実際に認証が必要な一覧/詳細ページを本物のブラウザで描画して横
スクロールを実測したことは無かった。

この環境には実AWS(Cognito/AppSync)への到達経路が無いため
(`amplify_outputs.json`が`localstub.appsync-api...`という未デプロイ
プレースホルダ)、今回は以下の二重ゲート付きの安全なテスト専用経路を
新設し、**実際の保護ルート(`app/inventory/(protected)/layout.tsx`→
`page.tsx`/`[id]/page.tsx`、つまり本物のNavRail/MobileBottomNav/
InventoryHeader/InventoryToolbar/InventorySidebar/InventoryTable/
InventoryPagination一式)**を実際のChromiumで描画した:

- `lib/amplify/requireInventoryUser.ts`: `NODE_ENV!=='production'` AND
  16文字以上の秘密環境変数(`INVENTORY_E2E_AUTH_TOKEN`)AND一致する
  Cookieの3条件が揃わない限り絶対に通らない認証bypass。
- `lib/inventory/queries.ts` / `lib/inventory/e2eFixtures.ts`: 同じ
  二重ゲートで、DB読み取り関数(list/get系のみ、書き込み系には未適用)
  を固定fixtureへ差し替え。
- どちらもAmplify Hostingでは`NODE_ENV`が常に`production`になる
  (Next.js自体の標準挙動)ため、実デプロイでは構造的に絶対に発火しない
  ——詳細はコード内コメント/`docs/gsi-scan-audit.md`と同じ安全設計思想。

## 結果(実測、9/9合格)

| viewport | 未ログイン→/inventory/loginリダイレクト | 一覧ページ横スクロール | 詳細ページ横スクロール |
|---|---|---|---|
| 375px(iPhone SE相当) | ✓ | ✓(document/body scrollWidth ≤ clientWidth) | ✓ |
| 390px(iPhone 12/13相当) | ✓ | ✓ | ✓ |
| 430px(iPhone 14 Pro Max相当) | ✓ | ✓ | ✓ |

`document.documentElement.scrollWidth`/`body.scrollWidth`を
`clientWidth`と数値比較するassertion(目視/コードレビューではなく実測)。
実際のfixtureデータ(長い商品名・長いメモ文字列を含む)がテーブル/
カード内で正しく折り返され、はみ出していないことも確認済み(fixture内の
商品名テキストが`toBeVisible`で実際にDOMへ現れることを確認してから
オーバーフロー判定している)。

## この結果の正直な限界(過大に主張しない)

- **これは実際の`/inventory`ルートの実際のコンポーネントツリーの実測
  だが、実Cognitoログイン・実AppSyncデータでの実測ではない** ——
  fixtureデータはこのテスト専用に用意した固定値であり、実運用データの
  形状(極端に長い商品名、大量の画像、カスタムフィールド多数等)を
  全て網羅してはいない。
- 認証bypass/fixtureデータ経路自体は今回新規実装したコードであり、
  それ自体の安全性(実運用へ絶対に漏れないこと)は上記の二重ゲート
  設計とtypecheck/lint/`npm run build`(NODE_ENV=production下で
  ビルドが正常に通ることの確認)で担保しているが、実AWS環境
  (Amplify Hosting)上で「このbypassが本当に発火しないこと」を実機
  確認したわけではない(P1-B参照——AWSステージング自体が引き続き
  到達不能なため)。
- サムネイル画像(`InventoryThumbnail`)はfixtureデータに
  `mainImageStorageKey: null`しか無いため「No Image」プレースホルダの
  表示は確認できたが、実画像を伴うレイアウト崩れの有無はこのテストの
  対象外。

## 結論

「ログインページのみ」から「実保護ルート・実コンポーネントツリー・
375/390/430pxでの横スクロールゼロの数値実測」へ前進した——ただし
実Cognito/実AppSyncを伴わないため、分類は`LOCAL_VERIFIED`
(このsandbox内では確定的に再現・検証可能)に留め、`AWS_VERIFIED`とは
呼ばない。AWSステージングが到達可能になった時点で、この
`e2e/inventory-mobile.spec.ts`の認証部分を実Cognitoテストユーザーへ
差し替えるだけで同じテストが実環境の検証に転用できる
(コンポーネント/CSSレイヤー自体は既にこのラウンドで検証済み)。
