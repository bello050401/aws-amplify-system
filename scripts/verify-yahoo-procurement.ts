import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYahooPurchaseMail,
  isYahooPurchaseNotice,
  consolidateYahooPurchases,
  allocateYen,
  yahooPurchaseId,
  yahooPurchaseQuery,
} from "../lib/procurement/yahoo";
import {
  parseYahooPublicItem,
  parseYahooStore,
  validYahooImage,
  validYahooStore,
} from "../lib/procurement/yahooPublic";
import { gmailResponseError } from "../lib/saleCandidates/mailReader";
import { parsePurchaseMail } from "../lib/saleCandidates/mailParser";
import { mergeYahooNotification } from "../lib/saleCandidates/yahooMail";
const won = {
  gmailId: "a",
  from: "auction-master@mail.yahoo.co.jp",
  subject: "Yahoo!オークション - 落札者：椅子(a1234567890)",
  receivedAt: "2026-10-15T01:00:00Z",
  text: "商品「椅子」を落札しました。\n商品：椅子\nオークションID：a1234567890\n終了日時：10月 15日 10時 00分\n落札数量：4\n落札単価：8,000 円\n落札合計（税込）：35,200 円\nhttps://buy.auctions.yahoo.co.jp/order/status?auctionId=a1234567890",
};
const order = {
  ...won,
  gmailId: "b",
  subject: "【Yahoo!オークション】ご購入の確認：a1234567890 他 1 件",
  receivedAt: "2026-10-16T01:00:00Z",
  text: "注文ID　：store-1\n購入日時：2026年10月16日10時00分00秒\nオークションID：a1234567890\n商品情報：椅子\n8,800円×4＝35,200円\nオークションID：b1234567890\n商品情報：机\n13,200円×1＝13,200円\n商品の合計金額 ： 48,400円\n送料：101円\n合計金額：48,501円",
};
test("buyer template separates tax, quantity and seller notifications", () => {
  assert(isYahooPurchaseNotice(won.subject));
  assert(!isYahooPurchaseNotice('Yahoo!オークション - 終了（落札者あり）：売れた商品(a1234567890)'));
  const e = parseYahooPurchaseMail(won)!;
  assert.equal(e.lots[0].quantity, 4);
  assert.equal(e.lots[0].itemTotal, 35200);
  assert.equal(e.lots[0].shipping, null);
  assert.equal(e.lots[0].store, true);
  assert.equal(parsePurchaseMail(won).length, 0);
  assert.equal(
    parseYahooPurchaseMail({ ...won, from: "evil@example.org" }),
    null,
  );
});
test("purchase confirmation allocates order shipping exactly once", () => {
  const e = parseYahooPurchaseMail(order)!;
  assert.equal(e.lots.length, 2);
  assert.equal(
    e.lots.reduce((n, l) => n + l.shipping!, 0),
    101,
  );
  assert.equal(e.lots[0].quantity, 4);
  assert.equal(e.lots[1].itemTotal, 13200);
});
test("duplicate messages converge on auction ID, not shared titles", () => {
  const a = parseYahooPurchaseMail(won)!,
    b = parseYahooPurchaseMail(order)!;
  const l = consolidateYahooPurchases([b, a, a, b], "2026-10-15", "2026-10-28");
  assert.equal(l.length, 2);
  assert.equal(l[0].date, "2026-10-15");
  assert.equal(
    yahooPurchaseId(l[0].auctionId),
    yahooPurchaseId(l[0].auctionId),
  );
  assert.notEqual(
    yahooPurchaseId(l[0].auctionId),
    yahooPurchaseId(l[1].auctionId),
  );
});
test("late amount change invalidates all shared order allocations", () => {
  const c = parseYahooPurchaseMail({
    ...order,
    subject: "【Yahoo!オークション】購入内容の変更（a1234567890 他 1 件）",
    receivedAt: "2026-10-17T00:00:00Z",
  })!;
  const l = consolidateYahooPurchases(
    [parseYahooPurchaseMail(order)!, c],
    "2026-10-15",
    "2026-10-28",
  );
  assert(l.every((l) => l.changed && l.shipping === null));
});
test("15th boundary and integer allocation", () => {
  assert.equal(
    consolidateYahooPurchases(
      [parseYahooPurchaseMail(won)!],
      "2026-10-16",
      "2026-10-28",
    ).length,
    0,
  );
  assert.deepEqual(allocateYen(1, [1, 1, 1]), [1, 0, 0]);
  const q = yahooPurchaseQuery("2026-10-15", "2026-10-28");
  assert(
    q.includes("after:" + (Date.parse("2026-10-15T00:00:00+09:00") / 1000 - 1)),
  );
  assert(
    q.includes("before:" + Date.parse("2026-10-29T00:00:00+09:00") / 1000),
  );
  assert.throws(() => yahooPurchaseQuery("2026-10-30", "2026-10-15"));
});
test("inconsistent or partial order is not silently registered", () => {
  assert.equal(
    parseYahooPurchaseMail({
      ...order,
      text: order.text.replace("48,400円", "99,999円"),
    }),
    null,
  );
  assert.equal(
    parseYahooPurchaseMail({
      ...won,
      text: won.text.replace("落札数量：4", "落札数量：0"),
    }),
    null,
  );
  assert.throws(() => yahooPurchaseId("../host"));
});
test("only product-specific first original image and public store metadata", () => {
  const url =
    "https://auctions.c.yimg.jp/images.auctions.yahoo.co.jp/image/test/first.jpg";
  const product = {
    "@type": "Product",
    url: "https://auctions.yahoo.co.jp/jp/auction/a1234567890",
    name: "椅子",
    image: [url, url.replace("first", "second")],
    offers: { priceValidUntil: "2026-10-15T00:00:00+09:00" },
  };
  const h = `<script type="application/ld+json">${JSON.stringify(product)}</script>`;
  assert.equal(parseYahooPublicItem(h, "a1234567890").imageUrl, url);
  assert.throws(() => parseYahooPublicItem(h, "b1234567890"));
  assert(!validYahooImage("https://evil.example/image/a.jpg"));
  assert(
    !validYahooImage("https://auctions.c.yimg.jp.evil.example/image/a.jpg"),
  );
  assert(!validYahooStore("http://127.0.0.1"));
  const s =
    "https://auctions.yahoo.co.jp/html/profile/abcdefghijklmn.html?user_type=c";
  assert.equal(
    parseYahooStore(
      "<table><tr><td>会社名</td><td>株式会社見本</td></tr><tr><td>本店住所</td><td>東京都千代田区</td></tr></table>",
      s,
    ).address,
    "東京都千代田区",
  );
});
test("quota errors do not falsely demand Gmail reauthorization", () => {
  assert.equal(
    gmailResponseError(403, {
      error: { errors: [{ reason: "rateLimitExceeded" }] },
    }),
    "GMAIL_RATE_LIMIT",
  );
  assert.equal(gmailResponseError(401, {}), "GMAIL_AUTH_REQUIRED");
});
test("seller shipping separate from item price; later mail fills gaps without duplicate sale", () => {
  const m = {
    ...won,
    subject: "Yahoo!オークション - 即決価格での落札：椅子(a1234567890)",
    text: "商品：椅子\nオークションID：a1234567890\n落札価格：10000 円\n落札数量：1",
  };
  const c = parsePurchaseMail(m)[0],
    p = parsePurchaseMail({
      ...m,
      gmailId: "c",
      subject:
        "Yahoo!オークション - 支払いが完了しました。商品を発送してください：椅子(a1234567890)",
      text: m.text + "\n送料：2000円\n合計金額：12000円",
    })[0];
  const r = mergeYahooNotification(c, p);
  assert.equal(r.unitPrice, 10000);
  assert.equal(r.shipping, 2000);
  assert.equal(r.orderTotal, 12000);
  assert.equal(r.id, c.id);
  assert.equal(parseYahooPurchaseMail(m), null);
});
