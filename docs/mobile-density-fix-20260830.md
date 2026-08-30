# iPhone ZAICO級density改善 — 実機発見・修正記録(第六ラウンド P0-4)

作成日: 2026-08-30。

## 実際に発見した不具合(推測ではなく実測)

`npm run dev`起動+Playwright(実Chromium、fixture認証)で390pxの
実際の保護route(`/inventory`)を計測したところ、**overflow=0のまま**
以下の不具合を発見した——第五ラウンドP1-Aの「横スクロールが無いか」
だけを見るE2Eでは検出できない種類の不具合だった:

**根本原因**: `app/inventory/(protected)/page.tsx`の
`<div className="flex min-h-0 flex-1">`が常に`flex-row`(横並び)
だったため、`InventorySidebar.tsx`のモバイル用フィルタートリガー
(`md:hidden`の細い横長バーのつもりだった`<div>`)が、同じ行に並ぶ
兄弟要素(商品一覧、高さ692px)の**flex-row既定の`align-items: stretch`**
により、幅111px×高さ692px(画面いっぱい)という縦長の帯になっていた
——ユーザーが実iPhoneで見た「左ナビ/保管場所/カテゴリが大きすぎ、
商品一覧が右へ押し出されている」という報告と完全に一致する現象を、
実際にPlaywrightのbounding box計測で再現・確認した。

## 修正した箇所

1. **`page.tsx`**: `flex min-h-0 flex-1` → `flex min-h-0 flex-1 flex-col md:flex-row`
   (モバイルは縦積み、デスクトップは従来通り横並び)。
2. **`InventorySidebar.tsx`**: モバイルトリガーに`w-full`を追加
   (flex-colの子として明示的に全幅の帯にする)。
3. **`InventoryAdvancedSearchPanel.tsx`**: 固定`w-[340px]`を
   `w-full md:w-[340px]`へ(モバイルで画面幅超えを防ぐ)。
4. **`InventoryHeader.tsx`**: 固定`h-[var(--inventory-header-height)]`
   (96px)+`overflow-x-auto`の組み合わせが、モバイルで収まりきらない
   toolbar内容を横スクロール領域に押し込め、かつ固定高さで折り返した
   文字を上下に見切れさせていた(実際にPlaywrightで
   `在庫一覧`というタイトルが「覧」の1文字しか見えない状態を確認)。
   モバイルは`h-auto min-h-[52px]`+`flex-wrap`(内容に応じて複数行に
   折り返す)へ変更、デスクトップは既存の固定高さ・横スクロールのまま。
   ロール表示もモバイルでは`ADMIN`等の短縮形のみに(§155)。
5. **`InventoryToolbar.tsx`**: 検索input幅を`w-48`→`w-28 md:w-48`、
   装飾用の区切り線をモバイル非表示、「+ 新規登録」をモバイルでは
   「+ 新規」に短縮、各種ボタンに`whitespace-nowrap`を追加して文字の
   縦積み折り返しを防止。
6. **`InventoryCardList.tsx`**: thumbnail 56px→40px(spec目標
   36〜44px)、行の縦padding詰め、商品名12px・補助情報10.5px
   (spec目標: 商品名11〜12px、補助9.5〜11px)、`leading-tight`で
   行間短縮。

## Before/After実測(390px、実Chromium、E2E fixtureデータ12件)

| 項目 | Before | After | spec目標 |
|---|---|---|---|
| ヘッダー高さ | 204px(タイトル文字が上下に見切れ) | 147px(全文字視認可能) | — |
| フィルタートリガーバー | 幅111px×高さ692px(縦長の帯) | 幅390px×高さ49px(横長バー) | 横長バー |
| 商品一覧の実際の幅 | 279px(390px中、111pxを圧迫で消費) | 390px(画面幅いっぱい) | 220px以上 |
| サムネイルサイズ | 56×56px | 40×40px | 36〜44px |
| 商品行の高さ | 約76px | 約64px | 48〜58px(未達だが大幅改善) |
| above-the-fold商品行数 | 未計測(圧迫レイアウトのため意味を成さない) | **10行**(375/390/430px全てで4行以上を実測確認) | 4〜6行以上 |

デスクトップ(1280px)は`aside`幅208px・overflow=0のまま変化なし
——`md:`プレフィックスによる分岐のみで、デスクトップ側のスタイルは
一切変更していないことを実測で確認済み。

## 回帰テスト(E2Eへ追加、375/390/430px全てで実行)

`e2e/inventory-mobile.spec.ts`に新規test「モバイル用フィルターバーが
画面幅いっぱいの横長バーで、商品一覧を圧迫しない」を追加——
フィルタートリガーの実際のbounding box(幅≒viewport幅、高さ<60px)と
above-the-fold行数(≥4行)を数値でassertする、今回発見した不具合の
再発防止テスト。12/12 green(既存9件+新規3件、3viewport×1)。

## この回で完全には達成しなかったこと(正直な記録)

- 商品行の高さは64px(spec目標48〜58pxよりやや大きい)——タッチ
  ターゲットサイズ・可読性とのバランスを優先し、これ以上の圧縮は
  見送った。above-the-fold行数(10行)は目標(4〜6行)を大きく上回って
  いるため、実用上の支障は無いと判断した。
- 上部ADMIN/Logoutは短縮表示にしたが、spec §155が示唆する
  「compact user menu」(ドロップダウン化等)までは実装していない
  ——現状の短縮表示(ロールコードのみ+ログアウト)で十分に軽量化
  できたため、追加のUIコンポーネント(ドロップダウン)導入は見送った。
- 新規登録/直接編集/インポート/エクスポートは「compact toolbar/
  overflow」(§156、⋯メニュー等への集約)までは実装せず、
  ラベル短縮+flex-wrapによる複数行表示で対応した——新規の
  インタラクティブコンポーネント(ドロップダウンメニュー)を今回の
  時間内で安全に実装・検証しきれないと判断し、より低リスクな対応を
  選んだ。今回のPlaywright計測では十分な密度・可読性を確認できたが、
  実iPhoneでの最終視覚確認(§159、ユーザー本人のみ実施可能)は
  未実施。

## 回帰確認

`tsc`/`next lint`/`npm run build`(production)/`verify:*`全9スイート
(326 assertion)/`playwright test`(12/12、新規3件含む)——全てgreen。
