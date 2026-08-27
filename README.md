# BASE商品検索・AI特集ページ自動生成システム

「Softshell」と検索 → 該当商品を画像付きで表示 → 複数選択 → 「選択したN商品で特集を生成」→
AIがコピーを生成 → プレビュー・編集 → 公開、を数分で完了させるための管理画面と、
生成された特集ページ(`/features/[slug]`)を配信する仕組みです。

## 現在のフェーズ: Phase 1 (MVP)

実装済み:
- BASE OAuth2連携(認可コードフロー・トークン更新・DB保存) — `lib/base/oauth.ts`、詳細は `docs/NOTES_BASE_API.md`
- 商品検索・複数選択・全選択/選択解除・選択数表示・URL貼り付けによる補助追加
- 「選択したN商品で特集を生成」→ AIによるコピー生成 → DRAFTとして保存
- COLLECTION / BRAND / FEATURE テンプレートの自動判定(ヒューリスティック、AIには判定させない)
- プレビュー画面での編集(タイトル・キャッチコピー・導入文・テンプレート等)、全体再生成、公開/非公開/アーカイブ/削除
- 公開ページ(HERO → INTRODUCTION → COLOR VARIATION(該当時) → 商品一覧 → CTA)
- AIは商品固有の事実(価格・在庫・サイズ・素材・年代・デザイナー等)を一切生成しない設計(`lib/ai/prompt.ts`)

未実装(Phase 2以降。`docs`内のコメントに設計意図を記載済み):
- 価格・在庫の定期同期(現状は管理画面操作のたびに`BaseItemCache`を更新。Phase 2で定期ジョブ化)
- 売り切れ率の計算・アーカイブ推奨バナー
- 商品のドラッグ&ドロップ並び替え
- セクション単位でのAI部分再生成(`lib/ai` にAPIは用意済み、UI未接続)
- BRAND / FEATURE テンプレートの専用レイアウト差別化、SEO自動最適化、AIによる特集候補の自動提案

## セットアップ

```bash
npm install
cp .env.example .env   # 値を埋める(下記「BASEと接続する」参照)
npx ampx sandbox        # Amplifyバックエンド(Auth/Data)をデプロイし amplify_outputs.json を生成
npm run dev
```

`ampx sandbox` 実行後、管理者アカウントを1件作成し `Admins` グループに追加してください
(Cognitoユーザープールに対して、AWSコンソールまたは `aws cognito-idp admin-create-user` /
`admin-add-user-to-group` で実施)。`/admin` 配下は `Admins` グループのメンバーのみアクセスできます。

### `amplify/package.json` を消さないでください

`amplify/` 配下にだけ存在する `{"type": "module"}` のみの小さな `package.json` は、意図的に置いてあります。
`ampx sandbox` は `amplify/backend.ts` を `tsx` の `tsImport()` というAPIで読み込みますが、
プロジェクト全体がCommonJS前提(Next.jsの標準)のままだと、そのAPIが `amplify/auth/resource` や
`amplify/data/resource` のような**同一ファイル内の他ファイルへの相対import**を解決できず、
`Cannot find module .../amplify/auth/resource` のようなエラーでデプロイに失敗します
(OS非依存の再現済みバグで、Windows固有の問題ではありません)。`amplify/` フォルダだけ
ESM(`"type": "module"`)であることをNode.jsに伝えることで解決します。ルート側の `package.json` は
Next.js側の都合でCommonJSのままにする必要があるため、このファイルは `amplify/` の中だけに置いています。

## BASEと接続する(実データでの動作に必須)

### 1. BASE DevelopersでコールバックURLを登録する

BASE Developers(developer.thebase.in)で、作成済みのアプリの編集画面を開き、
**「コールバックURL」欄に以下をそのまま貼り付けて保存してください。**

ローカル開発用:
```
http://localhost:3000/api/base/oauth/callback
```

本番(Amplify Hostingにデプロイ後、割り当てられたドメインが分かってから追加):
```
https://<あなたのAmplifyドメイン>/api/base/oauth/callback
```

同じ画面に表示されている **Client ID** と **Client Secret** をコピーしておいてください
(次の手順で使います)。

### 2. 環境変数を設定する

**ローカル開発**(`.env`):

| 変数名 | 値 |
|---|---|
| `BASE_CLIENT_ID` | BASE Developersに表示されているClient ID |
| `BASE_CLIENT_SECRET` | 同上 Client Secret |
| `BASE_REDIRECT_URI` | `http://localhost:3000/api/base/oauth/callback` |
| `BASE_SCOPES` | `read_items` |
| `BASE_USE_MOCK` | `false` |
| `AI_PROVIDER` | `anthropic`(既定値。特集の自動生成に使うAIプロバイダ) |
| `ANTHROPIC_API_KEY` | [Anthropic Console](https://console.anthropic.com/settings/keys) で発行したAPIキー。「特集を生成」ボタンを押す機能(`lib/ai/anthropic.ts`)にのみ必要 — 検索やBASE連携そのものには不要です |

`ANTHROPIC_API_KEY` が未設定のまま「特集を生成」を押すと、`ANTHROPIC_API_KEY is not set.`
というエラーがそのまま管理画面に表示されます(隠さずそのまま出す設計です)。

**Amplify Hosting(本番)**: AWSコンソール → Amplify → 対象アプリ →
「Hosting」→「環境変数」で、同じキー名(上表すべて)を追加してください(`BASE_REDIRECT_URI` は
本番ドメインの値に変更)。これらはNext.jsのサーバー側でのみ読み込まれ、ブラウザに渡るバンドルには含まれません。
(Amplify Gen2の `ampx sandbox secret set` はバックエンドのLambda関数向けの仕組みで、
今回のようなNext.js SSRアプリの実行時環境変数は、上記のHosting環境変数の方で設定します。)

### 3. 管理画面から接続する

デプロイ(またはローカル起動)後、管理者アカウントで `/admin/settings` を開き、
**「BASEと接続する」を押してBASE側の認可画面で承認してください。** これがこのフローの中で
唯一「本人にしかできない操作」です — BASE側は自分のショップとして本人が承認する必要があります。
承認後、自動的に`/admin/settings`に戻り「接続済み」と表示されれば完了です。

### 4. 動作確認

`/admin/search` で「Softshell」と検索し、実際のBASE商品が画像付きで表示されることを確認してください。
価格や画像が空で返ってくる場合は、サーバーログの `[BASE mapItem] unexpected item shape` を確認してください
(`docs/NOTES_BASE_API.md` 参照)。

## 環境変数一覧

`.env.example` を参照してください。秘密情報(`BASE_CLIENT_SECRET` / `ANTHROPIC_API_KEY` 等)は
すべてサーバー側(Next.jsのRoute Handler / Server Action)でのみ参照され、クライアントバンドルには
含まれません。`.env` はコミットしないでください(`.gitignore` 済み)。BASEのアクセストークン/
リフレッシュトークン自体は環境変数ではなく、Amplify Data(`BaseOAuthToken`、管理者のみアクセス可)に
保存され、有効期限が近づくと自動更新されます。

## ディレクトリ構成

```
amplify/                Amplify Gen2 バックエンド定義(Auth + Data)
app/admin/               管理画面(検索・選択・生成・編集・公開・BASE連携設定)
app/api/base/oauth/      BASE OAuth2の開始/コールバックルート
app/features/[slug]/     公開される特集ページ(BaseItemCacheのみを参照、BASEトークン不要)
app/actions/             Server Actions(BASE検索・特集の生成/更新/公開等)
components/features/     特集ページのUIパーツ(Hero/Introduction/ColorVariation/ProductGrid/Cta)
lib/base/                BASE APIクライアント抽象化(モック/実装を切り替え可能)
lib/features/baseSync.ts 管理画面操作のたびにBaseItemCacheを更新するヘルパー
lib/ai/                  AIプロバイダ抽象化(Anthropic既定、OpenAIに切り替え可能)
docs/NOTES_BASE_API.md   BASE API実装メモ(確認済み/要注意ポイント)
docs/NOTES_AI.md         Anthropic API実装メモ(thinking/effort設定、エラー調査方法)
```
