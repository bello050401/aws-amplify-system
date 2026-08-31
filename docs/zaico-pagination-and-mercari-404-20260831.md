# ZAICO全件同期と Mercari 404 の調査（2026-08-31）

AWS認証が切れている間に、AWSを必要としない範囲で実施した調査と実装の記録。

---

## 1. ZAICO「1,000件上限」の根本原因

### 結論: 同期経路に件数の固定上限は存在しない

仕様書が挙げた語（`1000` / `limit` / `page` / `per_page` / `pageSize` /
`maxPages` / `maxItems` / `take` / `slice` / `NextToken`）でリポジトリ全体を
走査した。同期に関わる箇所で件数を打ち切っているものは無く、
リテラル `1000` は**コメント2箇所のみ**だった。

3つの同期経路はいずれも同じ契約で動く。

```
listInventories(page, perPage) → { items, hasMore }
hasMore = items.length === perPage
```

| 経路 | ループ | 上限 |
|---|---|---|
| `lib/inventory/zaicoSync.ts` `syncAllZaicoItems` | `for(;;)` で `hasMore` が偽になるまで | 無し |
| `lib/inventory/zaicoBackgroundSync.ts` | 1回の呼び出しで1ページ、チェックポイントで継続 | 無し |
| `amplify/functions/zaico-sync-worker/handler.ts` | 同上（Lambda、lease + 時間予算） | 無し |

したがって、実測で1,000件だったのは **ZAICOアカウントの実在庫数が
その時点で1,000件だった**可能性が高い。確定にはZAICO APIへ実際に
21ページ目以降を要求する必要があり、それはSecrets Managerのトークンが
要るためAWS復旧後に行う。

### 上限は無かったが、足りていなかったもの

仕様 §3.3 / §3.6 が同時に要求している安全装置が無かった。

- 無限ページ取得の防止（APIが満杯ページを返し続けたら止まらない）
- 同じページを繰り返し取得していることの検知
- 取得ページ数の計測

`lib/zaico/pagination.ts` としてページ反復を切り出し、この3つを持たせた。
**件数の上限としては機能しない**設計にしてある。

- ページ上限は既定4,000ページ（`perPage` 50 なら20万件相当）
- 到達した場合は正常終了ではなく `PAGE_LIMIT` を返し、`completed: false` とする
- `perPage` を上げれば同じページ上限でより多くの件数を扱える
  （テストで perPage=500 / maxPages=30 で12,000件を確認）
- ページを配列へ溜め込まず `onPage` で逐次処理する

### テスト（`npm run verify:zaico-pagination`、72件）

実装と同じページング契約を持つ疑似APIを用意し、`paginateAll` をそのまま通す。

| 観点 | 内容 |
|---|---|
| 件数 | 0 / 1 / 49 / 50 / 51 / **999 / 1,000 / 1,001 / 2,000 / 5,000** で件数・重複・欠落を検証 |
| 端数の最終ページ | 1,001件 → 21ページ目で1件、`LAST_PAGE` |
| 割り切れる場合 | 1,000件 → 20ページ処理後、空ページで `EMPTY_PAGE` |
| 件数上限でないこと | perPage=500 / maxPages=30 で12,000件を取得 |
| 暴走防止 | 常に満杯を返すAPIで `PAGE_LIMIT`・`completed:false`・説明文に「件数の上限ではなく」 |
| 重複ページ | 同じ内容が返り続けたら1ページ分で停止（同じデータを何度も処理しない） |
| 中断 | `shouldAbort` で停止し、その時点のページ数を返す |
| 一時障害 | リトライ上限到達はそのまま呼び出し側へ伝え、失敗ページより前だけが処理済み |
| retry成功 | クライアント層のretryを挟んで300件すべて取得 |
| 中断再実行 | 2回目も全件取得でき、和集合に欠落なし（べき等） |
| full resync | 2回流して取得件数・ページ数・順序が同一（決定論的） |
| 新規1件 | 総件数が1件だけ増え、端数ページが1つ増えるだけ |

**実ZAICOで1,001件以上を確認したわけではない。** 上記は自動テストによる
証明であり、実環境での確認とは分けて報告する（仕様 §3.8）。

---

## 2. Mercari Shops API の HTTP 404

### 実測（トークンを一切使用しない）

`api.mercari-shops.com` および `api.mercari-shops-sandbox.com` へ、
認証ヘッダを付けずに要求した結果。

| 要求 | 結果 |
|---|---|
| POST `/v1/graphql`（sandbox） | `404` / `text/plain` / `Not Found` / `Server: cloudflare` |
| POST `/v1/graphql`（production） | 同上 |
| GET `/` | 404 `text/plain` |
| GET `/v1/graphql` | 404 `text/plain` |
| GET `/graphql` | 404 `text/plain` |
| GET `/v1` | 404 `text/plain` |
| GET `/healthz` | 404 `text/plain` |
| GET 存在しないパス | 404 `text/plain` |

**すべてのパスが同一の応答**を返す。

### これで除外できたもの

- **自社Next.jsの404ではない** — 応答は Cloudflare から返っており、
  `Content-Type: text/plain` の "Not Found" で、GraphQLのエラーJSONですらない
- **トークンの問題ではない** — トークンを一切送っていない状態で同じ404
- **メソッド誤りではない** — GET / POST どちらも同じ
- **パス誤りではない** — `/` を含む全パスが同一応答
- **sandbox / production の取り違えでもない** — 両方が同じ挙動

つまり404は **Mercari側のエッジが、この送信元に対して
アプリケーション層へ到達させていない**状態である。

### 確定していないこと

「IPが未登録であること」自体は**我々の側から確認できない**。
Mercari側の登録状況を参照する手段が無いためである。
公式ドキュメントに「未登録のIPからの要求は404を返す」という記述があり、
実測はそれと矛盾しないが、**断定はしない**。

利用者向け文言は「未登録の**可能性があります**」のままとし、
断定的な表現へ戻らないよう `scripts/verify-listing.ts` にテストを追加した。

### 残っていること

Stagingの実際の送信元グローバルIPの特定にはAWSが要る。
上記の実測は開発マシンからのものであり、Stagingの送信元とは別である。
AWS復旧後に、Staging SSRコンピュートからの送信元IPを実測する。
EIP / NAT Gateway 等の構成変更は、必要性が確定するまで行わない（継続課金が
発生するため、承認前提）。
