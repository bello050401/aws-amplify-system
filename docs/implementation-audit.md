# BELLO統合業務OS — Requirement Inventory (2026-08-30, 第四ラウンド)

本表は「BELLO統合業務OS ZAICO級高速化・全性能監査・ボトルネック除去完全仕様書 兼 Claude Code 一回投入実装指示書」(以下「本仕様書」)§40の要求に基づく機械的な要件インベントリ。第三ラウンド報告(このセッション冒頭に「現状把握資料」として扱うよう指示された文書)の内容は「既存実装済みの現状」として引き継ぎ、本仕様書の完成Gate基準で再分類している。

凡例: **Implemented** = コード/IaC/テストが揃っている, **Partial** = 一部のみ, **Missing** = 未着手, **Broken** = 実装はあるが不具合あり(本ラウンドで修正), **Unverified** = 実装はあるがAWS/外部API未検証。

| # | 要件 | 現状分類 | 関連ファイル | 実装内容 | テスト | AWS検証 | 外部API検証 | 残課題 |
|---|---|---|---|---|---|---|---|---|
| P0-1 | ZAICO同期 baseline計測(100/300/1000/990+10new/990+10changed/画像変更/resume) | **Implemented** | `scripts/benchmark-zaico-sync.ts`, `performance/baseline-20260830.md` | 実`syncOneZaicoItem`をmock port(遅延モデル明記)で駆動、7ケース全て計測 | `npm run benchmark:zaico-sync -- --before/--fixed` | N/A(mock) | N/A | 実AWS環境でのCloudWatch実測は未実施(BLOCKED_BY_USER: AWS credential) |
| P0-2 | ZAICO同期 N+1 Scan除去(findExistingBySourceId) | **Implemented** (Broken→Fixed) | `lib/inventory/zaicoBackgroundSync.ts`, `zaicoSync.ts` | ページ毎に`fetchAllZaicoManaged()`をprefetch、商品毎の全件Scanを排除 | `verify:zaico`(48件, dbReads差分をcall-count assertionで検証) | Unverified(実DynamoDB未確認) | N/A | `sourceInventoryId`への実GSI+Query APIへの置換は未実施(技術的負債、baseline-20260830.md末尾に明記) |
| P0-3 | ZAICO同期 マスタ(Category/Location)N+1除去 | **Implemented** | `lib/inventory/zaicoSync.ts`(`masterCache`) | ページ/run単位のin-memory cache、cache miss時のみport呼び出し | `verify:zaico` | Unverified | N/A | なし |
| P0-4 | unchanged fast path(DB write/image DL/thumbnail生成=0) | **Implemented**(第三ラウンドから既存) | `lib/inventory/zaicoSync.ts` | 早期return設計、本ラウンドの修正前後どちらも維持 | `benchmark-zaico-sync.ts`, `verify:zaico` | Unverified | N/A | なし |
| P0-5 | ZAICO差分取得API(updated_since等)調査 | **Unverified/BLOCKED_BY_EXTERNAL_SERVICE** | — | 公式ドキュメントに該当パラメータの記載を本ラウンドで再確認できず | — | — | 未実施(推測実装禁止のため) | 公式ドキュメント/サポート回答待ち |
| P0-6 | ZAICO同期の完全無人化(Lambda化、ブラウザ非依存) | **Missing**(分析済み、未着手) | — | `syncOneZaicoItem`/`zaicoSyncPorts.ts`が`server-only`境界内にあり、pricing-scheduler/image-processing-workerと同じLambda化には`server-only`依存を持たない新Port実装への切り出しが必要と判明——本ラウンドでは着手せず | — | — | — | 次ラウンドの技術的負債として明記(下記Background Job監査参照) |
| P1-1 | 在庫一覧モバイル(375/390/430px、高密度カード) | **Implemented**(第三ラウンド以前から存在、本ラウンドで確認) | `app/inventory/(protected)/InventoryCardList.tsx`, `InventoryTable.tsx` | `md:hidden`/`md:block`で高密度カード一覧とPCテーブルを分離、サムネイル+名前+SKU+カテゴリ+場所+状態+数量+価格を1行で表示 | Playwright(公開ページ390pxのみ実施、保護route未実施) | Unverified(Cognito認証がこのサンドボックスで機能しないため実route未確認) | N/A | 実route E2Eは引き続きBLOCKED_BY_USER(AWS/Cognito) |
| P1-2 | フィルタUIの常時大画面占有回避 | **Implemented** | `app/inventory/(protected)/InventoryAdvancedSearchPanel.tsx`, `page.tsx` | URLパラメータ(`advanced=1`)によるトグル表示、既定非表示 | 未実施(コードレビューのみ) | — | — | 実機E2E未実施 |
| P1-3 | EC出品下書き 送料込み参考価格 | **Implemented** | `lib/shipping/referencePrice.ts`, `service.ts`, `ShippingReferencePriceSection.tsx` | plannedPrice+中央値、代表地域(東京/愛知県=名古屋圏/大阪府=大阪圏)、差額2000円以上の追加地域、データ不足時は非表示 | `verify:shipping`(+14件) | Unverified | N/A | 実データが東京都1地域のみのため、実運用では常時「データ不足」表示(データ拡充が必要、ユーザー操作ではなく地域データ追加の業務作業) |
| P1-4 | 送料データ不足時に推測値を出さない | **Implemented** | `lib/shipping/referencePrice.ts`(`MIN_DISTINCT_REGIONS_FOR_MEDIAN=3`) | 3地域未満は中央値を計算せず`INSUFFICIENT_DATA`を返す | `verify:shipping` | — | — | 閾値3は判断値(根拠となる公式データなし、コメントに明記) |
| 7 | 画像自動加工システム(前ラウンドで実装済み部分の再監査) | **Partial**(前ラウンドから変更なし) | `lib/imageProcessing/` | 決定論的パイプライン(crop/resize/tone/format)、Job/Version/PhotoProfile管理UI、5分毎Lambda worker | `verify:image-processing`(36件) | Unverified(未deploy) | N/A | 被写体segmentation・床クリーニング・RAW現像は実画像テストセットが無いため未実装(SPEC_UNCONFIRMED、変更なし) |
| 8 | Background Job基盤の全体監査(BASE pricingだけに限定されていないか) | **Implemented**(2種)+**Missing**(ZAICO) | `amplify/functions/pricing-scheduler/`, `amplify/functions/image-processing-worker/` | pricing-scheduler(BASE自動値下げ)とimage-processing-worker(画像加工)の2つが実在するLambda-nativeスケジュールジョブ——「BASE pricingだけ」ではない | `synth:check`でIAM実測 | Unverified(未deploy) | N/A | ZAICO同期はLambda化されていない(P0-6参照)——這い出すには`server-only`境界の再設計が必要、本ラウンドの範囲外として明記 |
| 9 | CSV/XLSX fixtureテスト | **Implemented** | `scripts/verify-import.ts` | RFC4180/BOM/round-trip/欠損セル/数値/日付/ヘッダーマッピング/XLSX実生成読み戻し、38件 | `verify:import` | N/A | N/A | AWS依存の`resolveImportRows`/`executeImportRows`はfixtureテスト対象外(コードレビューのみ) |
| — | ベンダー非依存AI Gateway/Router/QualityGate | **Implemented**(前ラウンド) | `lib/ai/gateway/` | 変更なし | `verify:ai-gateway`(27件) | Unverified | Anthropic APIキー無効のためBLOCKED | 前ラウンド報告通り |
| — | BASE OAuthスコープ修正 | **Implemented**(前ラウンド) | `lib/base/oauth.ts` | `write_items`スコープ追加 | — | Unverified | BLOCKED(BASE未接続) | 前ラウンド報告通り |
| — | Mercari update系ミューテーション | **BLOCKED_BY_EXTERNAL_SERVICE**(継続) | — | 実schema未確認 | — | — | 未実施 | 変更なし |
| — | 家財おまかせ便全国料金表 | **BLOCKED_BY_EXTERNAL_SERVICE**(継続) | `lib/shipping/ratesSeed.ts` | 東京都B/Cのみ | — | — | 未実施 | 変更なし(WebFetch遮断) |

## 本ラウンドで新たに判明した横断的な技術的負債

- **secondaryIndexesが宣言されているモデルの多く(Inventory, ChannelListing等)で、実際の読み取りが生成されたGSI Query関数ではなくfilter付き`.list()`(=DynamoDB Scan)になっている** — このリポジトリ全体で確認された共通パターン。P0の修正(prefetch+Map)で今回のZAICO同期の実害は解消したが、恒久的には各モデルの正しいIndex Query APIへの置き換えが望ましい。範囲が広いため本ラウンドでは対象外、次回監査項目として記録。
