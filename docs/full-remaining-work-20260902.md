# 全残作業セッションの記録(2026-09-02)

対象ブランチ: `claude/inventory-management-system-5vbvc7`(Staging)
main / Production: **一切変更していない**

指示書:
- `BELLO_20260902_全残作業_中断防止_完全自律実装マスター指示書_ClaudeCode.md`
- `BELLO_20260902_全残作業_中断防止_商品説明設定_ZAICO項目完全監査_マスター指示書_ClaudeCode.md`
  (前者の全文 + 「設定＞商品説明文 / ZAICO項目完全監査」章を追加したもの。
   1〜3918行目は完全に同一であることを diff で確認済み)

すべての数値は実測値。推測値は含まない。

---

## 0. この日いちばん多く見つかった不具合の形

**DynamoDB の `Limit` はフィルタ適用「前」に読む件数の上限**であって、
「合致した件数」ではない。AppSync / Amplify の `list({ filter })` は
これをそのまま反映するので、

```
list({ filter: { rank: { eq: "C" } } })   // limit 未指定 = 既定100
```

は「先頭100行を読み、そのうち rank=C だったものだけ」を1ページとして返す。
**条件に合う行が他に何件あっても、次ページを辿らない限り返らない。**

前回この形で ProcessingJob の PENDING を5日間取りこぼしていたが、
同じ読み方が他に5箇所残っていた。今回それらを塞ぎ、共通ヘルパー
`lib/amplify/listAll.ts` に集約した(上限ページ数に達したら黙って
打ち切らず例外を投げる)。

| 場所 | 症状 | 実測 |
|---|---|---|
| `lookupShippingRate` | 料金があるのに「送料不明」 | 東京都/C・愛知県/Cで**0件**(実際は7,740円/8,490円) |
| `getShippingReferencePrice` | 「東京: データ不足」 | rank=Cで10件しか返らない(実際50件) |
| `findByStrongSignals`(商品特定) | SKU完全一致でも見つからない | Inventory 5,313件に対し limit 50 |
| `listPendingJobStatuses` | 加工中が表示されない | 現在57件(閾値未満なのでまだ動く) |
| `listVersions` | 加工済みが「未加工」に見える | 現在57件(同上) |
| `enqueueProcessingJob` | **重複ジョブを作る** | 同上。取りこぼしが「余計に作る」に化ける |
| `listConversations` | 会話の取りこぼし | 現在5件(同上) |

---

## 1. 完了した項目

### WS-Z ZAICO項目監査

詳細は `docs/zaico-field-mapping-audit-20260902.md`。

- **販売予定価格**: ZAICOは `☆販売予定価格（送料別大原記載）` で値を
  返していたが、対応表に項目が無く unmapped として捨てていた。
  DB上 5,313件中2件しか値が無かった(その2件もCSV/手入力由来)。
- **数量が全件0**: ZAICOは数量を文字列(`"2.0"`)で返すのに
  `typeof === "number"` で判定しており、5,313件すべてが0だった。
- 受け皿が既にあるのに未配線だった項目を14個つないだ。
- 実在商品 B005611 で ZAICO raw ↔ BELLO DB の完全一致を確認。
- `npm run verify:zaico-mapping` 45 assertions(fixtureは実レスポンス)

### WS-A AI返信・値下げ交渉

固定実例:

```
https://bellointeri.base.shop/items/155832757
こちら2脚で6万円になりませんか
```

根本原因は3つ、いずれも配線:

1. **交渉として認識されていなかった。** この文には「値下げ」「値引き」
   「安く」「交渉」のどれも現れない。`intent.ts` のキーワード表も
   `discount.ts` の正規表現も不一致で、intent は OTHER 単独だった。
2. **値下げエンジンが誰からも呼ばれていなかった。** `discount.ts`
   (7%計算・全国送料中央値・地域補正)は完成していたが、import して
   いるのは検証スクリプトだけで、返信パイプラインからの参照が0本。
3. **BASE URLから在庫へ辿る経路が存在しなかった。**
   ChannelListing 0件 / `Inventory.externalProductId` に BASE item_id
   なし(入っているのはメルカリ・ヤフオクのID)。
   `BaseProductArchive` にだけ商品が在った。

対処:

- `lib/inquiry/negotiation.ts` — 金額の提示そのものを交渉として決定的に
  検出。数量(2脚)・希望総額(6万円=60,000)・希望単価(30,000)を構造化。
- `lib/inquiry/negotiationService.ts` — 最大外形3辺 → ランク →
  ShippingRate → 送料、7%引き(既存の `Math.floor` のまま)、
  公式LINE＋請求書払い条件の判定。金額はすべてコード側で確定し、
  AIには一切計算させない。
- `BaseProductArchive` から商品名を引いて照合へ橋渡し。ブランド+語の
  断片の積み上げでは 0.52 で候補の下限0.60に届かなかったので、
  BASE商品ページの正式タイトルを同一性の証拠として scoring へ追加。

実データでの照合結果:

```
0.96  B005611  【在庫2】HAY REVOLVER BAR STOOL HIGH / デンマーク 北欧 …
0.85  B005610  【在庫2】HAY REVOLVER BAR STOOL HIGH / 北欧 デンマーク …
0.70  B004937  【2脚セット】HAY REVOLVER BAR STOOL LOW / …
```

語順だけが違う重複在庫を取り違えない。同名が2件なら同点になり、
既存の同点判定で自動確定せず人の確認へ回る。

配送先が不明なうちは値下げ可否も金額も一切出さない(プロンプトへ渡す
確定事実が空になるので、AIが提示できる金額がそもそも存在しない)。
「埼玉県です」だけが届いたら直前の交渉条件を引き継ぐが、引き継ぐのは
**今回の本文が配送先の回答であるときだけ**で、同じ会話の
「サイズを教えてください」には配送先を聞き返さない(§16の回帰防止)。

管理者向けの値下げ判断カードを追加(仕入価格・販売開始日時・経過日数を
含む)。この情報は `NegotiationStaffCard` 型に入れてあり、顧客向け
プロンプト組み立て関数はこの型を受け取る口を持たない ——
「渡し忘れ」ではなく構造で漏れないようにしている。

実データでの計算例(B005611):

```
販売予定価格 24,800 / 仕入 10,989 / 販売開始 2026-08-30(経過3日)
7%引き後単価 23,064 / 2点合計 46,128 / 希望総額60,000との差 +13,872
```

### WS-C 送料

- 「東京: データ不足 / 名古屋圏: データ不足 / 大阪圏: ¥9,460」の再現:

  ```
  rank=C: 1ページ=10件 / 実際=50件 / scanned=100 / 続きあり=true
          代表地域: 東京都=false 愛知県=false 大阪府=true
  ```

  450件は欠損なく揃っていた。壊れていたのは読み方だけ。

- 送料ランクを**最大外形3辺**で判定するようにした。実データの寸法欄は
  自由入力で `"座面直径34"` `"脚幅44"` `"75 フットレスト高さ25.5"` の
  ような値が入っている。旧実装は「最初に見つかった数値」を採っており、
  `"座面奥行き43座面高さ44"` のような値では座面寸法を送料判定に使って
  しまう。座面/SH/AH/肘/内寸/3辺合計のラベルが付いた候補を除外し、
  残りの最大値を採る。全部除外されたら小さく見積もらず判定不能を返す。

  固定回帰: W72 × D71 × H81 → 224cm → Cランク。SH45/AH65 を併記しても
  224cm のまま(禁止された W+D+SH=188cm/Bランクには決してならない)。

- 送料込み参考価格カードに計測根拠(判定方法/使用した寸法/3辺合計/
  ランク/使用したInventory項目/**除外した寸法とその理由**)を表示。
- 代表3地域のハードコードでデータの有無を判断しない。登録済みの全50地域を
  展開・検索できるようにした。
- `npm run verify:shipping` 171 / `verify:shipping-live` 9(Staging実データ)

### WS-B 商品説明生成の一本化

EC出品画面の上側と下側で品質が違った理由は文章の巧拙ではなく、
**片方にだけ機能が付いていた**ことだった:

|  | 上側(ecCopy) | 下側(productPage) |
|---|---|---|
| BELLO Style Profile 参照 | 無し | あり |
| 類似BASE商品の参照 | 無し | あり |
| セクション構造(◎見出し) | 無し | あり |
| 紹介文の寸法除外検査 | 無し | あり |
| missing facts の提示 | 無し | あり |
| 生成メタデータの保存 | 無し | あり |

下側を正本にし、`lib/ai/productPage/canonical.ts` を両方から呼ぶ形へ。
チャネル差は生成コアではなく formatter で吸収する。

**下側のUIはまだ削除していない。** 指示書§3が指定する順序のうち、
実機での品質確認が済んでいないため(先に消して生成品質を失うことは
禁止されている)。

紹介文の寸法検査を強化。旧実装は1回書き直させ、**それでも残っていたら
そのまま採用していた**(ループを抜けるだけで判定結果をどこにも反映して
いなかった)。検出 → 書き直し → まだ残る → 寸法を含む文ごと除去 →
それでも駄目なら失敗、という段取りにした。

検出範囲も広げた。旧実装は指示書が挙げた失敗例

```
幅72 × 奥行71 × 高さ81（cm）のサイズで、…
```

のうち「× 奥行71」(×の後にラベルが挟まる)と「81（cm）」(数値と単位の
間に括弧)を**取りこぼしていた**。実データの標準形はこちら。

`npm run verify:intro-validator` 28 assertions

### WS-E メッセージ管理

```
未返信 ｜ 返信済み ｜ すべて ｜ 大原確認 ｜ 市川確認 ｜ 対応済み
```

並びは `CONVERSATION_FILTERS` が正本で、UIはその配列をmapするだけ。
初期表示は「未返信」。「未読」「要返信」「解決済み」は廃止。

返信状態(未返信/返信済み)と業務ステータス(大原確認/市川確認/対応済み)を
別の行に分けた。`sendReplyAction` が `workflowStatus` を "REPLIED" で
上書きしていたのをやめた —— 1つのフィールドに両方を書いていたため
「大原確認中だが未返信」という実在する状態を表現できなくなっていた。

対応済みはサーバー側の取得段階で通常一覧から除外し、タブを押したときだけ
別途取る。対応済みの会話へ新規受信が来たら自動的に解除して未返信へ戻す。
Message も画像も一切削除しない。

会話を開いたときは最新50件だけ読み、「過去のメッセージを読み込む」で続きを取る。
画像の署名付きURLは IntersectionObserver で表示直前まで要求しない
(以前は会話を開いた瞬間に全画像ぶん生成していた)。

### WS-F LINE送信ロック

```
外部LINE → BELLO = 有効
BELLO → 外部LINE = 無効
```

呼び出し側ごとに判定を置くと経路が増えるたびに1つ抜けるので、
**入口ではなく出口**(LINE APIへHTTPリクエストを出す唯一の場所)で止めた。
既定は常に無効で、`LINE_OUTBOUND_ENABLED=true` を明示した場合だけ有効。
`"1"` `"yes"` `"on"` などはすべて無効として扱う。

`globalThis.fetch` を差し替えて**外部HTTPリクエストの本数を数える**検証を
追加。この検証全体を通して `api.line.me` への実リクエストは **0件**。

**今回このフラグは設定していない。実顧客へのLINE送信は0件。**

### WS-G 検索

Golden Test を先に作った。Stagingの実在庫5,313件で24通りの検索
(部分一致/完全一致/前方一致/含まない/空欄/空欄でない/数値範囲/数値以上/
日付範囲/日付以降/AND/OR/記号/空白/英字の大文字小文字/…)について
result IDs / count / order が **projection 適用前後で完全に一致**する
ことを確認(のべ23,773件のヒットで差分ゼロ)。

列挙は人が書かない。一覧の列定義 ∪ 拡張フィールド定義 ∪ 構造上必要な列
の和集合として組み立て、検証スクリプトが2方向から照合する:

- 検索フィールド定義の全項目が projection に含まれているか
- projection の全列が Inventory モデルに実在するか

この照合は実際に2件の欠落を見つけた(`shippingCost` / `displayId`)。

```
全列        8,163KB
projection  5,804KB   (28.9%削減)
うち images 2,516KB → 1,004KB (60.1%削減)
```

images を落としたのではなく、一覧でも検索でも一度も参照されない子
フィールド(sourceUrl / originalHash / sourceSystem / classification)
だけを外した。サムネイルは今までどおり出る。

**往復回数は変わらない。** ページ境界を決めるのは DynamoDB 側の1MB上限で、
そちらは projection より前に効くため。減るのは AppSync→Next.js の
転送量とシリアライズ量。

custom type の配列の子フィールドを selectionSet で選ぶ書き方が、この
Amplify のバージョンで受け付けられるかどうかはブラウザのCognito
セッション無しでは実機確認できなかった。受け付けられなければクエリ全体が
落ちる = 在庫一覧が丸ごと出なくなるので、1回だけ試して駄目なら全列取得へ
自動で戻すようにした(戻ったことは警告として残す)。

### WS-D 画像加工

worker 側の pending 取得(以前修正した箇所)は再発していない。
Staging実測: ProcessingJob 57件すべて DONE、PENDING 0件。

画面側の3箇所に同じ読み方が残っていたので塞いだ(上記§0の表)。
現在の件数(57件)は既定100件未満なので今日はまだ動くが、増えてから
静かに壊れる形だった。

---

## 2. 未了・保留

| 項目 | 状態 | 理由 |
|---|---|---|
| ブラウザでの Staging E2E 全般 | **BLOCKED_BY_USER_AUTH** | Cognitoユーザーは1名のみで、そのパスワードが必要。新規admin作成・グループ追加は認可境界を広げる変更なので行わない |
| EC出品画面の Server Components render error | **未再現** | Amplify Hosting の SSRログをCloudWatchへ出す設定が無く、この環境にSSRのロググループ自体が存在しない(全ロググループを列挙して確認)。digest はブラウザからしか取れない |
| 下側「BASE商品ページの下書き」UIの削除 | **保留** | 指示書§3の順序に従い、上側の品質を実機で確認してから |
| ZAICO全件同期(5,313件への遡及反映) | **未実行** | 規模が大きく、B005610 の手入力値(28000)を上書きする判断を伴うため利用者の判断に委ねる |
| 売上集計の read model 化 | **未着手** | 時間切れ。設計方針は前回の記録(`night-work-20260902.md` §3)のまま有効 |
| 設定 ＞ 商品説明文 の管理画面 | **未着手** | 時間切れ。生成側の一本化(canonical.ts)は完了しているので、設定画面はその上に載せる形になる |
| `/admin` の認可不一致 | **調査のみ**(下記) | 認可境界を広げる変更は行わない |

### `/admin` 認可不一致の調査結果

| 項目 | 実測 |
|---|---|
| `/admin/*` が要求するグループ | `Admins` |
| `/inventory/*` が要求するグループ | `ADMIN` / `EDITOR` / `VIEWER` |
| ユーザープールに存在するグループ | `ADMIN` / `EDITOR` / `VIEWER` / `Admins`(4つとも実在) |
| 利用者(1名)の所属グループ | `ADMIN` のみ |

`Admins` は typo ではなく、**意図的に別体系**として作られている
(`amplify/auth/resource.ts` と `lib/amplify/requireInventoryUser.ts` の
コメントが、特集ページ機能とInventory機能で無関係なグループを使い、
それぞれ独立に発展させる設計だと明記している)。

さらに同じコメントは、**設計時に想定していた対処**まで書いている:

> A person who needs both systems is simply added to both groups —
> e.g. an existing Feature admin who also runs Inventory gets "Admins" + "ADMIN".

つまり「両方使う人は両方のグループに入れる」が最初からの想定。
`/admin` の門を `ADMIN` でも通す案は設計意図に反する —— Inventory の
EDITOR / VIEWER まで特集ページの管理者になりかねないため。

推奨は **利用者を `Admins` グループへ追加する** こと。ただしこれは
認可対象を広げる操作なので、承認なしには実施しない。実行するなら:

```
aws cognito-idp admin-add-user-to-group \
  --user-pool-id us-west-2_lQznp4G4t \
  --username 78f16330-e091-7083-83cb-5841bcfbae50 \
  --group-name Admins --region us-west-2
```

特集ページ機能を使う予定が無いなら、そのまま閉じておくのが安全。

---

## 3. テスト結果

| コマンド | 結果 |
|---|---|
| `npm run typecheck` | 通過 |
| `npm run lint` | 通過(警告0) |
| `npm run build` | 通過 |
| `verify:inquiry` | 230 passed |
| `verify:shipping` | 171 passed |
| `verify:product-intro` | 167 passed |
| `verify:listing` | 112 passed |
| `verify:negotiation` | 103 passed |
| `verify:image-processing` | 97 passed |
| `verify:zaico` | 80 passed |
| `verify:messaging` | 63 passed |
| `verify:knowledge` | 58 passed |
| `verify:line` | 46 passed |
| `verify:image-pipeline` | 46 passed |
| `verify:zaico-mapping` | 45 passed |
| `verify:base` | 30 passed |
| `verify:intro-validator` | 28 passed |
| `verify:search-projection` | 31 passed(Staging実データ) |
| `verify:negotiation-case` | 21 passed(Staging実データ) |
| `verify:shipping-live` | 9 passed(Staging実データ) |

失敗 0。

---

## 4. 安全条件の確認

- main / Production: **一切変更していない**(作業はすべて Staging ブランチ)
- Production IAM / secrets: 変更していない
- 新規 admin 作成・Cognitoグループ変更・IAM拡大: 行っていない
- 実顧客への LINE 送信: **0件**(検証も含め `api.line.me` への
  実リクエスト0件を機械的に確認)
- ShippingRate 450件: 読み取りのみ。削除・二重登録なし
- 画像の原本: 削除していない
- Inventory への書き込み: B005611 の1件のみ(ZAICOマッピング修正の
  実データ検証。人が入力した値は1つも上書きしていない)
