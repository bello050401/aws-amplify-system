# EC出品のアダプタ化 — 現状の監査と設計提案

2026-09-02 / **本格的なアダプタ化は未実施。境界整理とテストのみ実施済み。**

## この文書の現況（2026-09-02 追記）

外部EC連携ハブの候補が Next Engine / JUNGLE / 各モール直接API と複数あり、
**どれを採用するかが未確定**。特定のハブに依存した実装は行わない方針。

実施済み:

- 出品のBELLO側手順を `lib/listing/publishFlow.ts` へ純粋関数として抽出
  （挙動は変えていない。出品先ごとの違いは `PublishRoute` に明示）
- 状態遷移を固定するテスト 47件（`npm run verify:publish-flow`）

未実施（承認待ち）:

- アダプタ interface の定義と `listOnChannel` への統合（§3）

§4 の「テストが薄いのでリファクタの前にテストが要る」は解消した。
残る保留理由は「ハブが決まっていない」の1点。

---

## 1. いま何が重複しているか

`lib/listing/service.ts` の `listOnMercari`（80行）と `listOnBase`（54行）は、
コメントと空行を除くと**骨格がほぼ同一**。実際に差分を取ると、意味のある違いは
次の5点しかない。

| # | 違い | 中身 |
|---|---|---|
| 1 | チャネル名 | `"MERCARI_SHOPS"` / `"BASE"` |
| 2 | 未設定時の文言 | 「先にMercariのカテゴリー設定を…」/「先にBASEのチャネル設定を…」 |
| 3 | アダプタ呼び出し | 入力の形が違う（下記 §2） |
| 4 | 成功時に書く列 | Mercariは `listingUrl: null` も書く（BASEはキー自体を送らない） |
| 5 | catchのエラー型 | 見た目は違うが**実際には同じ**（下記 §5-d） |

残りは全部同じ手順を踏んでいる。

```
1. 在庫と下書きを読む
2. カテゴリーがEC出品可能か判定
3. ChannelListing.status を PUBLISHING にする
4. 外部APIを呼ぶ
5. 成功  → ACTIVE / externalListingId / firstListedAt / lastListedAt / lastError クリア
   失敗  → ERROR / lastError にメッセージ
```

3チャネル目（ヤフオク・楽天・自社EC等）を足すとき、この50行を**もう一度
書き写す**ことになる。書き写しは同じ量のバグを書き写すという意味でもある。
実際いまも `listingUrl: null` に `[UNVERIFIED]` のコメントが付いたまま
Mercari側にだけ残っていて、BASE側には無い。

---

## 2. アダプタの現状

| | Mercari | BASE |
|---|---|---|
| 入力 | `draft` / `channelListing` / `shippingPayer` / `inventoryQuantity` | `draft` / `overrideTitle` / `overrideDescription` / `overridePrice` / `quantity` |
| 出力 | `externalProductId` / `externalStatus`（※後者は**保存されていない**） | `externalProductId` |
| 上書き値の解決 | `channelListing` を丸ごと渡し、**アダプタの中で**解決 | 呼び出し元が展開して渡す |
| エラー型 | `MercariApiError` | `BaseListingApiError` |

**同じことを2通りのやり方でやっている。** とくに上書き値（タイトル・説明・
価格）の解決場所が違うのが効いていて、「どこで上書きが効くのか」を追うのに
毎回2箇所を読むことになる。

---

## 3. 提案する形

BELLOを単一の真実の情報源に保ったまま、チャネルを差し替え可能にする。

```ts
/** 出品先1つぶんの実装。チャネルを足すときはこれだけ書く。 */
export interface ListingChannelAdapter {
  /** ChannelListing.channel に入る値。 */
  readonly channel: ListingChannel;
  /** 画面に出す名前（エラー文言の組み立てに使う）。 */
  readonly displayName: string;

  /**
   * 出品する。BELLO側の状態遷移はこの関数の外で共通に行うので、
   * ここは「外部APIを呼んで結果を返す」ことだけに責任を持つ。
   */
  publish(input: ListingPublishInput): Promise<ListingPublishResult>;

  /** このチャネル固有の例外から、利用者向けの文言を取り出す。 */
  describeError(err: unknown): string | null;
}

/** どのチャネルにも同じものを渡す。チャネル固有の値は options に閉じる。 */
export interface ListingPublishInput {
  draft: ListingDraftRecord;
  channelListing: ChannelListingRecord;
  /** 出品実行の直前に読み直した在庫数量（下書きの値をコピーして古くしない）。 */
  inventoryQuantity: number;
  /** チャネル固有の追加入力（Mercariの shippingPayer 等）。 */
  options: Record<string, unknown>;
}

export interface ListingPublishResult {
  externalProductId: string;
  /** 外部側の状態。取れないチャネルは null。 */
  externalStatus?: string | null;
  /** 商品ページのURL。応答に含まれないチャネルは null。 */
  listingUrl?: string | null;
}
```

呼び出し側は1本になる。

```ts
async function listOnChannel(
  adapter: ListingChannelAdapter,
  inventoryId: string,
  who: string | null,
  options: Record<string, unknown> = {},
): Promise<ChannelListingRecord> {
  // 上の 1〜5 の手順。いまの2つの関数から、違いを adapter に寄せて抜き出すだけ。
}

export const listOnMercari = (inventoryId, shippingPayer, who) =>
  listOnChannel(mercariAdapter, inventoryId, who, { shippingPayer });

export const listOnBase = (inventoryId, who) =>
  listOnChannel(baseAdapter, inventoryId, who);
```

既存の公開関数の名前と引数は変えない。呼び出し元（Server Action・画面）は
1行も直さずに済む。

### 上書き値の解決は1箇所へ

`overrideTitle` / `overrideDescription` / `overridePrice` の解決規則
（「上書きがあればそれ、無ければ下書きの値」）は、いまMercariとBASEで
別々の場所にある。共通の1関数へ寄せる。ここがずれると、片方のチャネルだけ
上書きが効かないという分かりにくい不具合になる。

---

## 4. なぜ今回は実装しなかったか

判断材料が足りない。3点ある。

1. **書き込み経路であること。** ここは外部ECへ実際に商品を作る。取り違えると
   「二重出品」「出品したのにBELLO側がFAILEDのまま」といった、こちら側では
   取り消せない結果になる。

2. **この経路のテストが薄い。** `verify:listing` の112 assertionsは
   `ecEligibility` と `pricing` の純粋関数が中心で、`listOnMercari` /
   `listOnBase` の状態遷移そのものは覆っていない。**リファクタの前に、
   いまの振る舞いを固定するテストが要る。** 順序が逆だと、変えた結果
   何かが変わっても気づけない。

3. **報告されている `/inventory/[id]/listing` の Server Components render
   error が未解決。** 同じ画面まわりを同時に動かすと、症状が消えたのか
   隠れたのかが分からなくなる（`docs/server-components-render-error-static-20260902.md`）。

### 進めるなら、この順

```
1. いまの listOnMercari / listOnBase の状態遷移を固定するテストを書く
   （ChannelListing の status が PUBLISHING → ACTIVE / ERROR と動くこと、
     失敗時に lastError が入ること、成功時に lastError が消えること、
     二重出品を弾くこと）
   ← **実施済み**（verify:publish-flow 47件）

2. アダプタ interface を定義し、既存2つをその形に合わせる（中身は移すだけ）

3. listOnChannel を1本にする

4. 3チャネル目を足すときに、初めて効果が出る
```

**1だけ先にやることを勧める。** リファクタするかどうかに関わらず価値があり、
やらない場合の損もない。ご指示があれば着手する。

---

## 5. 調査結果 — listingUrl と上書き値の一元化（ご指示③）

「安全に一元化できるなら実施、挙動変更を伴うなら報告のみ」という指示に対する回答。

### (a) 上書き価格の扱いが違い、**Mercariは0円で出品されうる** — High・要判断

同じ「上書き値の解決」が2箇所にあり、**規則が違う**。

| | Mercari (`resolveEffectiveListingFields`) | BASE（`base/adapter.ts` 内で直接） |
|---|---|---|
| タイトル | `override ?? draft.title` | `override?.trim() \|\| draft.title` |
| 説明 | `override ?? draft.description ?? ""` | `override?.trim() \|\| draft.description \|\| ""` |
| 価格 | `override ?? draft.price ?? **0**` | `override ?? draft.price` → **null なら例外** |

価格の違いが効く。

- `ListingDraft.price` は `a.integer()` で**必須ではない**
- `saveListingDraft` はタイトルの空欄は弾くが、**価格は検証していない**
- BASE は `if (price == null \|\| price <= 0) throw`（「価格が未設定です。」）で止まる
- Mercari は `?? 0` で埋め、**価格ガードが無い**まま `createProduct` へ渡す

つまり価格未設定の下書きから出品すると、BASEは止まり、**Mercariには0円で
出品リクエストが飛ぶ**。Mercari側APIが弾く可能性はあるが、BELLOは止めていない。

**実装しなかった。** 一元化はどちらかの挙動を変えることになり、
「挙動変更を伴う場合は報告」というご指示に該当するため。

対処案（どれも承認が要る）:

1. `saveListingDraft` で価格を必須にする（入口で止める。影響範囲が最小）
2. Mercariアダプタにも BASE と同じ価格ガードを足す（出口で止める）
3. `resolveEffectiveListingFields` を両者共通にする（規則を1つにする）

**1と2の併用を勧める。** 3は規則の統一という点で正しいが、
`?? ` と `?.trim() ||` の違い（空文字・空白のみの扱い）も同時に変わるので、
先に1・2で危険を止めてから落ち着いて行うほうがよい。

### (b) listingUrl の扱いが違う — Low・一元化は挙動変更を伴う

- Mercari: 成功時に `listingUrl: null` を送り、**既存値を明示的に消す**
- BASE: キー自体を送らないので、**既存値がそのまま残る**

`[UNVERIFIED]` コメントのとおり、Mercariの `createProduct` 応答に
listingUrl 相当が含まれるかは未確認。BASE側も同様に未確認。

現在 `listingUrl` に非nullを書き込む経路は**コード上に1つも無い**
（読む側は `lib/inquiry/` の商品特定と一覧のリンク表示のみ）。
つまり実データ上は常に null で、この違いは現時点で表面化しない。

**実装しなかった。** どちらに揃えても片方の挙動が変わるため。
違いは `PublishRoute.clearsListingUrlOnPublish` として**消さずに明示**した ——
応答仕様が確認できた時点で、1箇所を直せば揃う形にしてある。

### (c) 上書き値の解決場所が2箇所 — Low・(a)と同じ判断

Mercariはアダプタ内、BASEは呼び出し元。「どこで上書きが効くのか」を追うのに
毎回2箇所を読むことになる。(a) の対処と同時に行うのが自然。

### (d) catch のエラー型は、もともと分岐していなかった — 解消済み

```ts
err instanceof MercariApiError ? err.message
  : err instanceof Error ? err.message : "不明なエラー"
```

前2つは同じ値を返すので、実質「Errorならmessage」でしかない。
チャネル固有の分岐は最初から存在しなかった。`describePublishFailure` に
1つへ畳んだ（挙動不変。等価性はテストで固定）。結果として service.ts から
`MercariApiError` / `BaseListingApiError` の import が不要になった。

### (e) fetchAllChannelListings が実質フルスキャン — Low・未対処

`channel` はindex化されていないため `filter` 付き `list`。
`limit: 200` とページ送りがあるので取りこぼしはしない。
現在 `ChannelListing` は0件なので影響なし。
