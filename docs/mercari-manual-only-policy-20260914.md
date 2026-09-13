# Mercari API不可の運用整合(2026-09-14)

task_4119e561a8a393bb85(先行候補、本タスクtask_5c2fdf659b3521b365で
継承・補正)。前提: ユーザーの運用ではMercari Shops APIへ実際に接続
できない(設定不足ではなく運用上の制約)。BASEは対象外(実接続可能、
維持)。

## 現行機能対応表

| 機能 | 実装状況 | 変更前の案内 | 変更後 |
|---|---|---|---|
| 出品下書き作成・AI下書き生成 | 実装済み・APIなし | 変更なし | 変更なし |
| Mercariカテゴリー選択 | TOKEN保存時にAPI読み取り試行、失敗時ID直接入力 | 「Mercari接続後は選択肢から選べる」 | 変更なし(read専用・失敗時は既に安全にフォールバック) |
| **Mercariへ実出品(createProduct)** | コード存在。`lib/integrations/writeGuard.ts`の`assertExternalWriteAllowed("MERCARI_SHOPS", …)`が送信直前で常に遮断(既定fail-closed、`EXTERNAL_WRITES_ENABLED`未設定) | TOKEN保存/接続確認(verified)だけで判定 → 「設定すれば出品できる」と誤認させていた | TOKEN/verifiedとは独立に`isExternalWriteEnabled("MERCARI_SHOPS")`で判定。falseの間はボタン自体を無効化し、状態をPUBLISHING→ERRORへ動かさない |
| Mercari自動値下げ(価格変更送信) | `lib/listing/pricingService.ts`のrunPricingCheckは元からMercariチャネルでは送信していない(`NOT_IMPLEMENTED`固定・判定のみ記録) | ルール設定・「自動値下げルールを設定」導線が、writesEnabled/manual-onlyの区別なく出ていた | 判定・記録機能自体は残す(既存下書き・履歴保全)が、ListingForm.tsxのAutoPricingSectionとListingsOverviewTable.tsxの導線にMercariへは実際に反映されない旨の注記を追加(能力判定=isExternalWriteEnabledの値に合わせた文言) |
| 手動出品支援(コピー) | 無し | – | 新規: `lib/listing/manualListingText.ts` + ListingForm.tsxの「出品内容をコピー」ボタン(外部送信なし、clipboardのみ) |
| BASE実出品/自動値下げ | `isExternalWriteEnabled("BASE")`で判定、設定パネルに状態表示あり | – | 変更なし(維持) |

## 根本原因

「実際にMercariへ送信してよいか」を決めているのは
`lib/integrations/writeGuard.ts`の`isExternalWriteEnabled("MERCARI_SHOPS")`
(AWS側の環境変数`EXTERNAL_WRITES_ENABLED`でのみ解除、既定false)だが、
UI側(ListingForm/一覧説明/設定パネル)はこれを見ずにTOKEN保存
(`mercariConnected`)や過去の接続確認(`verified`)だけで出品ボタンの
有効/無効・案内文言を決めていた。writeGuard自体は既に安全側で正しく
動いていたが、「TOKENさえ設定すれば出品できる」という案内が実態と
食い違っていた。

さらに途中レビューで、自動値下げ機能(AutoPricingSection/EC一覧の
「自動値下げルールを設定」)についても、Mercariチャネルの実送信が
既にNOT_IMPLEMENTED固定であるにも関わらず、UI文言が「有効にすると
自動で値下げされます」と読める形のままだったことが指摘された——判定・
記録自体は安全(送信しない)だが、案内文言がAPI利用可能であるかの
ような誤解を招きうるため、能力判定に合わせて文言を補正した。

## 設計方針

TOKEN保存/接続確認とは別に「実際に送信してよいか」を表す
`writesEnabled`(BASEの`lib/base/connectionState.ts`と同じ命名・同じ
判定源)を、Mercari側にも新設して唯一の判定源にする。

- `lib/listing/mercari/tokenAccess.ts`: `MercariConnectionState`に
  `writesEnabled: boolean`を追加(`isExternalWriteEnabled("MERCARI_SHOPS")`)。
- `lib/listing/publishFlow.ts`: `requireMercariWritesEnabled`(純関数)+
  `MERCARI_MANUAL_ONLY_MESSAGE`を追加。
- `lib/listing/service.ts`の`listOnMercari`: PUBLISHINGへ進める前に
  上記ガードを通す(adapter.tsのassertExternalWriteAllowedと二重の関門。
  UIまで来る前に無駄なPUBLISHING→ERROR遷移を避ける目的)。
- UI(ListingForm/ListingWorkspace/[id]/listing/page.tsx/listings/page.tsx/
  MercariSettingsPanel.tsx/SettingsTabs.tsx/settings/page.tsx):
  「Mercariに出品する」ボタンの有効化条件を`mercariConnected`から
  `mercariApiWritesEnabled`へ差し替え、案内文言を「TOKEN設定すれば使える」
  ではなく「現在の運用ではAPI送信を行っていない」を主導線にする。
- `lib/listing/manualListingText.ts`(新規): 下書きの内容をMercari出品
  画面へ貼り付けられる1テキストにまとめる純関数。ListingForm.tsxに
  「出品内容をコピー（手動出品用）」ボタンを追加(clipboard書き込みのみ、
  外部送信なし、mercariApiWritesEnabledの値に関わらず常時使える)。
- `app/inventory/(protected)/[id]/listing/AutoPricingSection.tsx`:
  `mercariApiWritesEnabled`を受け取り、判定・記録機能自体は無効化せず
  (既存の設定・履歴を保全)、「Mercariへの実際の価格変更（API送信）は
  行われない」旨を常に明示する注記を追加。チェックボックス・保存自体を
  disabledにはしていない — pricingService.ts側が既に送信しない構造の
  安全性を壊さない範囲での文言補正にとどめた。
- `app/inventory/(protected)/listings/ListingsOverviewTable.tsx`
  (+ `ListingsOverviewData.tsx`/`listings/page.tsx`): 「自動値下げ
  ルールを設定」ボタン群の下に、mercariApiWritesEnabledの値に応じた
  注記(判定・記録のみ／Mercariへは反映されない)を追加。ボタン自体は
  disabledにしない(ルール自体は複数チャネル共通のモデルであり、この
  導線からの割当がMercari専用であること自体は既存のPricingRuleAssignForm
  のコメントで既に明示されている)。

## 変更しなかったもの(意図的)

- `lib/integrations/writeGuard.ts`自体: 既に正しくfail-closed。今回は
  これを新たな判定源として"参照する側"を増やしただけで、解除条件
  (環境変数)は一切変えていない。
- Mercariカテゴリー取得(`listMercariCategoriesAction`): 読み取り専用で
  失敗時は既に空配列へ安全にフォールバック済み。API接続不可の環境では
  常に失敗するだけで実害はないため、スコープを絞り今回は触っていない。
- `lib/listing/pricingService.ts`のMercari分岐: 元から送信していない
  ため変更不要(NOT_IMPLEMENTED固定はwriteGuardの値に関わらず常に真——
  文言側で「なぜ動かないか」を能力判定に合わせて説明するにとどめた)。
- `PricingRulePanel.tsx`/`PricingRuleAssignForm.tsx`: 前者は既に
  `<details>`内で「実際の価格変更を送信するAPI呼び出し自体は…未実装」と
  正直に開示済み、後者も「実行はしません」という表現のみで実送信を
  主張していないため、この2箇所は変更不要と判断した(過剰な重複警告を
  増やさない)。
- BASE関連コード: 一切変更していない。
- `middleware.ts`(認証セッション更新境界、a41d7ee): 本タスクとは無関係
  の別系統の修正であり、変更してはいけない範囲(§6「認証修正との競合」)
  に該当するため、このtask_c4f0cdb3d86fbf3349の作業では一切触れていない
  (先行候補6d06295にはこのファイルの新規追加が含まれていたが、本タスク
  ではMercari manual-only関連の変更だけを取り込み、middleware.ts・
  scripts/verify-inventory-auth-middleware.ts・その関連mock・
  package.jsonの`verify:inventory-auth-middleware`スクリプト追加・
  lib/listing/overviewFailure.tsの認証調査コメント追記は取り込んでいない)。

## 試験

- `scripts/verify-publish-flow.ts`: `requireMercariWritesEnabled`が
  false/trueそれぞれで正しく振る舞うことを追加(`testMercariManualOnly`)。
- `scripts/verify-listing.ts`: `buildManualListingText`の内容を固定
  (`testManualListingText`)。
- 既存の`writeGuard`関連試験(`testExternalWriteGuard`)は無変更のまま
  再利用— 判定源を増やしただけで判定ロジック自体は変えていないため。
- AutoPricingSection/ListingsOverviewTableの文言補正はUI合成試験
  (`npx tsc --noEmit`)のみで確認——外部送信・状態遷移を一切伴わない
  純粋な表示分岐のため、既存の`testExternalWriteGuard`/
  `testMercariManualOnly`が引き続きこの部分の安全性(実送信されない
  こと自体)を担保する。

実行結果は完了報告のtests項目を参照。

## 残る課題

- `listMercariCategoriesAction`(カテゴリー読み取り)は今回スコープ外
  とした——将来「読み取りも含めて完全に停止する」方針になった場合は
  同じ`writesEnabled`(または別途readsEnabled相当)で揃える余地がある。
- `PricingRuleAssignForm.tsx`のチェックボックス文言(「この商品群で
  自動値下げを有効にする」)は、実送信を主張してはいないが「Mercariへは
  反映されない」旨までは書いていない——ListingsOverviewTable.tsx側の
  注記で導線全体をカバーしたため今回は据え置いたが、将来この画面単体
  で開かれる経路が増える場合は同様の注記を足す余地がある。
- 実ブラウザでの合成E2E(fixtureモード下でのUI操作確認)は本タスクの
  スコープ・予算内では未実施——`npx tsc --noEmit`と各`verify:*`
  スクリプトによる静的・ユニットレベルの検証にとどまる(下記完了報告
  参照)。
