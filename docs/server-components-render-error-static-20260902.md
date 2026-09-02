# EC出品画面の Server Components render error — 静的追跡

2026-09-02 / ブラウザ実測なしで、コード・実データ・AWS設定から絞り込めるところまで。

対象: `/inventory/[id]/listing`（`app/inventory/(protected)/[id]/listing/page.tsx`）

---

## 1. 確定事項

根拠を実際に見たもの。推測は含めない。

### 1-1. この画面のサーバ描画で例外になりうる経路は、Amplifyのデータ取得だけ

`page.tsx` のサーバ側でawaitしているのは5つ。それぞれ順に潰した。

| 呼び出し | 投げうるか | 根拠 |
|---|---|---|
| `getInventoryRole()` | **投げない** | `getInventorySessionStatus` は全体が `try/catch` で、失敗は `signed-out` になる |
| `getInventoryDetail()` | **投げうる** | `Inventory.get` と履歴のGSI Query。下記1-2 |
| `getListingDraftForInventory()` | **投げうる** | 同上 |
| `getChannelListing()` | **投げうる** | 同上 |
| `isMercariConnected()` | **投げない** | `readMercariConnectionSecret` が `ResourceNotFoundException` を「未設定」として扱い、他の失敗も `classifyAwsError` で戻り値に畳む。Secrets Managerの失敗はここから漏れない |

描画側も潰した。

- `splitImagesByType` / `resolveTopImage` — `getInventoryDetail` が `normalizedImages` で
  `(item.images ?? []).filter(Boolean)` を通すので、`null` が渡ることはない。
- `parseCustomFields` — `JSON.parse` は `try/catch` 済みで、壊れていれば `null` を返す。
- `ProductPageSection` — `"use client"`。サーバ描画では例外にならない。

### 1-2. Amplifyは「GraphQL以外のエラー」を投げる

`@aws-amplify/data-schema` の実装を読んだ（`runtime/internals/operations/utils.js`）。

```js
function handleListGraphQlError(error) {
  if (error?.errors) {
    return { ...error, data: [] };   // GraphQLエラー → 空配列。投げない
  } else {
    throw error;                     // それ以外 → 投げる
  }
}
```

つまり**ネットワーク断・認証情報の失効・タイムアウト・SDK内部エラーは、
どのデータ取得からもそのまま例外として上がってくる**。この画面には
try/catchが無いので、そのまま Server Components render error になる。

逆に、AppSync側の認可拒否やindex不在（=GraphQLエラー）では**投げない**。
これは重要で、下の「除外できたもの」につながる。

### 1-3. この画面が使うGSIはすべて存在し ACTIVE

「indexが無くてGraphQLエラー」の線を実データで潰した。

```
ListingDraft    listingDraftsByInventoryId       ACTIVE
ChannelListing  channelListingsByInventoryId     ACTIVE
                channelListingsByListingDraftId  ACTIVE
Inventory       inventoriesByCategoryId          ACTIVE
                inventoriesByLocationId          ACTIVE
                inventoriesBySku / ByStatusId / ByDeletedAt / ByListingPartition… すべて ACTIVE
```

### 1-4. digest はいまのところ**何にも解決できない**

`app/inventory/error.tsx` も `app/global-error.tsx` も `error.digest` を
「参照番号」として画面に出している。ここは既に正しい。

問題はその先。digestは元のエラーメッセージのハッシュで、対応する実物は
Next.jsがサーバのstderrへ書く。**そのstderrがどこにも残っていない。**

```
アカウント 203918843421 / us-west-2 のロググループ … 全22個
  内訳: バックエンドLambda(デプロイ補助 + 稼働中の4ワーカー)のみ
  /aws/amplify/* … 存在しない
```

ただし**IAM権限は足りている**。

```
BelloAmplifyStagingComputeRole
  └ BelloComputeRuntimeAccess
      └ Sid: BelloSsrComputeLogs
          logs:CreateLogGroup / CreateLogStream / PutLogEvents /
          DescribeLogGroups / DescribeLogStreams
          Resource: arn:aws:logs:us-west-2:203918843421:log-group:/aws/amplify/*
```

そしてこのロールは実際に使われている（`RoleLastUsed` = 2026-09-02 13:23 JST）。
アプリは `platform: WEB_COMPUTE`、直近のデプロイも成功している。

**権限があり、ロールも使われているのに、ロググループが一度も作られていない。**
ロググループは初回の出力時に作られるので、これは「この経路でまだ一度も
出力されていない」ことを意味する。つまり——

> 報告された例外は、**現在のデプロイでは発生していない**か、
> 発生してもSSRログ配信が有効になっていないか、どちらか。
> CLIからはAmplify HostingのSSRログ設定を読めないので、ここは切り分けられない。

---

## 2. 有力候補

確定ではない。1-1で残ったのは1本だけなので、素直に絞れる。

### 候補A: データ取得中の非GraphQLエラー（最有力）

1-2のとおり、ネットワーク断・認証情報の失効・タイムアウトはそのまま投げる。
`getInventoryDetail` / `getListingDraftForInventory` / `getChannelListing` の
どれで起きても同じ見え方になる。

この画面が他より当たりやすい理由がある: **サーバ側の取得が4本と、この
アプリで最多クラス**（在庫本体＋履歴＋下書き＋チャネル出品）。1本あたりの
失敗確率が同じでも、当たる確率は本数に比例する。

再現しにくい・特定の商品でだけ起きる、という報告のされ方とも整合する。

### 候補B: 一覧から渡ってきた `params.id` が実在しない

`getInventoryDetail` が `null` を返すと `notFound()` で404になる（例外ではない）ので、
これ単体では該当しない。ただし削除済み商品への遷移が絡む経路は、
ブラウザで踏んでみないと分からない。

### 除外できたもの

- Secrets Manager（Mercari接続確認）— 1-1
- 画像配列の `null` — 1-1
- `customFields` のJSON破損 — 1-1
- GSIの不在による GraphQLエラー — 1-2 と 1-3（そもそも投げないし、indexもある）
- クライアントコンポーネントの初期化 — サーバ描画の外

---

## 3. ブラウザで取得すべき証拠

優先順。上から順に、1つ取れるごとに候補が減る。

1. **画面に出ている「参照番号」（digest）**
   同じ商品で再現するか、商品を変えると変わるかも合わせて。digestは
   メッセージのハッシュなので、**値が同じなら同じ例外**と断定できる。

2. **再現した直後に `/aws/amplify/d4hkkg7dty2du` が作られているか**
   ```
   aws logs describe-log-groups --profile Bello --region us-west-2 \
     --log-group-name-prefix /aws/amplify
   ```
   作られていれば1-4の「まだ出力されていない」が確定し、中身から
   例外の実物が読める。作られなければ、SSRログ配信そのものが
   有効になっていない（Amplify Console側の設定）。

3. **どの商品で起きるか（1件でも特定できれば大きい）**
   その `inventoryId` で `getInventoryDetail` / 下書き / チャネル出品を
   個別に叩けば、4本のどれが落ちているかを切り分けられる。

4. **ブラウザのNetworkタブで、そのページのHTTPステータスと所要時間**
   タイムアウト由来なら時間に出る。

5. **他の画面でも起きるか**
   在庫詳細（取得3本）でも起きるなら候補Aがほぼ確定する。
   EC出品だけなら、下書き/チャネル出品の2本に絞れる。

---

## 4. 今回の変更が、この追跡に与える影響

同じ日の別の修正（`fix(amplify): 取得の失敗が「0件」に化けて…`）で、
`getListingDraftForInventory` と `getChannelListing` は**GraphQLエラーのとき
投げるようになった**。それまでは空を返して「下書きなし」と表示していた。

これは意図した変更（0件と誤認すると2件目の下書きができるため）だが、
追跡の観点でも意味がある:

> もしこの変更のあと、EC出品画面のエラーが**増えた**なら、それは
> 「これらのクエリがずっと失敗していて、今まで空表示に化けていた」
> ことの証拠になる。エラーメッセージに何の取得に失敗したかが入るので、
> digestを待たずに読める。
>
> 変わらないなら、候補Aの非GraphQLエラー側が残る。

どちらに転んでも情報が増える。

---

## 5. いま手を入れなかったこと

- **推測での try/catch 追加はしない。** 例外を握り潰すと、digestすら
  出なくなって追跡が今より難しくなる。
- **Amplify Console のSSRログ設定は変更しない。** 絶対条件（設定・認可
  境界を変更しない）に触れる。有効化が必要なら承認を得てから。
