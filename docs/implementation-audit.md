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
| P0-6 | ZAICO同期の完全無人化(Lambda化、ブラウザ非依存) | **第五ラウンドでImplemented**(旧: Missing) | `lib/inventory/zaicoSyncEngine.ts`(新設、`server-only`非依存へ切り出し)、`amplify/functions/zaico-sync-worker/`(新設Lambda一式) | `syncOneZaicoItem`等の純粋/AWS非依存ロジックを`zaicoSyncEngine.ts`へ抽出(`npx tsx`直接importで`server-only`混入ゼロを実測確認)、5分毎スケジュールLambda+lease/heartbeat/retry-DLQ+既存`generate-sku` Lambda再利用 | `verify:zaico`(48件)+`synth:check`(IAM実測) | Unverified(未deploy、UPDATE経路はGSI安全性をsynth実測で確認済み、CREATE経路はAWS_VERIFIED未達) | N/A | ブラウザ手動advanceとの共存はlease機構で調整済み。詳細は`docs/background-job-infra-comparison-20260830.md` |
| P1-1 | 在庫一覧モバイル(375/390/430px、高密度カード) | **第五ラウンドでLOCAL_VERIFIED**(旧: 公開ページのみE2E) | `app/inventory/(protected)/InventoryCardList.tsx`, `InventoryTable.tsx`, `e2e/inventory-mobile.spec.ts` | 二重ゲート付きE2E専用fixture/認証bypassで実保護route(layout+page+NavRail+Header+Toolbar+Sidebar+Table)を実Chromiumで描画、横スクロールを数値実測 | `npx playwright test`(9/9合格) | N/A(実Cognito/AppSyncを経由しないためAWS_VERIFIEDではない) | N/A | 実Cognito環境でのE2Eは引き続きBLOCKED_BY_USER(AWS/Cognito到達不能、詳細`docs/e2e-mobile-audit-20260830.md`) |
| P1-2 | フィルタUIの常時大画面占有回避 | **Implemented** | `app/inventory/(protected)/InventoryAdvancedSearchPanel.tsx`, `page.tsx` | URLパラメータ(`advanced=1`)によるトグル表示、既定非表示 | 未実施(コードレビューのみ) | — | — | 実機E2E未実施 |
| P1-3 | EC出品下書き 送料込み参考価格 | **Implemented** | `lib/shipping/referencePrice.ts`, `service.ts`, `ShippingReferencePriceSection.tsx` | plannedPrice+中央値、代表地域(東京/愛知県=名古屋圏/大阪府=大阪圏)、差額2000円以上の追加地域、データ不足時は非表示 | `verify:shipping`(+14件) | Unverified | N/A | 実データが東京都1地域のみのため、実運用では常時「データ不足」表示(データ拡充が必要、ユーザー操作ではなく地域データ追加の業務作業) |
| P1-4 | 送料データ不足時に推測値を出さない | **Implemented** | `lib/shipping/referencePrice.ts`(`MIN_DISTINCT_REGIONS_FOR_MEDIAN=3`) | 3地域未満は中央値を計算せず`INSUFFICIENT_DATA`を返す | `verify:shipping` | — | — | 閾値3は判断値(根拠となる公式データなし、コメントに明記) |
| 7 | 画像自動加工システム(前ラウンドで実装済み部分の再監査) | **Partial**(前ラウンドから変更なし) | `lib/imageProcessing/` | 決定論的パイプライン(crop/resize/tone/format)、Job/Version/PhotoProfile管理UI、5分毎Lambda worker | `verify:image-processing`(36件) | Unverified(未deploy) | N/A | 被写体segmentation・床クリーニング・RAW現像は実画像テストセットが無いため未実装(SPEC_UNCONFIRMED、変更なし) |
| 8 | Background Job基盤の全体監査(BASE pricingだけに限定されていないか) | **第五ラウンドでImplemented**(3種全て) | `amplify/functions/pricing-scheduler/`, `amplify/functions/image-processing-worker/`, `amplify/functions/zaico-sync-worker/` | pricing-scheduler(BASE自動値下げ)・image-processing-worker(画像加工)・zaico-sync-worker(ZAICO同期、第五ラウンドP0-Aで新設)の3つが実在するLambda-nativeスケジュールジョブ——「BASE pricingだけ」ではないことが完全に確定 | `synth:check`でIAM実測 | Unverified(未deploy) | N/A | 3種の横断比較・不整合修正は`docs/background-job-infra-comparison-20260830.md`参照(ProcessingJobの二重処理防止漏れを発見・修正) |
| 9 | CSV/XLSX fixtureテスト | **Implemented** | `scripts/verify-import.ts` | RFC4180/BOM/round-trip/欠損セル/数値/日付/ヘッダーマッピング/XLSX実生成読み戻し、38件 | `verify:import` | N/A | N/A | AWS依存の`resolveImportRows`/`executeImportRows`はfixtureテスト対象外(コードレビューのみ) |
| — | ベンダー非依存AI Gateway/Router/QualityGate | **Implemented**(前ラウンド) | `lib/ai/gateway/` | 変更なし | `verify:ai-gateway`(27件) | Unverified | Anthropic APIキー無効のためBLOCKED | 前ラウンド報告通り |
| — | BASE OAuthスコープ修正 | **Implemented**(前ラウンド) | `lib/base/oauth.ts` | `write_items`スコープ追加 | — | Unverified | BLOCKED(BASE未接続) | 前ラウンド報告通り |
| — | Mercari update系ミューテーション | **BLOCKED_BY_EXTERNAL_SERVICE**(継続) | — | 実schema未確認 | — | — | 未実施 | 変更なし |
| — | 家財おまかせ便全国料金表 | **BLOCKED_BY_EXTERNAL_SERVICE**(継続) | `lib/shipping/ratesSeed.ts` | 東京都B/Cのみ | — | — | 未実施 | 変更なし(WebFetch遮断) |

## 本ラウンドで新たに判明した横断的な技術的負債(第四ラウンド時点)

- **secondaryIndexesが宣言されているモデルの多く(Inventory, ChannelListing等)で、実際の読み取りが生成されたGSI Query関数ではなくfilter付き`.list()`(=DynamoDB Scan)になっている** — このリポジトリ全体で確認された共通パターン。P0の修正(prefetch+Map)で今回のZAICO同期の実害は解消したが、恒久的には各モデルの正しいIndex Query APIへの置き換えが望ましい。範囲が広いため本ラウンドでは対象外、次回監査項目として記録。

---

# 第五ラウンド追補(2026-08-30、実運用到達・超高解像度完全自律実装指示)

分類凡例に **PARTIAL** を追加(第五ラウンド仕様書の要求) —
実装・テストの一部は完了しているが、AWS/外部API検証等の完成Gateを
満たしていない状態。**PARTIALをLOCAL_VERIFIEDへ丸めない**。

| ID | 領域 | 要件 | 現状 | 証拠 | テスト | 環境 | 分類 | ブロッカー | 残作業 | 優先度 |
|---|---|---|---|---|---|---|---|---|---|---|
| R5-P0A | ZAICO | 完全ブラウザ非依存Background Job化 | `amplify/functions/zaico-sync-worker/`実装済み、lease/heartbeat/retry-DLQ実装 | `synth:check`、コード | `verify:zaico`(48件) | Local | **PARTIAL** | AWS未deploy、CREATE経路の実AppSync読み戻し未確認 | AWSステージングでの実deploy+実データ確認 | P0 |
| R5-P0B | 全体 | GSI/Query/Scan監査表+高優先度修正 | `docs/gsi-scan-audit.md`、5箇所をGSI Query化、2件の正確性バグ修正 | `synth:check`(schema安全性)、grep監査 | 306 assertion(regression無し) | Local | **LOCAL_VERIFIED** | なし | なし | P0 |
| R5-P0C | Inventory | 一覧/検索/詳細 性能baseline実測 | `performance/inventory-list-baseline-20260830.md` | ベンチマークスクリプト(手法明記のsimulation) | `benchmark:inventory-queries` | Local(simulation) | **PARTIAL** | 実AWS環境での実測値ではない(方法論に明記) | AWSステージングでの実測 | P0 |
| R5-P1A | Inventory | 実保護route 375/390/430px E2E | `e2e/inventory-mobile.spec.ts`、二重ゲート付きfixture/bypass | 実Chromium実行 | 9/9合格 | Local(fixture) | **LOCAL_VERIFIED**(実Cognito不使用のためAWS_VERIFIEDではない) | 実Cognito環境到達不能 | AWSステージング到達時に認証部分だけ実ユーザーへ差し替え | P1 |
| R5-P1B | インフラ | AWS認証情報/ステージング到達性再検証 | `docs/aws-staging-reachability-20260830.md` | 実`@aws-sdk/client-sts`呼び出し(本物のAWS 403応答) | — | — | **BLOCKED_BY_USER**(機械的根拠付き) | クレデンシャル自体が無効(InvalidClientTokenId) | ユーザー本人のAWS SSO/MFA認証 | P1 |
| R5-P1C | インフラ | Background Job基盤横断比較+不整合修正 | `docs/background-job-infra-comparison-20260830.md`、ProcessingJob二重処理防止追加 | `synth:check`、コード | `verify:image-processing`(36件) | Local | **LOCAL_VERIFIED** | なし | なし | P1 |
| R5-P2 | 全体 | 実写真/外部仕様が無い範囲での前進 | Scan #1/#2実施、新規の実装可能な不具合は発見せず(既存のSPEC_UNCONFIRMED項目は全て根拠が明記済みで妥当と再確認) | grep監査 | — | Local | **確認完了**(現状維持が妥当) | 実写真/外部API仕様 | ユーザーによる実写真提供・外部API公式確認 | P2 |

## 第四ラウンド claims再監査(第五ラウンド仕様書の要求)

第四ラウンド報告(このセッション冒頭の要約に記載)が「未完了」として
残した項目のうち、本ラウンドで新たに完了/前進したもの:

1. **ZAICO同期のブラウザ非依存化** — 第四ラウンド時点でMissing(分析のみ)
   だったものを、本ラウンドで実際にLambda一式を実装(R5-P0A)。
2. **`sourceInventoryId`への実GSI/Query未実装** — 第四ラウンド時点の
   既知の技術的負債。本ラウンドではZAICO同期自体のprefetch方式
   (既に全件を1回で読む設計)を維持しつつ、**別の**5箇所
   (InventoryHistory/ListingDraft/ChannelListing/Message×2)で実際に
   GSI Query化を実施——`sourceInventoryId`自体は元々「全件prefetch
   して照合」という、GSI Query 1件ずつ呼ぶより効率的な設計を既に採用
   しているため、GSI化の優先度は相対的に低いと判断し据え置いた
   (`docs/gsi-scan-audit.md`に明記)。
3. **repo全体のsecondaryIndexes未使用パターン** — 第四ラウンドで
   「発見したが未修正」だったものを、本ラウンドでP0-Bとして体系的に
   監査・修正(`docs/gsi-scan-audit.md`)。
4. **Inventory一覧/検索/詳細の性能baseline未測定** — 第四ラウンド時点で
   未実施。本ラウンドでP0-Cとして実施、SLO未達箇所(戻る操作、5000件超
   規模)を具体的に特定。
5. **保護route 375/390/430px実E2E未実施** — 第四ラウンド時点で
   ログインページのみ。本ラウンドでP1-Aとして実保護route(fixture経由)
   のE2Eを実施。
6. **AWS staging/Cognito/実外部API未検証** — 継続してBLOCKED——ただし
   本ラウンドで「なぜBLOCKEDか」を機械的証拠(実STS呼び出しの
   InvalidClientTokenId)で確定させた(第四ラウンドまでは推測/前提)。
7. **BASE/Mercari/LINE/Email** — 変更なし(実OAuth/外部API未接続のため
   本ラウンドのスコープ外、Scan #1/#2で新規の実装可能な不具合が無いこと
   を再確認済み)。
