# EC出品のアダプタ化 — 現状の監査と設計提案

2026-09-02 / **提案のみ。コードは変更していない。**

ご指示のとおり、安全に取り出せるものだけを取り出し、それ以外は提案に留める
方針。今回は「取り出す」側に倒せる根拠が足りないと判断したので、全体を提案
として書く。理由は §4。

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
| 4 | 成功時に書く列 | Mercariは `externalStatus` と `listingUrl: null` も書く |
| 5 | catchのエラー型 | `MercariApiError` / `BaseListingApiError` |

残りは全部同じ手順を踏んでいる。

```
1. 在庫と下書きを読む
2. カテゴリーがEC出品可能か判定
3. ChannelListing.status を PUBLISHING にする
4. 外部APIを呼ぶ
5. 成功  → ACTIVE / externalListingId / firstListedAt / lastListedAt / lastError クリア
   失敗  → FAILED / lastError にメッセージ
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
| 出力 | `externalProductId` / `externalStatus` | `externalProductId` |
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
   （ChannelListing の status が PUBLISHING → ACTIVE / FAILED と動くこと、
     失敗時に lastError が入ること、成功時に lastError が消えること、
     二重出品を弾くこと）
   ← ここまでは振る舞いを一切変えないので、承認なしで進められる

2. アダプタ interface を定義し、既存2つをその形に合わせる（中身は移すだけ）

3. listOnChannel を1本にする

4. 3チャネル目を足すときに、初めて効果が出る
```

**1だけ先にやることを勧める。** リファクタするかどうかに関わらず価値があり、
やらない場合の損もない。ご指示があれば着手する。

---

## 5. 今回この監査で見つけた、設計とは別の小さな問題

| 内容 | 場所 | 重さ |
|---|---|---|
| `listingUrl: null` の `[UNVERIFIED]` コメントがMercari側だけに残り、BASE側には同等の記述が無い。BASEの応答にURLが含まれるかも未確認のまま | `service.ts` | Low |
| 上書き値の解決規則が2箇所にある（Mercariはアダプタ内、BASEは呼び出し元） | `mercari/adapter.ts` / `service.ts` | Low |
| `fetchAllChannelListings` が `filter` 付き `list` を使っている。`limit: 200` とページ送りがあるので取りこぼしはしないが、`channel` はindex化されていないため実質フルスキャン。現在 `ChannelListing` は0件なので影響なし | `service.ts` | Low |

いずれも今回は直していない。単独で直すと差分がこの設計提案と混ざって、
どちらの判断だったのか後から読めなくなるため。
