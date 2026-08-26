# BASE商品検索・AI特集ページ自動生成システム

「Softshell」と検索 → 該当商品を画像付きで表示 → 複数選択 → 「選択したN商品で特集を生成」→
AIがコピーを生成 → プレビュー・編集 → 公開、を数分で完了させるための管理画面と、
生成された特集ページ(`/features/[slug]`)を配信する仕組みです。

## 現在のフェーズ: Phase 1 (MVP)

実装済み:
- BASE OAuth認証の土台(`lib/base/oauth.ts`) — **エンドポイント未確認、`docs/NOTES_BASE_API.md` 参照**
- 商品検索・複数選択・全選択/選択解除・選択数表示・URL貼り付けによる補助追加
- 「選択したN商品で特集を生成」→ AIによるコピー生成 → DRAFTとして保存
- COLLECTION / BRAND / FEATURE テンプレートの自動判定(ヒューリスティック、AIには判定させない)
- プレビュー画面での編集(タイトル・キャッチコピー・導入文・テンプレート等)、全体再生成、公開/非公開/アーカイブ/削除
- 公開ページ(HERO → INTRODUCTION → COLOR VARIATION(該当時) → 商品一覧 → CTA)
- AIは商品固有の事実(価格・在庫・サイズ・素材・年代・デザイナー等)を一切生成しない設計(`lib/ai/prompt.ts`)

未実装(Phase 2以降。`docs`内のコメントに設計意図を記載済み):
- 価格・在庫の定期同期(`BaseItemCache` へのバッチ更新)
- 売り切れ率の計算・アーカイブ推奨バナー
- 商品のドラッグ&ドロップ並び替え
- セクション単位でのAI部分再生成(`lib/ai` にAPIは用意済み、UI未接続)
- BRAND / FEATURE テンプレートの専用レイアウト差別化、SEO自動最適化、AIによる特集候補の自動提案

**現状は `BASE_USE_MOCK=true`(デフォルト)でモックデータのみ動作します。** 実際のBASE商品を
検索・生成できるようにするには、`docs/NOTES_BASE_API.md` のチェックリストを埋めてから
`lib/base/client.real.ts` / `lib/base/oauth.ts` を確定仕様に合わせて修正し、
`BASE_USE_MOCK=false` に切り替えてください。

## セットアップ

```bash
npm install
cp .env.example .env   # 値を埋める(AIキーは必須、BASEはモックのままなら不要)
npx ampx sandbox        # Amplifyバックエンド(Auth/Data)をデプロイし amplify_outputs.json を生成
npm run dev
```

`ampx sandbox` 実行後、管理者アカウントを1件作成し `Admins` グループに追加してください
(Cognitoユーザープールに対して、AWSコンソールまたは `aws cognito-idp admin-create-user` /
`admin-add-user-to-group` で実施)。`/admin` 配下は `Admins` グループのメンバーのみアクセスできます。

## 環境変数

`.env.example` を参照してください。秘密情報(`BASE_CLIENT_SECRET` / `ANTHROPIC_API_KEY` 等)は
すべてサーバー側(Next.jsのRoute Handler / Server Action)でのみ参照され、クライアントバンドルには
含まれません。`.env` はコミットしないでください(`.gitignore` 済み)。

## ディレクトリ構成

```
amplify/                Amplify Gen2 バックエンド定義(Auth + Data)
app/admin/              管理画面(検索・選択・生成・編集・公開)
app/features/[slug]/    公開される特集ページ
app/actions/            Server Actions(BASE検索・特集の生成/更新/公開等)
components/features/    特集ページのUIパーツ(Hero/Introduction/ColorVariation/ProductGrid/Cta)
lib/base/               BASE APIクライアント抽象化(モック/実装を切り替え可能)
lib/ai/                 AIプロバイダ抽象化(Anthropic既定、OpenAIに切り替え可能)
docs/NOTES_BASE_API.md  BASE API仕様のうち未確認の項目一覧
```
