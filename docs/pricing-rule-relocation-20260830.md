# 自動値下げルール — 設定→EC出品移設・一括割当(第六ラウンド P0-3)

作成日: 2026-08-30。

## 調査結果(§131「商品単位かchannel listing単位か曖昧にしない」)

`amplify/data/resource.ts`のChannelListingモデルを確認した結果、
`pricingRuleId`/`autoPricingEnabled`/`automationHold`/`originalPrice`/
`currentPrice`/`floorPrice`/`nextPriceActionAt`は全て**ChannelListing**
(商品×チャネルの組)が保持する——Inventory本体には一切無い。現状
実装済みのチャネルはMercari Shopsのみ(`lib/listing/pricingService.ts`
の`setAutoPricingForListing`が内部で`"MERCARI_SHOPS"`固定)のため、
今回のEC出品一覧からの一括適用も同じ前提(対象チャネル=Mercari Shops)
を明示した上で実装した。将来チャネルが増えた場合は、この前提を
明示している箇所(コード内コメント)を起点に拡張できる。

## 実装内容

### 1. 主導線の移設(§113/§117/§118)

- 新設: `/inventory/listings/pricing-rules`(ルール一覧・作成・編集・
  複製・無効化) — 既存の`PricingRulePanel`コンポーネントをそのまま
  再利用(複製していない、importパスの変更のみ)。
- `設定`画面の「自動値下げルール」タブは、ロジック付きUIを削除し、
  新画面へのリンクのみへ変更した(§118「同じ設定が二箇所で編集
  できる状態を避ける」)。
- 既存のPricing Rule Engine(`lib/listing/pricingService.ts`、
  `amplify/functions/pricing-scheduler`)・DBモデル(PricingRule/
  PriceHistory)は一切変更していない(§119「複製しない」)。

### 2. 一括ルール割当導線(§122-131)

- EC出品一覧(`ListingsOverviewTable.tsx`)の既存「選択した商品の
  出品下書きを一括作成」ボタンの隣に「自動値下げルールを設定」
  ボタンを追加。
- 選択商品IDは**URLへ一切含めない**(§127「431再発防止」) —
  `sessionStorage`経由で新設の`/inventory/listings/pricing-rules/assign`
  ページへ引き渡す(`lib/listing/pricingAssignmentSelection.ts`、
  理由はファイル冒頭コメントに明記)。新しいAWSモデル/TTL管理を
  このためだけに追加するのは過剰設計と判断した。
- 割当ページ(`PricingRuleAssignForm.tsx`)は選択商品数・対象チャネル
  ・各商品の現在ルール有無を表示し(§128)、ルール選択→適用前
  confirmation相当の一覧表示→適用、という流れ。適用は既存の
  `setAutoPricingForListing`(商品1件単位、新規ロジックなし)を
  ループで呼び出す`bulkAssignPricingRuleAction`が行い、商品単位の
  成功/失敗を記録して返す(§130/§146「一部失敗で全件成功表示
  しない」)。
- まだChannelListing未作成(=出品準備未実施)の商品は、適用前の
  画面で件数を明示し、実際の適用時は既存の「先にMercariのカテゴリー
  設定を保存してください」エラーとして商品単位で失敗記録される
  (§143 — draft/listing生成を強制する新ロジックは追加せず、既存の
  自然な失敗理由をそのまま活かす設計)。

### 3. 新規コードのエラー伝達パターン

`bulkAssignPricingRuleAction`は、第六ラウンドP0-1で確立した
「Server Actionのエラーはthrowでなくreturnで伝える」パターン
(`{ok,error,correlationId}`)を最初から採用している
(`docs/ai-draft-error-root-cause-20260830.md`参照)。

## この回で完全には検証できなかったこと(正直な記録)

§141「selection 0件、1件、50件、300件相当をtest」は、E2Eレベルでの
網羅テストは実施していない(既存のE2E fixture harness — 第五ラウンド
P1-A — がlistListingsOverviewAction/listPricingRulesActionまでは
fixture化していないため、追加のfixture配線が必要)。`bulkAssignPricingRuleAction`
自体のループ処理は単純な直列forループであり、件数によって挙動が
変わるロジックは無いため、少数件でのtypecheck/lint/build通過を
もって**PARTIAL**(件数別の実挙動を実機/E2Eで確認済みとまでは
言えない)と分類する。

## 回帰確認

`tsc`/`next lint`/`npm run build`(production、新規2ルート含む19→21
ページ)/`verify:*`全9スイート(326 assertion)/`playwright test`(9/9)
——全てgreen。
