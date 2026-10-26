# BELLO 端末承認・パスキー認証の実装と移行

2026-10-26。ブランチ codex/security-device-auth-20261026。

## 現在の状態

本番の認証方式は変更していない。認証・端末承認を実際のBELLO在庫画面、iPhone用Web画面、業務APIへ接続した隔離環境で検証した。実iPhone Face IDと実Windows Helloは未確認。ソフトウェアWebAuthn試験を生体認証の実機確認と扱わない。

UIだけを公開して旧AppSync・S3経路を開いたまま「端末承認必須」と説明してはならない。

## 実装

- 既存CognitoユーザーID・グループを維持し、機密クライアントで本人確認必須のパスキー認証を行う。CMS用Adminsと在庫用ADMINを区別する。
- ブラウザごとの抽出不可P-256鍵をIndexedDBへ保持する。同期パスキーで認証できても、新しいブラウザ鍵は承認まで業務へアクセスできない。
- HttpOnly・Secure・SameSite=Strict Cookieにはランダムなセッション識別子だけを格納する。CognitoトークンはサーバーでKMS暗号化し、ブラウザへ渡さない。強化モードで旧トークンとPWAの業務キャッシュを除去する。
- 個人用は無操作14日・絶対期限30日、共用は無操作30分・絶対期限8時間。アクセストークン5分、更新トークンをローテーションする。DynamoDB TTLの物理削除を待たず期限を判定する。
- 承認待ち・承認済み・拒否・解除を管理する。承認時は既知の連絡手段で本人を確認し、本人画面の申請番号を照合する。管理者一覧APIには申請番号を返さない。
- 管理操作は直近5分のパスキー認証を要求する。使用中の管理者自身の端末解除・停止を防ぐ。スタッフ作成はEDITOR/VIEWERのみ、招待メールを自動送信しない。
- 承認解除・全端末ログアウト・利用停止は世代番号で既存セッションを遮断する。再有効化しても古いセッションは復活しない。
- 明示的に拒否された端末だけ指定の赤い拒否画面にする。承認待ち・入力誤り・通信障害は別表示とする。
- 監査はメタデータのみ90日。認証秘密情報・帳票本文を記録しない。管理者が書き出せる。

## 業務アクセスの保護

middleware、nextBoundary、serverGrant、serverSessionで画面・Route Handler・Server Actionを保護する。メソッド、パス、クエリ、本文、Origin、セッションを署名へ結びつけ、nonce再使用を拒否する。呼出者の内部認可ヘッダーは除去し、サーバー署名情報だけを渡す。処理側でも失効を再確認する。

AppSyncはサーバーだけが持つ照合値をWAFで検証し、有効なCognito JWT・APIキーの直接呼出しも拒否する。その内側でモデル別権限を適用する。公開CMSのサーバー読取は公開モデル権限を維持し、在庫は公開しない。

S3はIdentity Pool各ロールへ明示的Denyを適用し、既発行の一時認証情報からも直接アクセスできなくする。ブラウザ画像は同一サイトの署名付きAPIを使用する。画像実体、容量、ピクセル数、保存パスを検証し、既存キーの上書きを禁止する。保存済み画像の削除は既存の参照確認処理を維持する。

加工用のS3署名URLは30秒、PhotoStationダウンロードは60秒。PhotoStationアップロードURLは既存処理に応じて300/900秒。この期間は発行済みURLが残る。端末解除だけでURLも即失効するとは説明しない。

BASE・Gmail・請求書のOAuth復帰は同一サイトの安全な文書を一度経由し、Strict Cookieと端末署名を再取得する。復帰文書自体はトークン交換せず、既存state照合も維持する。請求書の専用ワーカーは強化モードのクライアントIDを検証する。帳票保存禁止等の既存仕様は変更しない。

PhotoStationはPHOTO_DEVICE専用ユーザーとWindows CNGの永続・抽出不可鍵を組み合わせる。人のJWTだけでは画像へアクセスできない。端末承認・解除を検証した。通常のWindows版にはまだ強制適用していない。

## 隔離環境と実操作

BelloSecurityPilot20261026は専用Cognito、DynamoDB、KMS、Secrets Manager、Lambda、HTTP API、AppSync、写真S3を持つプロトコル検証環境。

amplify-bellosecuritybusiness-20261026-sandbox-40e26f1744は実BELLOの63モデルとCRUD・関連・権限を使う隔離コピー。未使用のGraphQL subscription 189本とその専用処理を除外してCloudFormation一操作2,500リソース制限に対応。スケジューラ・EC・ZAICO・メール送信・請求書発行ワーカーは接続しない。

完全なNext.jsアプリをlocalhost:4319で起動し、Chrome実操作を行った。本人認証だけ代替するループバックfixtureは私有ビルド内に生成し、Git・本番へ含めない。

Chromeで新規在庫5点を保存・再表示し、3点と2点へ異なるタイトルで分割した。null検索キーをDynamoDBへ送る既存不具合を修正し、同じ操作を再実行して合計5点を確認した。

iPhone用Web画面をChromeで開き、備考を編集・保存・再表示した。EDITORの売却非表示、VIEWERの編集・分割・複製禁止を確認した。端末解除後の保存拒否・ログイン画面復帰・元データ維持を確認した。実iPhoneの確認ではない。

PhotoStationでは実Windows鍵による承認、原本の同一バイト保存、編集後画像保存、再試行重複防止、解除後拒否を確認した。Lightroom加工の再確認ではない。

初期の設定画面確認で既存BASE設定メタデータを読み取ったため、検証サーバーを隔離リソースのみ許可するIAMロールへ変更した。外部BASE APIや本番データの変更は行っていない。「本番情報を一切読んでいない」とは記録しない。

リージョン指定漏れによるus-east-1作成はロールバックし、残存リソースなしを確認して失敗スタックを削除した。明示的リージョン検証を追加した。IAM定義長の上限は、隔離APIの一意IDで対象を限定して修正した。

## 追加の依存修正と回帰確認

ExcelJSが参照するuuidをCommonJS互換の11.1.1へ固定し、既知の実行時依存の警告は0件になった。CSV/XLSX取込58件、ZAICO項目の型・先頭ゼロ・日本語保持、実際にUUIDを生成する拡張書式のExcel往復を確認した。純粋な取込ジョブでReactのRSC専用cacheが存在しない場合はキャッシュを使わず、認証判定自体は同じ処理を実行するよう修正した。

## 本番移行

1. 本番プール・クライアント・グループ・IAM・配信設定を取得して復旧用に保護する。既存ユーザーIDを作り直さない。
2. BELLO_SECURITY_INFRA=prepareは追加準備段階。機密クライアント、セッション保存先等を追加するが、旧ログインとデータ経路は閉じない。既存パスワード・MFA・復旧設定を保持する。本番プールは既にEssentials。追加環境・認証利用量等による費用は別途確認する。
3. scripts/security-initialize-client.tsは既定で確認のみ。--applyで秘密情報をSecrets Managerへ直接保存し、値は表示・ファイル化しない。
4. 本番相当の配信環境で業務・外部連携・復旧・端末実機試験を完了する。初期管理者にも一般HTTP APIの自動承認例外を作らない。
5. BELLO_SECURITY_INFRA=enforcedとBELLO_DEVICE_SECURITY=enforcedを一致させる。AppSync・S3の旧経路閉鎖、Next.js・PWA・機器認証を一体で移行する。
6. scripts/check-security-release.cjsを本番CIへ組込済み。対象commit・origin・24時間以内の確認と19項目の証拠が揃わなければ強化モードの本番反映を止める。未検証項目をtrueにして通過させない。

## 復旧・切戻し

scripts/security-operator-recovery.tsは別管理のAWSロールから実行する。既定は確認のみ。本人確認、既存ADMIN、登録済みパスキー、新しいpending端末、公開鍵識別子、申請番号、レコード版を照合して1台だけ承認する。取消済み鍵は復活させない。

DeviceRecoveryOperatorはMFA必須。ユーザー情報の読取と端末・監査イベントの書込に限定し、業務データやユーザー権限を書き換えられない。SSOではaws:MultiFactorAuthPresentが付かない場合があるため、復旧用MFA経路の実地確認が必要。SSOからの復旧リハーサル完了とは扱わない。

切戻しは新機能の書込を止め、影響を限定して原因を確認する。WAF/S3 Denyを先に外さない。強化モードのまま前の正常コードへ戻すことを優先する。旧方式へ戻すなら漏洩・取消済みトークンの復活を防ぎ、全経路を整合させる。未確認なら業務APIを閉じたまま復旧する。

## 監視と残件

IPは信頼できる配信層情報だけを採用する。X-Forwarded-Forを信用しない。Hostingの上書き確認まではhosting-unverifiedと記録する。

infra/security-edge.tsにAmplify用WAFを用意した。us-east-1/CLOUDFRONT、初期count、明示指定でのみ関連付ける。合成確認済み、本番未適用。Amplify WAF連携は1アプリ月15米ドルにWAF利用料が別途必要。

検証用エラーアラームはあるが通知先・到達確認は未完了。root MFA有効・root access keyなしを読取確認済み。調査対象リージョンでGuardDuty detectorとCloudTrail trailは見つからなかった。長期監視・証跡整備は残件。標準CloudTrailイベント履歴がないという意味ではない。

未完了の受け入れ条件：
- 実iPhone Face ID、実Windows Hello、実ブラウザ再起動・翌日利用。
- Amplify配信環境でのIP取得とエッジ制御。
- 復旧用MFA経路と切戻しの実地リハーサル。
- アラート通知先・到達確認と長期AWS監視。
- 新認証配下の全外部OAuth・本番相当ワーカーの回帰。
- 本番切替と切替後のスタッフ確認。

## 保証範囲

抽出不可鍵でも物理端末を完全には識別できない。OS侵害、同一サイトXSS、ブラウザプロファイル全体の侵害まで防ぐとは説明しない。OS更新、Defender等、画面ロック、ディスク暗号化、拡張機能管理も必要。生体情報はBELLOへ送らず、端末によってPIN等で本人確認する。

本番未変更の現段階で、実運用が既に強化されたとは言わない。「日本で上位」という順位や安全性の倍率を試験件数から算出しない。

公式根拠：
- https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html
- https://docs.aws.amazon.com/amplify/latest/userguide/amplify-SSR-compute-role.html
- https://docs.aws.amazon.com/amplify/latest/userguide/ssr-environment-variables.html
- https://docs.aws.amazon.com/amplify/latest/userguide/amplify-waf-CDK.html
- https://docs.aws.amazon.com/amplify/latest/userguide/waf-pricing.html
