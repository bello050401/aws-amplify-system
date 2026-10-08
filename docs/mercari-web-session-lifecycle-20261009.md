# メルカリShops通常ログイン状態のWeb側管理（2026-10-09）

本人の確定方針は、最初に本人が通常ログインし、その状態を安全に保管したうえで、普段の商品・画像処理はBELLOサーバーからHTTPで行うこと。認証が実際に切れた場合だけ再ログインを求める。PC常駐、画面操作による通常出品、Public APIトークン方式には切り替えない。

## この差分で実装したもの

`webHttpSessionLifecycle.ts` はサーバー専用の状態管理である。将来の**本人操作を伴う信頼済みログイン取得器**から、店舗・Cognito本人sub・固定セッションID・認証時刻・不透明な認証状態・判明している期限を受け取る。保存前に同じ認証状態で読取プローブが `VALID` を返した場合だけ保存する。認証状態そのもの、プローブの応答本文、例外文は戻り値にもログにも出さない。取得器や読取プローブの実Shops実装はまだ存在しない。

後続の利用時は毎回保存内容を読み、本人・店舗・形式・判明している期限を確認し、読取プローブを再実行する。期限が不明なら任意の固定寿命を置かず、読取で有効性を判断する。`EXPIRED` または判明している期限切れは `AUTH_REQUIRED` として再ログイン待ちにする。通信障害等の `UNKNOWN` は `AUTH_UNVERIFIED` として停止し、認証切れとは決め付けない。どの結果も `allowHttpWrite=false` で、送信許可を返さない。

`webHttpSessionSecretStore.ts` は**事前に用意された専用Secret ARN**に対する `GetSecretValue` / `PutSecretValue` のみを実装する。旧Public API用の `bello/mercari-access-token` は利用しない。`CreateSecret`、実AWS呼出し、Secret作成、IAM変更は今回行っていない。Secrets Managerは保存値を暗号化し、更新時に新しいバージョンを作る。[AWSの暗号化仕様](https://docs.aws.amazon.com/secretsmanager/latest/userguide/security-encryption.html)、[バージョン仕様](https://docs.aws.amazon.com/secretsmanager/latest/userguide/manage_update-secret-value.html)を参照。

## 実送信までの未実証条件

1. 本人がBELLOから利用できる隔離ブラウザーでShopsへ通常ログインし、認証状態をサーバーへ安全に引き渡す取得器。方式、2FA、保存サイズ、本人・店舗との結び付け、Shops側の利用許可は未実証。ユーザー名・パスワード・CookieをBELLO画面やログへコピーする設計にはしない。
2. 保存した不透明状態を使って、既知の `GetProductDraft` を同じ実行環境から読み、`VALID` / `EXPIRED` / `UNKNOWN` を秘密非出力で判定する実プローブ。HTTP認証に必要なCookie以外の状態やCSRF条件はまだ不明。今回のモック結果を実認証の成功と扱わない。
3. 専用Secretの保管方法とIAM最小権限、旧バージョン保持・失効時の破棄、同時再ログインの扱い。Secretの既存有無・実IAMは今回確認していない。Secret作成やKMS設定には費用と運用判断が伴うため実施していない。
4. 実送信器は、保存済みという理由だけで動かさず、送信直前の最新認証確認、既存商品・下書き重複照合、店舗30秒枠の原子的予約、結果不明時の再送停止が必要。下書き作成の二重成功は[HAR証拠](mercari-b005396-http-draft-har-evidence-20261009.md)で確認済み。画像アップロード要求本文も未観測。

今回の検証はモックの認証状態・Secretクライアントのみ。Shopsログイン、秘密の抽出・表示、HTTP実読取・書込、AWS資源作成、公開は行っていない。既存EC出品、BASE、Next Engineには変更を加えていない。
