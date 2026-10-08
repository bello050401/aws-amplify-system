# BELLO WebからのShops通常ログインをサーバー送信へ使う条件（2026-10-09）

追記: 本人は通常ログイン状態をWeb側に安全保存し、商品・画像の通常処理をHTTPで行う方針を確定した。認証状態の保存境界と再認証停止の実装範囲は[セッション管理](mercari-web-session-lifecycle-20261009.md)を参照。本書のPublic API比較は方針変更案ではない。

## 判定

**現行のBELLO Amplify構成だけで、本人がShopsの通常ログイン画面に入った結果をBELLOサーバーのHTTP認証状態として受け取る経路は確認できない。** PC常駐なしの構成は技術的に検討可能だが、Shopsが認める委譲方式またはサーバー側で動く対話ブラウザーと、その認証状態の安全な保管・再認証・失効処理が別途必要。現時点で「安全に実装可能」「送信できる」とは判定しない。

本人の指定は**通常ログインの認証状態を使うHTTP方式**。公式Public APIのPersonal API Access Token方式へ設計を切り替えない。両者はエンドポイントも認証方式も異なる。

## 既存BELLOで確認した範囲

| 箇所 | 現状 | この設計への意味 |
| --- | --- | --- |
| `lib/amplify/requireInventoryUser.ts` | BELLO管理者のCognitoセッションをサーバーで検証し、ADMINと本人識別子を取得する。 | BELLO側の操作権限と監査には使える。Shopsのログインとは独立。 |
| `SettingsTabs.tsx` / `MercariPcConnectionPanel.tsx` | メルカリ欄はPC読取結果の確認と証拠報告。旧 `MercariSettingsPanel.tsx` と `app/actions/mercariSecret.ts` は実装が撤去された空ファイル。 | Shops通常ログインの開始、接続状態、切断を扱う画面・Actionはない。 |
| `amplify/data/resource.ts` | `MercariBridgeHttpDraftJob` はBELLOスナップショット、`HttpShopSendSlot` と `HttpSendAttempt` は送信予約用。 | Shopsの認証状態を保持するモデルではない。送信器にも未接続。 |
| `amplify/backend.ts` | 旧Public API用 `bello/mercari-access-token` Secret定義と、SSR実行ロールへのSecret権限を別途設定する旨の記述が残る。 | これは通常ログインのブラウザーセッション保存先として流用しない。AWS上の現在値・実IAMは今回読んでいない。 |
| `webHttpObservedDraftRead.ts` | 認証済みtransportを注入すれば既知のB005396下書き2件を読取照合するが、実transportはない。 | 認証方式が証明されるまでHTTP実読取・書込は起動しない。 |

本人がBELLOから別タブで `mercari-shops.com` にログインしても、ブラウザーのShops CookieはBELLOのAmplifyドメインへ送られず、BELLOのCognito Cookieにも変わらない。[HTTP Cookieのドメイン規則](https://www.rfc-editor.org/rfc/rfc6265)からの推論であり、HAR内にサーバーへ渡せる認可コードやShopsのBELLO向けcallbackが観測されたわけでもない。Cookieの手動コピーやHARからの抽出は通常ログイン連携として採用しない。

## 成立させるための外部条件と最小差分

### 1. Shopsが正式なログイン委譲を提供する場合

ShopsからBELLOへ戻せる認可コード等の仕様、利用許可、クライアント登録、期限・再認証・取消仕様が必要。今回確認した[Shops公式API資料](https://api.mercari-shops.com/docs/index.html)にはPublic API用Bearerトークンの説明があるが、管理画面の通常ログインを第三者サーバーへ委譲する仕様は確認できなかった。**「存在しない」と断定はしない。**

仕様と許可を取得できた場合の最小差分は、ADMIN専用の接続開始・callback・接続解除Route、state/nonce等の照合、ショップとCognito本人の紐付け、暗号化した認証状態のサーバー専用保管、期限・失効の扱い、設定画面の状態表示、読取のみの接続確認、既存ジョブ・予約処理との接続。秘密値はClient Component、Amplify Dataの一般読取モデル、ログ、URLへ返さない。これは仕様が確定した後の設計候補であり、まだ実装していない。

### 2. 正式な委譲がなく、サーバー側の対話ブラウザーで通常ログインする場合

PC常駐の代わりに、本人がBELLO設定画面から接続する**隔離されたクラウドブラウザー**を別サービスで起動し、本人がその画面でShopsに通常ログインする案は技術上の候補。ログイン状態をそのブラウザーからサーバー側で暗号化保存し、同じ所有者・店舗だけが短期限で使用し、切断時に消去する。Amplify SSRの既存Server Actionだけでブラウザーセッションを持続させる小変更ではない。対話UI、隔離実行基盤、秘密保管、期限・再認証、2FA、同時利用、監査、障害時の破棄を新設する必要がある。

この案でも、Shopsがその利用形態を認めるか、ブラウザーで成立した認証がサーバーの直接HTTPへ移せるかは未確認。HARには認証Cookie/ヘッダーと画像アップロード要求本文がなく、CSRF等の追加条件も未実証。まず提供元の許可・仕様と、公開・書込を行わない読取検証が必要。実送信やログイン自動化には進めない。

## Public APIとの比較だけ

[Shops公式資料](https://api.mercari-shops.com/docs/index.html)はPublic APIのBearerトークン、契約時のAPI_CLIENT_NAME、国内の申請済み固定送信元IPを定め、[公式ガイド](https://support.mercari-shops.com/hc/ja/articles/12290169038617-API%E3%82%A2%E3%82%AF%E3%82%BB%E3%82%B9%E3%83%88%E3%83%BC%E3%82%AF%E3%83%B3%E3%82%92%E7%99%BA%E8%A1%8C%E3%81%99%E3%82%8B%E6%96%B9%E6%B3%95)は管理画面でのトークン発行手順を示す。これは `api.mercari-shops.com/v1/graphql` 向けで、観測した通常画面の `mercari-shops.com/graphql` のログイン状態をBELLOへ渡す方法ではない。本人が拒否した方式への変更案として扱わない。

今回、AWSやShopsのログイン操作、秘密値の読取、Cookie取得、HTTP実送信はしていない。
