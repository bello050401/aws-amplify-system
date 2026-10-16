import test from "node:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { YahooWebSession, inspectYahooInputHtml } from "./webHttpSession.ts";

const secret = "private-session-fixture-never-log";
const now = Date.parse("2026-10-16T03:00:00Z");
const inputUrl = "https://auctions.yahoo.co.jp/jp/show/submit?category=0";
const capture = (change = {}) => ({ log: { entries: [{ startedDateTime: new Date(now).toISOString(),
  request: { url: inputUrl, method: "GET", headers: [{ name: "Cookie", value: `session=${secret}; other=value` }] },
  response: { status: 200 }, ...change }] } });
const form = `<form method="post" action="/sell/jp/show/preview">
  <input name=".crumb" type="hidden" value="${secret}"><input id="img_crumb" type="hidden" value="${secret}">
  <input id="imgUploadUrl" value="https://auctions.yahoo.co.jp/img/images/new">
  <input name="Title"><input name="Description" type="hidden"><input name="BidOrBuyPrice">
  <input name="loc_cd"><input name="shipschedule"><input name="salesmode">
  <input name="shipping" value="buyer"><select name="istatus"><option value="">Choose</option>
  <option value="new">Unused</option><option value="used20">Good</option></select>
  <select name="Quantity"><option value="1">1</option><option value="2">2</option></select>
  <select name="numResubmit"><option value="0">No</option><option value="3" selected>3</option></select>
  </form>`;
const okResponse = () => new Response(form, { status: 200, headers: { "content-type": "text/html; charset=UTF-8" } });

test("only the observed successful input-page capture supplies the session", () => {
  assert.equal(YahooWebSession.fromHar(capture(), { now }).ok, true);
  for (const url of ["https://evil.example/", "https://auctions.yahoo.co.jp.evil.example/jp/show/submit?category=0",
    "http://auctions.yahoo.co.jp/jp/show/submit?category=0", "https://auctions.yahoo.co.jp/sell/jp/show/preview",
    `${inputUrl}&redirect=https://evil.example`, `${inputUrl}#secret`, `https://name:pass@auctions.yahoo.co.jp/jp/show/submit?category=0`]) {
    const h = capture(); h.log.entries[0].request.url = url;
    assert.equal(YahooWebSession.fromHar(h, { now }).ok, false);
  }
  for (const change of [{ request: { url: inputUrl, method: "POST" } }, { response: { status: 302 } },
    { startedDateTime: new Date(now + 120_000).toISOString() }])
    assert.equal(YahooWebSession.fromHar(capture(change), { now }).ok, false);
  assert.equal(YahooWebSession.fromHar(capture({ startedDateTime: "2026-10-14T00:00:00Z" }), { now }).code, "CAPTURE_TOO_OLD");
});

const jpeg = Uint8Array.from([255,216,255,224,0,0,0,0,255,217]);
const uploaded = { images: [{ url: "https://auctions.c.yimg.jp/example/image.jpg", width: 1280, height: 1280 }],
  thumbnail: "https://auctions.c.yimg.jp/example/thumbnail.jpg" };

test("image upload uses the fresh live token and exact observed multipart destination once", async () => {
  const requests = [];
  const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async (url, options) => {
    requests.push({ url, method: options.method });
    if (options.method === "GET") return okResponse();
    assert.equal(url, "https://auctions.yahoo.co.jp/img/images/new");
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Origin, "https://auctions.yahoo.co.jp");
    assert.equal(options.headers.Referer, inputUrl);
    assert.deepEqual([...options.body.keys()], ["files[0]", ".crumb", "need_thumbnail"]);
    assert.equal(options.body.get(".crumb"), secret);
    assert.equal(options.body.get("need_thumbnail"), "1");
    assert.equal(options.body.get("files[0]").type, "image/jpeg");
    assert.deepEqual(new Uint8Array(await options.body.get("files[0]").arrayBuffer()), jpeg);
    return Response.json(uploaded);
  } }).value;
  assert.equal((await session.probeImageUpload(jpeg, "chair.jpg")).code, "INPUT_REQUIRED");
  assert.equal((await session.inspectInput()).ok, true);
  assert.equal((await session.probeImageUpload(jpeg, "chair.jpg")).ok, true);
  assert.equal((await session.probeImageUpload(jpeg, "chair.jpg")).code, "UPLOAD_ALREADY_ATTEMPTED");
  assert.equal(requests.length, 2);
  assert.equal(inspect(session).includes(secret), false);
});

test("image target changes and invalid files prevent a POST", async () => {
  for (const [html, bytes, filename, code] of [
    [form.replace('id="imgUploadUrl" value="https://auctions.yahoo.co.jp', 'id="imgUploadUrl" value="https://evil.example'), jpeg, "chair.jpg", "INPUT_REQUIRED"],
    [form.replace('id="img_crumb"', 'id="missing"'), jpeg, "chair.jpg", "INPUT_REQUIRED"],
    [form, jpeg, "chair.png", "INVALID_IMAGE"], [form, jpeg, "../chair.jpg", "INVALID_IMAGE"],
    [form, new Uint8Array(5 * 1024 * 1024 + 1), "chair.jpg", "INVALID_IMAGE"],
  ]) {
    let calls = 0;
    const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async () => {
      calls++; return new Response(html, { headers: { "content-type": "text/html" } });
    } }).value;
    await session.inspectInput();
    assert.equal((await session.probeImageUpload(bytes, filename)).code, code);
    assert.equal(calls, 1);
  }
});

test("uncertain image outcomes never retry, follow redirects or expose response bodies", async () => {
  for (const outcome of [() => { throw Error(secret); }, () => new Response(secret, { status: 302, headers: { location: "https://evil.example/" } }),
    () => Response.json({ images: [], error: secret }), () => Response.json({ ...uploaded, thumbnail: "https://evil.example/" }),
    () => new Response(secret, { status: 403 })]) {
    let posts = 0;
    const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async (_url, options) => {
      if (options.method === "GET") return okResponse(); posts++; return outcome();
    } }).value;
    await session.inspectInput();
    const result = await session.probeImageUpload(jpeg, "chair.jpg");
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal((await session.probeImageUpload(jpeg, "chair.jpg")).code, "UPLOAD_ALREADY_ATTEMPTED");
    assert.equal(posts, 1);
  }
});

test("sanitized, malformed and ambiguous cookies are rejected without logging values", () => {
  for (const headers of [[], [{ name: "Cookie", value: `session=${secret}\r\nX-Evil: 1` }],
    [{ name: "Cookie", value: "session=one; session=two" }], [{ name: "Cookie", value: "missing-equals" }],
    [{ name: "Cookie", value: "a=b" }, { name: "cookie", value: "c=d" }]]) {
    const h = capture(); h.log.entries[0].request.headers = headers;
    const result = YahooWebSession.fromHar(h, { now });
    assert.equal(result.ok, false); assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("authenticated GET returns only vetted metadata and keeps all credentials private", async () => {
  let calls = 0;
  const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, inputUrl); assert.equal(options.method, "GET"); assert.equal(options.redirect, "manual");
    assert.equal(options.cache, "no-store"); assert.ok(options.headers.Cookie.includes(secret));
    assert.equal(options.body, undefined); return okResponse();
  } });
  assert.equal(session.ok, true);
  const result = await session.value.inspectInput();
  assert.equal(result.ok, true); assert.equal(calls, 1);
  assert.deepEqual(result.value.conditionValues, ["new", "used20"]);
  assert.deepEqual(result.value.quantityValues, [1, 2]);
  assert.equal(result.value.shippingPayerDefault, "buyer"); assert.equal(result.value.automaticRelistDefault, 3);
  for (const text of [JSON.stringify(result), JSON.stringify(session), inspect(session.value)]) assert.equal(text.includes(secret), false);
});

test("a login redirect or third-party destination is never followed", async () => {
  for (const [location, code] of [["https://login.yahoo.co.jp/config/login", "AUTH_REQUIRED"],
    ["https://evil.example/collect", "UNEXPECTED_RESPONSE"], ["/another-path", "UNEXPECTED_RESPONSE"]]) {
    let calls = 0;
    const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async () => {
      calls++; return new Response(null, { status: 302, headers: { Location: location } });
    } }).value;
    assert.equal((await session.inspectInput()).code, code); assert.equal(calls, 1);
  }
});

test("denied, limited and unavailable reads stop after one request", async () => {
  for (const [status, code] of [[401, "AUTH_REQUIRED"], [403, "ACCESS_DENIED"], [429, "RATE_LIMITED"], [503, "UNEXPECTED_RESPONSE"]]) {
    let calls = 0;
    const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async () => {
      calls++; return new Response(secret, { status });
    } }).value;
    const result = await session.inspectInput(); assert.equal(result.code, code); assert.equal(calls, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
  const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async () => { throw Error(secret); } }).value;
  assert.deepEqual(await session.inspectInput(), { ok: false, code: "READ_UNAVAILABLE" });
});

test("HTTP 200 is insufficient: changed forms, missing tokens and alternate actions fail closed", () => {
  for (const html of ["<html>Login required</html>", form + form,
    form.replace('/sell/jp/show/preview', 'https://evil.example/collect'),
    form.replace('name=".crumb"', 'name="missing"'), form.replace('name="Description"', 'name="missing"'),
    form.replace('value="used20"', 'value="unknown-status"'), form.replace('value="2">2', 'value="99">99')])
    assert.equal(inspectYahooInputHtml(html).ok, false);
  assert.equal(inspectYahooInputHtml(form.replace('<form ', '<form data-unused="&amp;" ')).ok, true);
});

test("response MIME and bounded streaming are enforced before parsing", async () => {
  for (const response of [new Response(form, { headers: { "content-type": "application/json" } }),
    new Response("x".repeat(2 * 1024 * 1024 + 1), { headers: { "content-type": "text/html" } }),
    new Response(form, { headers: { "content-type": "text/html", "content-length": "3000000" } })]) {
    const session = YahooWebSession.fromHar(capture(), { now, fetchImpl: async () => response }).value;
    assert.equal((await session.inspectInput()).ok, false);
  }
});
