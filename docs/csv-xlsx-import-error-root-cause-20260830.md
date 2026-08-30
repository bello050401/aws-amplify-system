# CSV/XLSXインポート「Server Components render error」— 実機再現・根本原因・修正記録

作成日: 2026-08-30。対応指示書: 「不具合修正・ZAICO同期重複根絶・
EC出品UI改善・画像自動加工 完全自律実装指示書」§5。

## 実際に再現した方法(推測ではない)

`docs/ai-draft-error-root-cause-20260830.md`(第六ラウンドP0-1)と同じ
方法論——本物の`next build && next start`(dev modeではなく)+実
Chromium(Playwright)で、実際の`lib/inventory/inventoryImport.ts`の
`parseImportFile`を呼ぶ一時的なrepro route(検証後に削除済み、
`git status --short`で作業ツリーがクリーンであることを確認済み)を
用意し、3種類の入力を実際に投入した:

| 入力 | 結果(修正前) |
|---|---|
| 壊れた/別形式の.xlsx(プレーンテキストを.xlsxとして送信) | HTTP 500、コンソールに`An error occurred in the Server Components render...`、画面には`global-error.tsx`の「予期しないエラーが発生しました」 |
| 0バイトの.csv | 同上 |
| 0バイトの.xlsx | 同上 |

いずれも実際にHTTP 500+コンソールへ`An error occurred in the Server
Components render. The specific message is omitted in production builds
...`という、第六ラウンドP0-1で特定したのと全く同じNext.js本番ビルドの
仕様(`"use server"`関数からthrowされた値の`.message`を安全な定型文へ
強制的に書き換える)が発火することを確認した。

## 根本原因

`app/actions/inventoryImport.ts`の3つのServer Action
(`parseInventoryImportFileAction`/`previewInventoryImportAction`/
`executeInventoryImportAction`)が、検証エラーを含め全て`throw`する
設計になっていた。`lib/inventory/inventoryImport.ts`自体は既に
「ヘッダー行が見つかりませんでした」「1回のインポートは最大◯件まで
です」等、丁寧な日本語エラーメッセージを用意していたが、これらは
production環境では**全てNext.jsに握りつぶされ、`err.message`が
一律「An error occurred in the Server Components render...」という
定型文に置き換わっていた**——実際に再現して確認するまで、この
「せっかく書いた丁寧なメッセージが本番では意味をなさない」という
実害には気づけなかった。

追加で2つの具体的な実害を発見した(実機確認済み、コードを実際に
実行してから発見):

1. **壊れた/別形式のExcelファイル**: `ExcelJS`の`workbook.xlsx.load()`
   がZIP構造の解析に失敗して例外を投げるが、これがキャッチされずに
   上位へそのまま伝播していた。
2. **CSVの文字コード決め打ち**: `new TextDecoder("utf-8").decode(bytes)`
   はTextDecoderの既定動作により、不正なUTF-8バイト列を**例外を出さず
   にU+FFFDへ置換して**しまう——Excel(Windows既定)で「CSV」として
   保存すると多くの場合Shift_JIS(CP932)になるが、これを読み込んでも
   エラーにすらならず、文字化けした内容をそのまま列見出しとして扱って
   いた(自動マッピングが全滅する、クラッシュより発見しにくい不具合)。

## 修正内容

### 1. `app/actions/inventoryImport.ts` — throwしない設計へ

R6 P0-1で確立した`{ok:true,data}|{ok:false,error,correlationId}`
パターン(`app/actions/ai.ts`と同じ`logActionFailure`/
`safeErrorMessage`)を適用。3つのAction全てが、権限エラー・検証
エラー・予期しないエラーのいずれであっても、throwせず安全な値を
返すようになった。`app/inventory/(protected)/ImportWizard.tsx`側も
`res.ok`を確認するよう更新。

### 2. `lib/inventory/inventoryImport.ts` — 実際の壊れ方への対処

- `decodeImportText()`(新規): UTF-8 BOMを除去した上で、まずUTF-8を
  `fatal: true`で試し(不正なバイト列があれば例外を投げさせる——
  Node.jsのTextDecoderでこの検知が機能することを実機確認済み)、
  失敗したらShift_JISとして再デコードする。
- `parseXlsxFile()`: `workbook.xlsx.load()`を`try/catch`で包み、
  「ファイルが破損しているか、正しいExcel形式(.xlsx)ではありません」
  という安全なメッセージへ変換(実際にexceljsが投げる例外
  ——`Can't find end of central directory`等——をログへ残しつつ)。
- `parseImportFile()`: 0バイトファイルを明示的に検知し、「ファイルが
  空です」という分かりやすいメッセージを返す。

### 3. UIステップ番号の修正(§5.3)

`ImportWizard.tsx`のステップ表示が「①ファイル→②内容確認→④結果」
になっていた(③実行は独立画面を持たず②のボタンとして扱う設計だが、
表示ラベルの番号が実際のステップ数に合わせて振り直されていなかった、
単純な表記ミス)。「①②③」へ修正。

## 修正の検証(実機再現→修正→再検証、同じ方法論)

修正後、同じ3種類の入力を、修正後の`app/actions/inventoryImport.ts`と
同じtry/catchパターンを再現する一時repro routeへ実際に通し、いずれも
Next.jsのマスキングを経由せず、意図した安全なメッセージがそのまま
返ることを確認した:

```
CAUGHT: ファイルが破損しているか、正しいExcel形式(.xlsx)ではありません。別のファイルを確認してください。
CAUGHT: ファイルが空です。内容のあるCSVまたはExcelファイルを選択してください。
CAUGHT: ファイルが空です。内容のあるCSVまたはExcelファイルを選択してください。
```

## テスト

`scripts/verify-import.ts`に5件追加(既存38件+新規5件=43件、全green):
- Shift_JISの実バイト列(`iconv -f UTF-8 -t SHIFT_JIS`で生成、生成時に
  逆変換で正しさを確認済み)を`decodeImportText`が正しく検知・
  デコードすること。
- UTF-8 BOM付き/BOM無しの両方が正しく扱われること。
- 壊れたxlsx・0バイトファイルが、原因不明の例外ではなく安全な
  メッセージで失敗すること。

## 正直な残課題

- 実際のProduction/Staging環境での再確認は`BLOCKED_BY_USER`
  (AWS認証情報が無効、`docs/aws-staging-reverify-20260830.md`参照)
  ——このラウンドの検証は全てローカルの実`next build && next start`
  +実Chromiumによるもの。
- Shift_JISフォールバックは「UTF-8として不正なバイト列があれば
  Shift_JISとみなす」という実用的なヒューリスティックであり、
  UTF-8として偶然構文的に正しいが実際は別のレガシーエンコーディング
  である、といった稀なケースまでは救えない(この場合も従来通り
  文字化けするが、少なくともUTF-8/Shift_JISの2大分類は正しく扱える)。
