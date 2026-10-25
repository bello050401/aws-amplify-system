# BELLO 認証強化：実装状態と移行手順

2026-10-26。作業ブランチ `codex/security-device-auth-20261026`。

## 現在の境界

本番とは別の AWS スタック `BelloSecurityPilot20261026` に認証・端末管理の検証環境を配置した。本番 Cognito、AppSync、S3、スタッフアカウント、PhotoStation 接続、EC 連携は変更していない。検証環境は業務データに接続しない。既存システム全体が新方式で保護されたという意味ではない。

検証環境 URL: https://rn5u65d173.execute-api.us-west-2.amazonaws.com

## 実装した仕組み

- Cognito Essentials / WebAuthn。ユーザー検証を必須とし、初回だけパスワードで登録を開始。既存パスキーがあるアカウントはパスワードだけで追加登録・業務アクセスできない。
- ブラウザごとに非抽出の P-256 秘密鍵を作り IndexedDB に保持。公開鍵だけをサーバーに送る。同期パスキーだけでは別ブラウザの承認を引き継げない。
- サーバーが発行する 60 秒・一回限りのチャレンジに、操作内容・送信先を含めて署名。Cookie のみ、内容の改変、署名の再送を拒否。
- HttpOnly / Secure / SameSite=Strict の不透明なセッション Cookie。Cognito トークンはブラウザへ返さず KMS の暗号化を施してサーバー保管。ログにも記録しない。
- 個人端末は 14 日無操作・最大 30 日、共用端末は 30 分無操作・最大 8 時間。初回パスワードセッションは 15 分。トークンは 5 分、有効期間を更新する処理は競合を防ぎながら実行。
- 操作ごとにサーバーでユーザー停止・端末承認・世代番号を再確認。拒否、承認待ち、承認解除を区別する。管理操作には 5 分以内のパスキー認証が必要。
- 本人から伝えられた申請番号と本人確認チェックで承認。管理者一覧 API に申請番号を返さない。管理者の現在端末を誤って承認解除する操作を禁止。
- 既存の在庫 ADMIN と特集ページ用 Admins を区別。EDITOR / VIEWER の範囲を維持。入力された役割やユーザー ID を本人情報として採用しない。
- メタデータ限定の監査ログ、90 日保持、管理者の書き出し。パスワード、トークン、秘密鍵、帳票本文などは記録しない。ログイン回数制限、API スロットリング、CSP を適用。

## 保証できない点

WebCrypto の非抽出鍵は、物理端末の完全な証明ではない。端末マルウェア、ブラウザプロファイル全体の侵害、同一オリジンの XSS による鍵の使用まで防げると説明しない。端末の OS 更新、Windows Defender 等の保護、画面ロック、ディスク暗号化、不要な拡張機能の整理が必要。

顔・指紋情報は BELLO に送らない。端末・パスキー提供元によっては PIN 等で本人確認する。同期パスキーは最高保証レベルのハードウェア固定鍵と同一ではない。

検証 URL のパスキーは本番ドメイン用ではない。本番では既存の Cognito ユーザー ID と権限を維持し、正式ドメインで登録する。検証用アカウントを本番へ移さない。

## 本番移行前に必要な実装・確認

1. 既存ユーザープール設定・クライアント・権限・IAM・各配信設定を取得して復旧用に保護。ユーザー ID を作り直さない。
2. 本番ドメインにサーバー側認証経路を設け、全業務 API / Server Action で署名・承認・役割を確認する。画面のガードだけで完了としない。
3. 既存の Cognito JWT を使った AppSync 直接アクセスと Identity Pool / S3 直接アクセスを閉じる。公開 Feature / FeatureItem / BaseItemCache の API キー経路は、公開データだけの投影と許可リストへ分離する。
4. PhotoStation は人の長期 JWT を流用せず、取消可能な専用端末認証で移行。BASE、Gmail、請求書の OAuth callback、ZAICO 等のバックグラウンド処理は独立した最小権限を維持する。
5. S3 の既存署名 URL の残存期間を明確にする。即時失効が必要なデータは配信時にも承認を確認する。発行済み URL が JWT の取消だけで無効になると説明しない。
6. 管理者本人の iPhone / Windows Hello で初回登録・通常ログイン・ブラウザ再起動・スタッフ切替・別ブラウザ承認・取消を実測。ソフトウェア認証器の成功を生体認証の実機成功と記載しない。
7. 本番相当の業務 API を使い、未承認・承認解除・アカウント停止で 403 となること、在庫・画像・EC 等の通常操作が維持されることを確認する。
8. 管理者の復旧と切戻しをリハーサルし、アラートの通知先と対応手順を確認する。検証スタックの CloudWatch アラームには現在通知先がない。
9. `cutoverReadiness()` の 18 項目を証拠付きで満たしてから切り替える。この関数は移行ツール用であり、既存本番 CI 全体を制御済みではない。

本番と古い認証経路を並存させたまま「端末承認必須」として運用しない。全経路を一体で閉じる必要がある。

## 管理者復旧

最初の管理者も自動承認しない。本人のパスキー登録後、既存の AWS 管理経路で担当者がユーザー ID・申請番号・公開鍵識別子を照合し、対象 1 件だけを条件付き更新で承認する。一般 HTTP API に初期管理者の抜け道を作らない。

すべての端末を紛失した場合は既知の連絡手段で本人を確認する。AWS 管理経路でアカウントを一時停止し全セッションを失効させ、失効済み端末を再承認しない。必要なパスキーの再登録手続き、新しいブラウザ鍵の申請、管理者承認を行う。毎日の通常ログインにこの手続きを要求しない。

切戻しは、まず新機能の書き込みを止め、影響対象を限定して原因を確認する。承認解除した利用者や漏洩した旧トークンを復活させる切戻しは禁止。旧方式へ戻す必要がある場合は漏洩のない復旧用認証経路を使う。安全性を確認できないときは業務 API を閉じたまま復旧する。

## 基盤ライブラリの修正

### 画像アクセス権限の分離（作業ブランチで修正、本番未反映）

既存の `amplify/storage/resource.ts` は、在庫用 ADMIN と別の CMS 用 Admins にも inventory / knowledge の権限を付与していた。Identity Pool がグループの優先順位から IAM ロールを一つだけ選ぶため、兼任ユーザーの不具合を避ける目的の設定だったが、CMS 専用ユーザーにまで権限が広がる。

`amplify/auth/resource.ts` の優先順位を ADMIN → EDITOR → VIEWER → Admins にし、storage の Admins への付与を撤去した。グループ名・所属、CMS の AppSync 権限は変更していない。MOBILE_HIDE_EC / MOBILE_HIDE_SALES も維持。優先順位と storage 権限を必ず同時に反映する必要がある。

`scripts/verify-security-storage.ts` は実際の Amplify auth / storage 定義をローカルで合成し、生成した Cognito グループと IAM ポリシーを使って、6 グループの全 64 通りの所属組み合わせで期待する読み取り・書き込み・削除権限を検証した。すべて合格。これはデプロイ後の AWS IAM 実アクセス試験の代わりではなく、本番はまだ既存設定である。発行済みの一時 IAM 認証情報が残る場合も考慮して切り替える。

既存業務との接続調査では 887 ソースファイル内に、旧セッション参照 76 箇所、ブラウザからの画像ストレージ直接接続 6 箇所などを検出した。文字列一致による調査であり、同数の脆弱性を発見した意味ではない。API / Server Actions / AppSync / S3 を一体で移行する必要があり、既存処理に承認チェックを一箇所追加しただけでは完了にできない。

Next.js 14.2.35 → 15.5.28、sharp 0.35.4 → 0.35.5。非同期 cookies / headers / route params への対応を実施。認証 Cookie 読取を await 化し、既存ログインフォームは同じ内容のクライアントコンポーネントへ分離。React Native 用 DateField の型だけを Web と共有し、Web ビルドへ Native 実装を取り込まない。

依存関係検査は変更前 critical 1 / high 17 / moderate 1 → 変更後 critical 0 / high 0 / moderate 2。件数は依存パッケージ単位であり、別々の攻撃が同数存在する意味ではない。残る moderate は ExcelJS とその uuid 依存に同じ指摘が伝播したもの。現在の ExcelJS は uuid v4 を利用しており、指摘の対象 v3/v5/v6 バッファ API の利用は見つからなかった。指摘自体の解消とは扱わず、互換性を確認して追従する。

公式情報:
- https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw
- https://github.com/vercel/next.js/security/advisories/GHSA-p3m5-59mp-jv5r
- https://github.com/lovell/sharp/security/advisories/GHSA-wq5f-xc86-pv6w
- https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq

## 検証用 AWS リソースと運用

別 Cognito pool / confidential client、DynamoDB（PITR・削除保護・TTL）、KMS、Secrets Manager、Lambda、HTTP API、CloudWatch ログとエラーアラームを新設。アプリの IAM から本番在庫・本番画像への権限を付与していない。これらは従量課金・保管課金の対象となる。実運用移行後に検証環境の要否を確認する。削除保護・RETAIN を無視した自動全削除はしない。

AWS アカウントの読取調査では root MFA 有効・root access key なし。us-west-2 の GuardDuty detector と CloudTrail trail の登録は見つからなかった。CloudTrail の標準イベント履歴がないという意味ではない。監視運用・通知担当・長期証跡は未整備として残る。

## 再現コマンド

```
node node_modules/tsx/dist/cli.mjs scripts/verify-security.ts
node node_modules/tsx/dist/cli.mjs scripts/verify-security-storage.ts
node node_modules/typescript/bin/tsc -p tools/bello-security-pilot/tsconfig.json --noEmit
node scripts/build-security-pilot.cjs
node node_modules/tsx/dist/cli.mjs scripts/security-pilot-live.ts
npm audit --omit=dev --audit-level=high
npm run build
```

live テストは検証スタック名・プール名を照合してから使い捨てアカウントを作成する。通知メールを送らない。パスワード・秘密鍵・Cookie は結果ファイルに保存せず、テストアカウントを最後に無効化する。ソフトウェア WebAuthn 認証器を利用するため、実機顔認証の代わりにはならない。
