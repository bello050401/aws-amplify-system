# Mercari Shops API 中継サービス 設計書（実装前・承認待ち）

作成日: 2026-09-01
状態: **未実装。AWSリソースは一切作成していません。**

Mercari Shops APIは「日本国内の固定IPアドレス（他社と共有していないもの、範囲指定不可）」
からのリクエストしか受け付けない。BELLO本体（Amplify Hosting SSR / us-west-2）は
固定の送信元IPを持てないため、**Mercari APIの呼び出しだけを東京の小さな常時稼働
インスタンスへ移す**。

根拠と代替案の比較は `docs/mercari-connection-evidence-20260901.md` を参照。

---

## 0. 前提として実測した事実

| 項目 | 実測結果 |
|---|---|
| EC2 / EIP / NAT GW / 非defaultVPC | 全リージョンで **0**（流用できる資産なし） |
| Lightsail | **0** |
| Lambda のVPC接続 | 全13関数とも未接続 |
| 独自ドメイン / Route53ゾーン / ACM証明書 | **すべて無し** |
| 無料利用枠 | 残なし（課金は2025-09から継続） |
| 現在の月額 | **$13.18**（2026-08。Amplify $11.11 が大半） |
| **Amplify HostingのVPC接続** | **不可**（`update-app`/`update-branch` にVPC系パラメータが存在しない） |

最後の1点が決定的で、**NAT Gatewayを作ってもAmplify SSRの送信元IPは固定できない**。
したがって中継インスタンス方式が必須であり、そのインスタンスは自分でパブリックIPを
持てるためNAT Gatewayは不要になる。

---

## 1. 全体構成

```
BELLO (Amplify SSR / us-west-2)
   │  HTTPS + 共有鍵HMAC認証
   │  POST https://<固定IPv4>/mercari/graphql
   │  ヘッダ: X-Bello-Relay-Key / -Timestamp / -Signature / X-Bello-Mercari-Env
   │  ボディ: { query, variables }  ＋ Mercariトークンは Authorization ヘッダで中継
   ▼
Lightsail nano (ap-northeast-1 / Ubuntu 24.04 LTS)  ← 固定IPv4をMercariへ申請
   │  bello-mercari-relay (Node.js / systemd)
   │  送信先は**ハードコードした2つのみ**
   ▼
https://api.mercari-shops.com/v1/graphql          (production)
https://api.mercari-shops-sandbox.com/v1/graphql  (sandbox)
```

**汎用プロキシにはしない。** 転送先URLはクライアントから受け取らず、
`X-Bello-Mercari-Env: production|sandbox` の2値だけを見てサーバー側の定数から選ぶ。
経路は1本（`POST /mercari/graphql`）のみで、他のパス・メソッドはすべて404/405。

---

## 2. 認証（BELLO → 中継）

インターネットに開いた443を持つため、認証は必須。既存のLINE Webhook署名検証と
同じ考え方に揃える。

- `X-Bello-Relay-Key`: 32バイト乱数のBase64。定数時間比較で照合。
- `X-Bello-Relay-Timestamp`: UNIX秒。**±300秒** を超えるものは拒否（リプレイ防止）。
- `X-Bello-Relay-Signature`: `HMAC-SHA256(relayKey, timestamp + "." + rawBody)` のBase64。
  定数時間比較。

3つのいずれかが欠落・不一致なら **401**、本文は `Unauthorized` のみ（理由を明かさない）。
認証失敗は送信元IPと理由コードだけをログに残す。

### TLS — ドメイン無しで $0 にする

独自ドメインが無いため Let's Encrypt は使えない。**自前のプライベートCAを作り、
固定IPv4を SAN（`IP:x.x.x.x`）に持つサーバー証明書**を発行する。

- CA秘密鍵は**インスタンスに置かない**（構築端末でオフライン保管）。
- BELLO側は Node の `undici.Agent({ connect: { ca } })` で**このCAだけを信頼**する。
  公開PKIに依存しないぶん、経路の限定という意味ではむしろ強い。
- 有効期限は CA 10年 / サーバー証明書 10年。運用中の更新作業を発生させない。
- 代替案: 独自ドメインを取得すれば Caddy による自動TLSにできる（+約$1.5/月）。
  本設計では採用しない。

---

## 3. Secret管理

| 秘密情報 | 保管場所 | 備考 |
|---|---|---|
| 中継共有鍵 `relayKey` | **AWS Secrets Manager** `bello/mercari-relay` (us-west-2) | BELLO SSRが読む。新規シークレット1つ（$0.40/月） |
| 同（中継側） | `/etc/bello-relay/relay.key`（`root:root` `0400`） | 構築時にuser-dataで書き込む |
| CA証明書（公開部） | 同上シークレットの `caCert` フィールド | 秘密ではないが同じ場所に置くと運用が単純 |
| CA秘密鍵 | **どのサーバーにも置かない** | 構築端末でオフライン保管 |
| Mercari TOKEN | 既存 `bello/mercari-access-token` のまま | **中継側には保存しない**（後述） |

**Mercariトークンは中継サーバーに保存しない。** BELLOがリクエストごとに
`Authorization: Bearer ...` として渡し、中継はそれをそのまま転送するだけで、
ディスクにもログにも残さない。これにより
「設定画面からトークンを保存する」既存フローに一切手を入れずに済み、
中継サーバーが侵害された場合の被害も「通過中のリクエスト」に限定される。

`bello/mercari-relay` を SSR が読めるよう、既存の
`BelloComputeRuntimeAccess` インラインポリシーの Resource に **ARNを1本追加**する
（アクションは既存の `GetSecretValue` のみ。`PutSecretValue` は付与しない）。

---

## 4. ログと機密情報のマスキング

`lib/listing/mercari/client.ts` の既存方針をそのまま踏襲する。

**出力するもの**（1行JSON、標準出力→journald）:
`timestamp` / `requestId` / `env`(production|sandbox) / `operationName`(GraphQLから抽出) /
`upstreamStatus` / `durationMs` / `requestBytes` / `responseBytes` / `outcome`

**絶対に出力しないもの**:
Authorizationヘッダ・Mercariトークン・`relayKey`・署名値・
GraphQLのvariables・リクエスト本文・レスポンス本文。

エラー時も上流の本文は**先頭200文字に切り詰めたうえで、機密パターン
（`Bearer\s+\S+` 等）をマスク**してから記録する。
journald は `SystemMaxUse=200M` で上限を設け、無制限に肥大化させない。

---

## 5. レート制限・タイムアウト

- **レート制限**: トークンバケット（既定 **60 req/分**、バースト20）。
  Mercari公式は「ショップ単位 10,000ポイント/時」なので十分に下回る。
  超過時は **429** ＋ `Retry-After`。上流へは投げない（Mercari側の制限を守るため）。
- **同時実行数**: 最大10。超過分はキューせず429。
- **リクエストサイズ上限**: 256KB。超過は413。
- **タイムアウト**:
  - 中継 → Mercari: **15秒**（BELLO側 `MERCARI_TIMEOUT_MS` の既定と一致）
  - BELLO → 中継: **20秒**（中継側より長くし、切り分けを可能にする）
  - アイドルソケット: 30秒
- **リトライは中継側では行わない。** 判断はBELLO側の
  `isRetryableMercariErrorCode` に一本化する（二重リトライを避ける）。

---

## 6. 障害時の挙動

**既存のエラー分類がそのまま活きるため、BELLO側の追加実装は不要。**

| 事象 | BELLOから見た結果 | 既存挙動 |
|---|---|---|
| 中継が停止 / 到達不能 | `NETWORK_ERROR` | リトライ対象。**既存の検証済み設定を破壊しない** |
| 中継が20秒で応答なし | `TIMEOUT` | 同上 |
| 中継が429 | `RATE_LIMITED` | リトライ対象 |
| 中継が401（鍵不一致） | `AUTH_FAILED` 相当 | ※下記の注意 |
| Mercariが404（IP未登録） | `IP_NOT_ALLOWED` | 保存デッドロック解消済みの経路 |

> **注意点**: 中継の401とMercariの401が同じ `AUTH_FAILED` に落ちると、
> 「中継の鍵が違う」のに「Mercariトークンが不正」と表示され、
> しかも `connectionPolicy` が**トークンを保存しない**判断をしてしまう。
> これを避けるため、中継は自身の認証失敗に **`X-Bello-Relay-Error: AUTH`** を付け、
> BELLO側はこれを検出したら `AUTH_FAILED` ではなく `NETWORK_ERROR`
> （＝トークンの正否を判定できない）へ分類する。**この1点だけは実装が必要。**

---

## 7. ヘルスチェック・自動再起動・OS更新

- **`GET /healthz`**（認証不要）: `200 {"ok":true}` のみ。バージョンも構成も返さない。
- **systemd**: `Restart=always` / `RestartSec=5` / `WatchdogSec=30`（`sd_notify`）。
  プロセスのクラッシュ・ハングはこれで自動復帰。
- **強化**: `NoNewPrivileges=yes` / `ProtectSystem=strict` / `ProtectHome=yes` /
  `PrivateTmp=yes` / `ReadWritePaths=` なし / `CapabilityBoundingSet=CAP_NET_BIND_SERVICE`。
- **専用ユーザー**: `bello-relay`（ログインシェルなし）。rootでは動かさない。
- **OS更新**: `unattended-upgrades` で**セキュリティ更新のみ**自動適用。
  `Automatic-Reboot "true"` / `Automatic-Reboot-Time "04:00"`（JST深夜）。
  再起動しても静的IPは変わらず、systemdがサービスを自動起動する。
- **インスタンス障害の検知**: Lightsailアラーム（メトリクス `StatusCheckFailed`）→
  SNS通知。Lightsailに自動復旧機能は無いため、通知を受けて §10 の手順で再作成する。

---

## 8. ネットワーク最小権限

Lightsailファイアウォール:

| ポート | 送信元 | 用途 |
|---|---|---|
| 443/tcp | `0.0.0.0/0` | BELLO SSRからの中継リクエスト。**SSRのIPが動的なため絞れない**。HMAC認証で防御 |
| 22/tcp | **管理者の固定IPのみ**（未指定なら閉じる） | 保守。Lightsailブラウザ SSH を使う場合も既定の22開放は削除する |

- **インバウンドのICMP・その他ポートはすべて閉じる。**
- **IAMロールはインスタンスに付与しない。** 中継はAWS APIを一切呼ばない
  （トークンもBELLOから受け取るため、Secrets Managerへのアクセスが不要）。
  これによりインスタンス侵害時のAWS側への波及がゼロになる。

---

## 9. 構築自動化 / IaC

CDK（`amplify/backend.ts`）はLightsailを扱えず、そもそもSSRコンピュートロールが
CDK管理外である。既存の `scripts/aws-setup/*.ps1` の慣習に揃える。

新規追加（**実装は承認後**）:

| ファイル | 役割 |
|---|---|
| `scripts/aws-setup/12-create-mercari-relay.ps1` | 静的IP確保 → インスタンス作成 → FW設定 → 鍵生成 → Secrets Manager登録 → IAM ARN追加。**冪等**（既存なら作らず現状を報告） |
| `scripts/aws-setup/12-mercari-relay-userdata.sh` | cloud-init。Node.js LTS導入、専用ユーザー作成、証明書配置、systemd登録、unattended-upgrades設定 |
| `scripts/aws-setup/12-verify-mercari-relay.ps1` | 構築後の検証（TLS・認証・送信先制限・レート制限・マスキングを外形テスト） |
| `relay/server.mjs` | 中継本体（依存パッケージなし、Node標準のみ。約150行） |
| `relay/README.md` | 運用手順（更新・鍵ローテーション・削除・復旧） |

スクリプトは**Production App IDを渡すと実行を拒否**する（既存スクリプトと同じ安全弁）。

---

## 10. 削除・復旧手順

**最重要**: 静的IPを**インスタンスとは別リソースとして確保**する。
これによりインスタンスを作り直しても**IPが変わらず、Mercariへの再申請が不要**になる。

- **インスタンス再構築**（OS破損・更新失敗時）:
  1. 静的IPをデタッチ（**解放はしない**）
  2. 古いインスタンスを削除
  3. `12-create-mercari-relay.ps1` を再実行（同じuser-dataで再構築）
  4. 静的IPをアタッチ → `12-verify-mercari-relay.ps1`
  → **Mercariへの再申請なしで復旧できる。**
- **バックアップ**: 週次の自動スナップショット（保持4世代）。
  ただし復旧は「スナップショット復元」より「スクリプト再実行」を正とする
  （構成がコードに残っているため）。
- **完全削除**: インスタンス削除 → 静的IP解放 → スナップショット削除 →
  Secrets Manager の `bello/mercari-relay` 削除 → IAMポリシーからARN除去 →
  `next.config.mjs` から `MERCARI_RELAY_URL` を除去。
  **静的IPを解放するとそのIPは二度と戻らない**ため、Mercari登録を維持したい間は解放しない。

---

## 11. 既存BELLOシステムへの変更範囲（最小）

中継が未設定なら**従来どおりMercariへ直接接続する**。既存の動作は変わらない。

| ファイル | 変更内容 | 規模 |
|---|---|---|
| `lib/listing/mercari/endpoints.ts` | `MERCARI_RELAY_URL` があればそれを返す分岐を追加 | 数行 |
| `lib/listing/mercari/relay.ts` | **新規**。認証ヘッダ生成＋CA固定のHTTPS Agent | 約60行 |
| `lib/listing/mercari/client.ts` | 中継利用時に認証ヘッダと `X-Bello-Mercari-Env` を付与。`X-Bello-Relay-Error: AUTH` を `NETWORK_ERROR` へ分類（§6の注意点） | 約20行 |
| `next.config.mjs` | `MERCARI_RELAY_URL` をビルド時インライン（**Amplifyの環境変数はSSRランタイムに届かない**ため。既存の `CONVERSATION_TABLE_NAME` と同じ扱い。※秘密値ではないURLのみ） | 2行 |
| IAMポリシー | `BelloComputeRuntimeAccess` の Resource に ARN 1本追加 | 1行 |
| `scripts/verify-mercari.ts` | 中継経路のテストを追加（認証ヘッダ生成・エラー分類） | テスト追加のみ |

**変更しないもの**: 設定画面のUI、`setMercariConnectionAction`、`connectionPolicy`、
Secretのpayload構造、エラー分類の既存コード。

---

## 12. 固定IP登録 → 実接続確認までの流れ

```
[1] 承認をいただく                                    ← 現在ここ
[2] 12-create-mercari-relay.ps1 実行
      → 静的IPv4が確定する（この値をMercariへ申請）
[3] 12-verify-mercari-relay.ps1 で中継自体を検証
      → TLS / 認証 / 送信先制限 / レート制限 / マスキング
      → この時点でMercariは404のまま（IP未申請なので正常）
[4] 【ユーザー操作】Mercariへ固定IPを申請
      → 契約担当窓口経由。sandbox と production の**両方**に同じIPを申請
      → 申請可能なIPの要件（国内固定・非共有・範囲指定不可）は満たしている
[5] Mercariから登録完了の連絡
[6] BELLO側を中継経由へ切替（MERCARI_RELAY_URL を設定してデプロイ）
[7] 設定画面の【接続確認】ボタンを押す
      → 成功すれば verified:true / 「● 接続済み」へ変わる
      → 保存済みTOKENをそのまま使うので再入力は不要
[8] npm run verify:mercari-live で実API接続を確認
[9] 出品下書き → Mercari実出品の動作確認
```

**[4]〜[5] はMercariの審査待ちのため、こちらでは短縮できません。**
[2][3] は申請前に完了させられるので、待ち時間を最小化できます。

---

## 13. 想定月額

| 項目 | 月額(USD) | 実測根拠 |
|---|---|---|
| Lightsail `nano_3_0`（東京） | **$5.00** | `get-bundles` 実測。静的IPv4・20GB SSD・転送1TB込み |
| Secrets Manager シークレット1つ追加 | **$0.40** | Pricing API 実測（$0.40/secret） |
| 週次スナップショット（4世代・増分） | **約$0.10** | $0.05/GB-月。実効2GB程度の想定（**これのみ見積り**） |
| データ転送 | **$0.00** | 1TB込み。実使用は月数MB |
| 静的IP（アタッチ中） | **$0.00** | インスタンスにアタッチしている間は無料 |
| **追加合計** | **約 $5.50 / 月（約830円）** | |

現在 $13.18 → **約 $18.7/月**。
（参考: NAT Gateway案なら +$45.26 で約$58/月。しかも§0のとおり機能しない。）

---

## 14. 作成されるAWSリソース一覧

**承認後に作成するもの（現時点では未作成）:**

| # | サービス | リソース | リージョン | 課金 |
|---|---|---|---|---|
| 1 | Lightsail | インスタンス `bello-mercari-relay`（`nano_3_0` / `ubuntu_24_04`） | ap-northeast-1 | $5.00/月 |
| 2 | Lightsail | 静的IP `bello-mercari-relay-ip` | ap-northeast-1 | アタッチ中は$0 |
| 3 | Lightsail | インスタンスファイアウォール規則（443のみ開放、22は管理IP限定） | ap-northeast-1 | $0 |
| 4 | Lightsail | 自動スナップショット（週次・4世代） | ap-northeast-1 | 約$0.10/月 |
| 5 | Lightsail | アラーム（`StatusCheckFailed`）＋ SNSトピック | ap-northeast-1 | $0（無料枠内） |
| 6 | Secrets Manager | `bello/mercari-relay` | us-west-2 | $0.40/月 |
| 7 | IAM | 既存 `BelloComputeRuntimeAccess` に Resource 1行追加（**新規ロール・新規ポリシーは作らない**） | グローバル | $0 |

**作成しないもの**: VPC / サブネット / NAT Gateway / Elastic IP(EC2) / ALB /
Route53ゾーン / ACM証明書 / 新規IAMロール / 新規Lambda。

---

## 15. 残るリスクと明示しておくこと

- **単一障害点**: 中継が落ちるとMercari連携が止まる。ただし在庫・LINE・BASE・AI等
  他の機能には影響しない（Mercari呼び出し経路のみを通す設計のため）。
  冗長化は2台目＋2つ目のIP申請が必要になり、費用と申請の手間が倍になるため、
  まずは1台で運用し、必要性が出た時点で再検討する。
- **クロスリージョン遅延**: us-west-2 → 東京で1呼び出しあたり概ね100〜120ms増
  （**実測ではなく一般的な目安**）。Mercari呼び出しは出品操作時のみで頻度が低い。
- **最終的な可否はMercari側の審査**: IPが受理されるかはこちらから確認できない。
- **将来的な代替**: BELLO自体を東京リージョンへ移設すれば中継は不要になる。
  移行規模が大きいため今回の判断とは切り離す。
