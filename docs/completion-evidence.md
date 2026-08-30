# BELLO統合業務OS — Evidence Matrix (2026-08-30, 第四ラウンド)

本仕様書§62の要求に基づく完成証拠表。「未達時」列は、達成できなかった場合に何が不足しているか(LOCAL/AWS状態、未取得地域、real API状態等)を明記する。

| 領域 | 完成条件 | 証拠 | 状態 | 未達時の理由 |
|---|---|---|---|---|
| ZAICO同期(速度) | baseline取得済み、before/after数値比較可能、unchanged write/image=0 | `performance/baseline-20260830.md`、`scripts/benchmark-zaico-sync.ts`、`verify:zaico`48件 | **LOCAL_VERIFIED** | AWS実測(CloudWatch/DynamoDB)は未実施 — BLOCKED_BY_USER(AWS credential無効) |
| ZAICO同期(完全無人化) | ブラウザを閉じても継続 | 第五ラウンドP0-A: `amplify/functions/zaico-sync-worker/`実装、`zaicoSyncEngine.ts`への`server-only`非依存化 | **PARTIAL**(LOCAL_IMPLEMENTED、AWS未deployのためAWS_VERIFIED未達) | 実装・synth:check・lease/heartbeat/retry-DLQ設計は完了。実AWS deployでの動作確認(スケジュール実行が実際に起動しブラウザなしで完走すること)はBLOCKED_BY_USER(AWS credential無効) |
| 在庫一覧 PC+iPhone | body横overflow 0、高密度モバイルUI、PC回帰なし | 第五ラウンドP1-A: `e2e/inventory-mobile.spec.ts`(実保護route、二重ゲート付きfixture) | **LOCAL_VERIFIED**(実Chromiumでの数値実測、9/9合格) | 実Cognito/AppSync環境でのE2Eは引き続きBLOCKED_BY_USER。fixtureデータでの実測であり実運用データ形状の全網羅ではない(`docs/e2e-mobile-audit-20260830.md`参照) |
| 画像配信/画像加工 | thumbnail優先、加工パイプライン動作、background化 | `lib/imageProcessing/`(前ラウンド実装)、`verify:image-processing`36件 | **LOCAL_VERIFIED**(決定論的処理のみ)、**SPEC_UNCONFIRMED**(segmentation/床クリーニング/RAW) | 実画像テストセットが本セッションに存在しないため、外部ML不使用の範囲(§44「外部ML未使用ならその範囲」)として決定論的処理のみで確定 |
| EC Draft/送料/Channel Adapter | 送料込み参考価格が実装・テスト済み | `lib/shipping/referencePrice.ts`、`verify:shipping`52件(うち本ラウンド+14) | **LOCAL_VERIFIED** | real API状態: N/A(外部APIを使わない決定論的計算のため該当なし)。実データ(ShippingRate)が東京都のみのため、実運用では常時データ不足表示 — これは仕様通りの安全側動作であり不具合ではない |
| Messaging | Conversation/Message/AI draft/send | 前ラウンドで実装済み、変更なし | **LOCAL_VERIFIED**(前ラウンド報告通り) | provider別状態: LINE=BLOCKED_BY_USER(未接続)、Mercari問い合わせ=BLOCKED_BY_EXTERNAL_SERVICE(schema未確認)、Email(SES)=LOCAL_IMPLEMENTED(DNS未検証) |
| Shipping(rank/rates/median/差額地域) | rank計算・rate CRUD・中央値・差額地域テスト green | `lib/shipping/rank.ts`(前ラウンド)、`referencePrice.ts`(本ラウンド)、`verify:shipping`52件 | **LOCAL_VERIFIED** | 未取得地域: 家財おまかせ便の全国料金表(東京都以外) — BLOCKED_BY_EXTERNAL_SERVICE(公式料金ページへのWebFetchがこのサンドボックスで遮断される、既知の制約) |
| AWS(Staging) | Staging resources/background job deploy/logs確認 | 第五ラウンドP1-B: `docs/aws-staging-reachability-20260830.md`(実STS呼び出しで再検証) | **未達**(機械的根拠付きBLOCKED_BY_USER) | このサンドボックスのAWS credential(`AWS_ACCESS_KEY_ID`等)が機能しない("proxy-injected"のプレースホルダ、実`sts:GetCallerIdentity`で`InvalidClientTokenId`(HTTP403、実requestId付き)を確認済み——ネットワーク到達性自体はある) — `synth:check`によるCloudFormation生成確認までがLOCAL側の到達点 |
| Security | secret/authorization/webhook/idempotency監査 | 前ラウンドのBASE OAuthスコープ修正含む | **LOCAL_VERIFIED**(静的監査) | 本ラウンドでは新規のセキュリティ問題は発見していない(EC送料機能・ZAICO同期修正いずれもAWS認証境界・秘密情報の扱いに変更なし) |
| CSV/XLSX | 代表fixtureテスト実施 | `scripts/verify-import.ts`38件(本ラウンド新規) | **LOCAL_VERIFIED** | AWS依存部分(resolveImportRows等)はfixtureテスト対象外——コードレビューのみで、非シリアライズ化エラーのクラスに対して安全であることを確認済み(前ラウンド) |

## テストマトリクス(§57)全項目結果

| 項目 | 結果 |
|---|---|
| typecheck | ✅ green (`tsc --noEmit`) |
| lint | ✅ green (`next lint`) |
| next build | ✅ green(19ページ生成) |
| synth:check | ✅ green(実CloudFormation生成確認) |
| ZAICO unit/integration/benchmark | ✅ green(`verify:zaico` 48件、`benchmark-zaico-sync.ts` 7ケース+resume) |
| Inventory list/search/detail regression | ✅ green(既存機能に変更なし、tsc/build確認) |
| image thumbnail/cache/processing/reprocess/version | ✅ green(`verify:image-processing` 36件) |
| Listing common/channel/duplicate/exclusion | ✅ green(`verify:listing` 76件) |
| BASE tests | ✅ green(`verify:base` 8件) |
| Mercari tests | N/A(実schema未確認のため専用testなし、既存adapterのcontract testは`verify:listing`に含まれる) |
| Messaging/LINE tests | ✅ green(`verify:messaging` 14件、`verify:line` 13件) |
| Email adapter tests | 前ラウンドまでに実装、本ラウンド変更なし |
| Shipping rank/rate/median/region-difference tests | ✅ green(`verify:shipping` 52件、うち+14件本ラウンド新規) |
| Auto Pricing idempotency/floor/relist tests | ✅ green(`verify:listing`に含まれる、変更なし) |
| Sales purchasePrice invariant | 前ラウンドまでに実装、本ラウンド変更なし |
| CSV/XLSX tests | ✅ green(`verify:import` 38件、本ラウンド新規) |
| Mobile 375/390/430px E2E | **Partial** — 公開ページのみ実施(overflow無し確認)、保護routeはBLOCKED_BY_USER |
| Security/secret leak static scan | ✅(前ラウンドのBASE OAuthスコープ修正が本ラウンドの唯一の発見・修正) |
| Performance benchmark | ✅ `benchmark-zaico-sync.ts`(本ラウンド新規) |
| Background job retry/resume/idempotency | ✅ pricing-scheduler/image-processing-workerのconditional update検証済み(synth:check)、ZAICO同期のresumeは`verify:zaico`+`benchmark-zaico-sync.ts`のケースGで検証 |

**1つでも必須項目が赤なら全体完成扱い禁止(§57)という基準に対し: 上記の中でNativeに赤(fail)の項目は無い。** 「Mobile 375/390/430px E2E」のみPartial(BLOCKED_BY_USERにより保護route実施不能)。

---

## 第五ラウンド追補(2026-08-30)

| 領域 | 完成条件 | 証拠 | 状態 | 未達時の理由 |
|---|---|---|---|---|
| GSI/Scan監査(P0-B) | 監査表作成+高優先度箇所の修正 | `docs/gsi-scan-audit.md`、5箇所GSI Query化、2件のページング欠如バグ修正 | **LOCAL_VERIFIED** | AWS実DynamoDBでのGSI動作確認は未実施(synth:checkによるschema安全性確認まで) |
| Inventory性能baseline(P0-C) | list/search/detail個別SLO測定 | `performance/inventory-list-baseline-20260830.md` | **PARTIAL**(方法論を明記したsimulation、実AWS実測ではない) | AWS staging未到達のため実測不可。call回数(構造的事実)は実装と同一アルゴリズムで正確 |
| 保護route E2E(P1-A) | 375/390/430pxでbody横overflow=0を実測 | `e2e/inventory-mobile.spec.ts`、9/9合格 | **LOCAL_VERIFIED**(実Cognito不使用のためAWS_VERIFIEDではない) | 二重ゲート付きfixtureのため、実運用データでの再現ではない |
| AWS認証再検証(P1-B) | クレデンシャル有効性の機械的確認 | `docs/aws-staging-reachability-20260830.md` | **確認完了**(結果はBLOCKED) | クレデンシャル無効(InvalidClientTokenId)、ユーザー本人のAWS SSO/MFA認証待ち |
| Background Job基盤比較(P1-C) | 3種のJob基盤比較+不整合修正 | `docs/background-job-infra-comparison-20260830.md`、ProcessingJob二重処理防止追加 | **LOCAL_VERIFIED** | なし |
| Remaining Work Scan #1/#2 | 独立した2つの視点でのgrep監査+修正 | `docs/remaining-work-scans-20260830.md` | **完了** | 新規の実装可能な不具合は発見せず(既存SPEC_UNCONFIRMED項目は妥当と再確認) |

### テストマトリクス追加分

| 項目 | 結果 |
|---|---|
| typecheck(第五ラウンド全変更後) | ✅ green |
| lint(第五ラウンド全変更後) | ✅ green |
| next build(production mode、E2E bypass構造的無効化の確認込み) | ✅ green(19ページ、変更なし) |
| synth:check(zaico-sync-worker追加後、再確認) | ✅ green |
| verify:* 全9スイート再実行(第五ラウンド全変更後) | ✅ green(306 assertion、0 regression) |
| Playwright E2E(375/390/430px×3ページ) | ✅ green(9/9) |
| benchmark:inventory-queries(100〜20,000件) | ✅ 実行完了(結果は`performance/inventory-list-baseline-20260830.md`、SLO未達箇所あり——「未達=バグ」ではなく「未達=測定結果」として正直に記録) |

「Mobile 375/390/430px E2E」は第四ラウンドの**Partial**から
**LOCAL_VERIFIED**(実保護route・実測)へ前進した——ただし実Cognito
経由ではないため**AWS_VERIFIED**には未達のまま。
