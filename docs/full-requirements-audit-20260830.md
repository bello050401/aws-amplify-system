# BELLO 全仕様 × Git実装 × AWS × Staging 監査 (2026-08-30)

改訂版指示書 §4〜§6 / §13 に対応する監査記録。**この文書の判定はすべて
実測に基づく**——過去ラウンドの「完了」という記述は証拠として採用して
いない。一方で、Stagingに反映されていなかったことだけを根拠に
「未実装」とも判定していない(指示書 §20)。

## 1. 仕様書コーパス(発掘結果)

`C:\Users\win\Downloads` に BELLO 関連の仕様書が6本存在した
(`C:\Users\win\Documents` と `Desktop` にはBELLO仕様書は無し)。

| ID | 文書 | 行数 | 位置づけ |
|---|---|---|---|
| MASTER | BELLO_ClaudeCode_一回投入_完全自律実装_最終超詳細指示書_20260830.md | 3,111 | **本体仕様**。§0〜§152。コード内コメントが参照する §125/§161/§51-52/§24/§26/§92/§126 等の出典 |
| FIXR7 | BELLO_在庫管理_不具合修正_ZAICO重複根絶_EC出品_画像自動加工_..._20260830.md | 921 | Round 7 の不具合修正指示 |
| LISTUI | BELLO_inventory_latest_consolidated_instruction.md | 771 | 在庫一覧UI・検索・表示設定・一覧直接編集・商品詳細2列化 |
| PWA | BELLO_iPhone_PWA_実装指示書.md | 1,310 | iPhone/PWA 実装 |
| PREV | BELLO_全過去仕様_..._ClaudeCode完全自律指示書_20260830.txt | — | 改訂版の前版(SUPERSEDED) |
| CURRENT | BELLO_全過去仕様_..._改訂版_20260830.txt | — | **現行の作業指示** |

これら4本(MASTER/FIXR7/LISTUI/PWA)から見出し単位で **270件** の
Requirement 節を機械抽出した(MASTER 181 / FIXR7 21 / LISTUI 32 / PWA 36)。

参考: 社内規程集 `BELLOインテリア_社内規程集.docx` も存在するが、
システム仕様ではなく社内規程のため本監査の対象外とした。

## 2. Git資産の発掘結果

| 項目 | 実測値 |
|---|---|
| 全ref上のcommit数 | 142 |
| リモートブランチ | 7 |
| 現行branch (`claude/inventory-management-system-5vbvc7`) | main と 127 commits 差 |
| `8b145f6`(長期間最後の成功build) 以降のcommit | 41 |
| 履歴上で削除されたファイル | `app/inventory/InventoryTopBar.tsx`, `index.html` |

### 現行branchに取り込まれていない他branchの資産

| branch | 未取込commit | 内容 |
|---|---|---|
| `claude/mercari-shops-auto-listing-ag0w6m` | 2 | Mercari Shops 自動出品(配送方法の動的取得・配送設定作成フロー・単体テスト)。MASTER §30/§37 の Channel Adapter 検討時に**再利用候補**(指示書§12「Mercari old branch asset reuse」) |
| `claude/image-fetch-api-5r217s` | 2 | `zaico-verification/` の ZAICO API 検証スクリプト(inventory_attachments endpoint 確認を含む) |
| `claude/new-session-me2dw3` | 1 | Amplifyバックエンド初期構築 + PWA の初期案 |
| `claude/create-feature-page-n9tmni` | 0 | 現行branchへ取込済 |

## 3. 実在するもの(事実インベントリ)

「仕様がある/無い」ではなく「**実際に何が存在するか**」を先に確定した。
再実装を避けるための基礎データ。

- **ルート 19本**: `/inventory`(一覧)・`/inventory/[id]`(詳細)・`/[id]/edit`・
  `/[id]/listing`(EC出品詳細)・`/inventory/listings`・`/listings/pricing-rules`・
  `/pricing-rules/assign`・`/inventory/messages`・`/inventory/sales`・
  `/inventory/new`・`/inventory/settings`・`/inventory/login` ほか
- **API route 4本**: `/api/base/oauth/{start,callback}`・`/api/inventory/export`・
  `/api/line/webhook`
- **Server Actions 21本**: ai / base / customFields / features / imageProcessing /
  inventory / inventoryBulkEdit / inventoryImport / lineSecret / listing /
  listingPartitionBackfill / masters / mercariSecret / messaging / pricing /
  shipping / systemAudit / thumbnailBackfill / zaicoDuplicateAudit /
  zaicoSecret / zaicoSync
- **データモデル**: Inventory / InventoryHistory / Category / Location /
  StatusMaster / UnitMaster / CustomFieldDefinition / ZaicoSyncJob /
  **ZaicoSourceLink** / ListingDraft / ChannelListing / PriceHistory /
  PricingRule / Conversation / Message / ShippingRate / ShippingImportBatch /
  ProcessingJob / ImageProcessingVersion / PhotoProfile / AIUsageLog /
  BaseItemCache / BaseOAuthToken / Feature / FeatureItem ほか
- **libモジュール 11**: ai / amplify / base / features / imageProcessing /
  inventory / listing / messaging / shipping / systemAudit / zaico
- **AWS(Staging `d4hkkg7dty2du`)**: Lambda 4本(generate-sku /
  pricing-scheduler / image-processing-worker / zaico-sync-worker)、
  EventBridge Scheduler 3本、DynamoDB テーブル群、Cognito、S3

## 4. 実測で確定した「本当に未実装」

キーワード検索の一致だけでは判定しない(270件中269件が何らかの語で
一致してしまい判別に使えなかった)。**成果物の実在**で判定した。

| 仕様 | 判定 | 根拠(実測) |
|---|---|---|
| PWA (PWA §3) | **NOT_IMPLEMENTED** | Web App Manifest なし・Service Worker なし・apple touch icon なし・theme/background color 指定なし・`package.json` に PWA 系依存ゼロ。`public/` の中身は `bello-system-icon.png` 1件のみ |
| 通知 (MASTER §131) | **NOT_IMPLEMENTED** | notification 関連のモジュール・モデル・ルートが存在しない |
| Instagram (§11-O) | **NOT_IMPLEMENTED** | 該当ファイルなし。将来integration |
| MoneyForward (§11-P) | **NOT_IMPLEMENTED** | 該当ファイルなし。将来integration |
| 画像の自動分類モデル (§7) | **NOT_IMPLEMENTED** | `amplify/data/resource.ts:165,264` が自認。DAMAGE/NORMAL は既定値補完のみ |
| Mercari 実価格変更 | **NOT_IMPLEMENTED**(意図的) | `pricing-scheduler/handler.ts:173`「Mercariはupdate系ミューテーションの実schema未確認のため、Lambdaからも実送信しない(§157)」 |
| Mercari status sync | **NOT_IMPLEMENTED** | `resource.ts:860` が自認。`currentPrice` の実一致は保証されない |
| 出品終了(売却以外)のトリガー | **スキーマのみ** | `resource.ts:836` が自認 |
| メッセージ添付の解析 (§53) | **NOT_IMPLEMENTED**(表示のみ) | `resource.ts:1016` が自認 |

### 誤判定しかけて、実装済みだったもの

「ファイル名で探すと見つからない」だけのものを未実装と誤断しない
ために記録する。

| 仕様 | 実際 | 所在 |
|---|---|---|
| 古物台帳・仕入情報の9項目順序 (LISTUI §19) | **実装済み・順序も仕様どおり** | `app/inventory/(protected)/[id]/page.tsx:170-181` の `usedGoodsLedgerRows`。取引の年月日→購入価格→品目・数量→取引区分→真偽確認→相手氏名→職業→住所→その日の仕入れ合計、の順で、9項目外の送料は**その後ろ**に配置(仕様の許容どおり) |
| Audit Log (§85) | 実装済み | `app/actions/systemAudit.ts` + `SystemAuditPanel.tsx` |
| Yahoo(メッセージ側) | 実装済み | `lib/messaging/yahoo/adapter.ts`。出品側は「ストア開設まで停止」方針(§11-N)により**意図的な保留** |

### 陳腐化した「未実装」コメント(本ラウンドで修正)

`AutoPricingSection.tsx` と `amplify/data/resource.ts` が
「スケジューラ(§22)は未実装」と書いていたが、**これは誤り**だった。

実測: `amplify/functions/pricing-scheduler` はデプロイ済みで、AWS上で
毎時 `cron(0 */1 * * ? *)` / ENABLED で稼働しており、CloudWatchに
`[pricing-scheduler] 0 channel listing` の正常実行ログが出ている
(0件なのは ChannelListing テーブルが空のため)。

未実装なのはスケジューラではなく **Mercariへの実価格送信のみ**。
この誤ったコメントは「既存実装を見落として作り直す」直接の原因に
なり得るため、両ファイルのコメントを実測に合わせて訂正した。

## 5. Staging復旧で判明した「deploy成功して初めて露出した」不具合

`8b145f6` 以降の期間は「実装が止まっていた期間」ではなく
「**Gitへ蓄積されていたがAWSで一度も動いていなかった期間**」だった。
その結果、deploy成功と同時に以下がruntimeで露出した。

| # | 不具合 | 検出方法 | 状態 |
|---|---|---|---|
| 1 | data ⇄ function ネストスタック循環依存 | build job #30〜#64 の全34本失敗。ローカルsynthで同一logical ID を再現 | **修正済** `dd187e5`。`synth:check`へ循環検出の回帰ガードを追加 |
| 2 | `bello/line-channel-secret` AlreadyExists | ①を直して初めてCFNがリソース作成まで到達し露出 | **修正済** `aeec16a` |
| 3 | worker Lambda が sharp をロードできず INIT で即死 | ②を直して初めてLambdaが実在し露出。zaico-sync-worker 7/7・image-processing-worker 5/5 失敗 | **修正済** `4e6f235`。Lambdaレイヤー方式 |
| 4 | `/bello-system-icon.png` が全ページで404 | 実ページロードで測定 | **修正済** `08ce2f2` |
| 5 | SSRコンピュートロールがMercari/LINE Secretへ到達不能・CloudWatch Logs権限なし | IAM実測 | **修正済** `1178d53`(staging限定) |

## 6. ZAICO重複(§7 P0)の最終状態

| 指標 | 開始時 | 完了後 |
|---|---|---|
| Inventory 件数 | 456 | **1,000** |
| distinct ZAICO ID | 139 | **1,000** |
| 重複グループ | 97 | **0** |
| 超過レコード | 317 | **0**(315件を物理削除、2件は固有データを正本へ移してから削除) |
| ZaicoSourceLink | 0 | **1,000**(全IDがO(1)解決) |

再発しないことの実証: 統合後に全1000件の同期を実走させ
`created 0 / updated 0 / unchanged 1000`。詳細は
`docs/zaico-duplicate-consolidation-plan-20260830.md`。

## 7. 残る未検証(本人操作が必要なもの)

| 項目 | 必要な操作 | 理由 |
|---|---|---|
| Staging実機のADMIN検証 | ADMINログイン | パスワード入力は代行できない |
| Mercari 実404診断 | 設定画面からPersonal API Access Tokenを保存 | `bello/mercari-access-token` は**バージョン1(作成時の`{"configured":false}`)のまま・最終アクセスnull**。トークンが存在しないため、現行コードはMercariへ到達する前に「Token未設定」でthrowする。実404を測定できるのはトークン設定後 |
| LINE 実連携 | Channel Secret / Access Token の保存 | 同上(`bello/line-channel-secret` もバージョン1のまま) |

**重要**: 前ラウンドが結論づけた「404はMercariのIP allowlist未登録が原因」は、
Web検索結果からの推論であって**実測された404ではない**。MASTER §28 は
「Mercari docsの固定IP記載が webhook送信元IP なのか API client allowlist要件
なのかを混同するな」「必要性が確認できないのにNAT Gatewayを作るな」と
明記している。現時点でBELLO側は認証済みリクエストを一度も送っておらず、
固定egress(VPC+NAT+EIP)の設計判断に必要な証拠は**まだ揃っていない**。
