# AI自動下書き Server Components render error — 再現・原因・修正記録(第六ラウンド P0-1)

作成日: 2026-08-30。

## 現象(ユーザー報告)

AI自動下書き機能を操作すると、以下の文言がエラーとして表示される:

> An error occurred in the Server Components render. The specific message
> is omitted in production builds to avoid leaking sensitive details. A
> digest property is included on this error instance which may provide
> additional details about the nature of the error.

## 再現(実機、推測ではない)

`npm run build && npm run start`(production build)を実際に起動し、
一時的な検証用ルート/Server Actionを作って以下を実測した(検証後は
削除済み、リポジトリには残っていない):

1. `"use server"`関数(Server Action)が`throw new Error("何らかの安全な
   日本語メッセージ")`すると、production buildではNext.js自身が
   **メッセージ本文を問答無用でマスクする**——クライアント側で
   `catch (err) { err.message }`しても、常に上記の文言(一言一句)が
   返ってくる。dev modeでは再現しない(実際のメッセージがそのまま
   届く)。
2. これはこのリポジトリのバグではなく、**Next.js 14自身の意図的な
   仕様**(Server Actionのthrow値はproduction buildで内容を漏らさない
   よう安全側にマスクされる、Next.js公式ドキュメントが明記する挙動)。
3. `find app -iname "error.tsx" -o -iname "global-error.tsx"`が
   0件——このアプリには**App Routerのエラーバウンダリが1つも存在しな
   かった**。そのためエラーバウンダリで捕捉されない例外は、Next.jsの
   既定フォールバック("Application error: a server-side exception has
   occurred...")がそのまま表示される。

## データフロー監査

`app/inventory/(protected)/[id]/listing/ListingForm.tsx`の
「AIで下書きを生成」ボタン → `app/actions/ai.ts`の
`generateListingCopyAction`(Server Action)→
`lib/inventory/queries.ts`の`getInventoryDetail` →
`lib/ai/ecCopy.ts`の`generateListingCopy` →
`lib/ai/gateway/gateway.ts`の`generateStructured` →
`lib/ai/gateway/anthropicProvider.ts`が実際にAnthropic APIを呼ぶ。

`handleGenerateWithAi`(クライアント側)は元々`try/catch`で
Server Actionの例外を捕まえて`draftError`へ表示する設計だった
——**この設計自体は正しい**。問題は、捕まえた`err.message`の中身が
Next.jsのmaskingにより既に安全な日本語メッセージから汎用文言へ
すり替わっていたこと。

## 根本原因

1. **主因**: Server Actionが業務エラー(権限不足・対象が見つからない・
   AI provider未設定/エラー)を`throw`で伝えていたため、production
   buildでNext.jsのmasking機構を経由し、せっかく安全に書かれていた
   日本語メッセージが汎用文言へ置き換わっていた。
2. **副次要因**: アプリ全体にApp Routerのエラーバウンダリ
   (`error.tsx`/`global-error.tsx`)が1つも存在せず、AI関連以外も含め、
   本当に予期しない例外(バグ・AWS SDK内部エラー等)が発生した場合に
   Next.jsの意味のない既定フォールバック画面がそのままユーザーに
   見えてしまう構造だった。

## 修正(根本修正、try/catchで隠すだけの対応ではない)

### 1. Server Actionの契約を「throw」から「return」へ変更

`app/actions/ai.ts`の`generateListingCopyAction`/
`generateReplyDraftAction`を、例外を投げる関数から
`{ok:true,data} | {ok:false,error,correlationId}`という
シリアライズ可能な戻り値を返す関数へ変更した——Next.js公式が推奨する
「Server Actionのユーザー向けエラーはthrowでなくreturnで伝える」
パターン。

- 元の例外(スタック・error name含む)は`correlationId`(UUID)付きで
  必ずサーバー側`console.error`へstructured logとして記録してから、
  安全な`err.message`(このリポジトリ全体の既存方針——secretを
  絶対に含めない設計、`describeAnthropicError`等——により元から
  安全)をクライアントへ返す。
- 呼び出し元2箇所(`ListingForm.tsx`, `MessagesInbox.tsx`)を新しい
  戻り値の形へ追随させた。

### 2. App Routerエラーバウンダリの新設

`app/global-error.tsx`(ルート全体の最終防波堤)、
`app/inventory/error.tsx`、`app/admin/error.tsx`を新設。安全な業務向け
メッセージ+`error.digest`(secretを含まない参照番号)+再試行ボタンを
表示する——**「エラーを隠す」対応ではなく、Next.js公式のエラー
バウンダリ機構そのもの**。実際の例外の詳細はNext.js自身がサーバー側
stderrへ完全なstack付きで出力し続けるため、開発者は`digest`を手がかりに
サーバーログを追跡できる。

## 修正の実機検証(再現と同じ手法で確認、推測ではない)

一時的な検証用ルート/Server Action(検証後削除済み)を用意し、
production buildで以下を確認した:

1. 修正後の`generateListingCopyAction`を(意図的に権限エラーを
   誘発する形で)呼び出した結果、クライアントが受け取った値は:
   ```json
   {"ok":false,"error":"この操作にはADMINまたはEDITOR権限が必要です。","correlationId":"54aaae45-94b6-450b-b624-ad89fe9f7520"}
   ```
   ——Next.jsのmaskingを経由せず、元の安全な日本語メッセージがそのまま
   届くことを確認。
2. `/inventory`配下で意図的に例外を投げるページを用意したところ、
   `app/inventory/error.tsx`が正しく捕捉し、
   「画面の表示中に問題が発生しました」+参照番号+再試行/一覧へ戻る
   ボタンが表示されることを確認(Next.js既定の無意味な
   フォールバックではなくなった)。

## 回帰確認

- `tsc --noEmit`: green
- `next lint`: green(warning 0件)
- `npm run build`(production mode): green
- `verify:*` 全9スイート: green(306 assertion、既存回帰なし)
- `npx playwright test`(375/390/430px E2E、9件): green

## 分類

**LOCAL_VERIFIED**(production buildで実機再現・実機修正確認済み)。
実Anthropic API keyを使った実際のAI応答生成そのものの検証は
`AI key不在`の条件下でのエラーメッセージ差し替えのみを検証しており、
実際の成功応答の実AWS/実API検証はAWS staging到達性(P0-6)と同じ
BLOCKED_BY_USER条件に依存する。
