import test from "node:test";
import assert from "node:assert/strict";
import { YahooWebSession, parseYahooImageResponse } from "./webHttpSession.ts";
import { categoryRequestFromInput, relistingImagesFromInput, verifyPreview, validPreviewInput } from "./webHttpPreview.ts";

const origin = "https://auctions.yahoo.co.jp";
const now = Date.parse("2026-10-16T03:00:00Z");
const secret = "synthetic-private-token";
const image = { url: "https://auctions.c.yimg.jp/example/chair.jpg", width: 1200, height: 1200 };
const input = { title: "Chair", description: "Chair & table\n<good>", condition: "used20", priceYen: 99999,
  quantity: 1, categoryId: "2084057261", closingDateJst: "2026-10-19", closingHourJst: 11,
  shipping: { payer: "seller", method: "家財おまかせ便", prefecture: "11", schedule: "2" } };
const escape = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const fields = o => Object.entries(o).map(([k,v]) => `<input type="hidden" name="${k}" value="${escape(v)}">`).join("");
const inputForm = (category = "0", token = "fresh-input-token") => `<form name="auction" method="post" action="${origin}/sell/jp/show/preview">${fields({
  mode: "submit", aID: "", oldAID: "", category, ".crumb": token, md5: secret, submitUnixtime: String(now / 1000),
  Title: "", Description: "", loc_cd: "11", shipschedule: "2", salesmode: "buynow", BidOrBuyPrice: "",
  shipping: "seller", unknownAddedField: "must-not-replay", cpaAmount: "100", featuredAmount: "50",
})}<select name="istatus"><option value="used20">Good</option></select>
<select name="Quantity"><option value="1">1</option></select></form>`;
const selector = `<form name="topsubmit" method="post" action="${origin}/sell/jp/show/submit">${fields({
  mode: "submit", aID: "", oldAID: "", category: "0", _crumb: "selector-fresh-token", crumb: "other-selector-token",
})}</form>`;
const previewValues = {
  mode: "submit",
  Title: input.title, Description: "Chair &amp; table<br>&lt;good&gt;", category: input.categoryId, Quantity: "1",
  istatus: "used20", salesmode: "buynow", StartPrice: "99999", BidOrBuyPrice: "99999",
  ImageFullPath1: image.url, ImageWidth1: "1200", ImageHeight1: "1200", shipping: "seller",
  shipname1: "家財おまかせ便", shipmethod: "other", loc_cd: "11", shipschedule: "2", ClosingYMD: "2026-10-19", ClosingTime: "11",
  numResubmit: "0", AutoExtension: "no", Offer: "0", featuredAmount: "", cpaAmount: "", totalCharges: "0",
  insertionFeeTotal: "0", is_paypay_fleamarket_cross_listing: "0", endDate: String(Date.parse("2026-10-19T02:49:00Z") / 1000), ".crumb": secret,
};
const preview = overrides => `<form name="auction" method="post">${fields({...previewValues, ...overrides})}</form><button id="auc_preview_submit_down">Publish</button>`;
const capture = { log: { entries: [{ startedDateTime: new Date(now).toISOString(), request: {
  method: "GET", url: origin + "/jp/show/submit?category=0", headers: [{name:"Cookie",value:`session=${secret}`}] }, response: {status:200} }] } };
const html = s => new Response(s, { headers: { "content-type": "text/html" } });

test("captured image envelopes accept omitted thumbnails and numeric string dimensions", () => {
  assert.deepEqual(parseYahooImageResponse({ images: [image] }), image);
  assert.deepEqual(parseYahooImageResponse({ images: [{...image,width:"1200",height:"1200"}] }), image);
  for (const changed of [{width:"1e3"}, {height:0}, {width:true}, {url:"https://evil.yimg.jp/a.jpg"}, {url:image.url+"?token=private"}])
    assert.equal(parseYahooImageResponse({images:[{...image,...changed}]}), null);
  assert.equal(parseYahooImageResponse({images:[image,image]}), null);
});

test('relisting reads immutable prior photos and rejects wrong item, category, asset or gaps',()=>{
  const requested={...input,relistId:'f1248612637'};
  const form=(extra={})=>`<form name="auction" method="post" action="${origin}/sell/jp/show/preview">${fields({mode:'oresubmit',aID:requested.relistId,oldAID:'',category:input.categoryId,'.crumb':secret,ImageFullPath1:image.url,ImageWidth1:'1200',ImageHeight1:'1200',Image1Uploaded:'1',...extra})}</form>`;
  assert.deepEqual(relistingImagesFromInput(form(),requested),[image]);
  for(const changed of [{aID:'f1111111111'},{category:'1'},{Image1Uploaded:''},{ImageFullPath1:'https://evil.example/a.jpg'},{ImageFullPath3:image.url,ImageWidth3:'1200',ImageHeight3:'1200',Image3Uploaded:'1'}])assert.throws(()=>relistingImagesFromInput(form(changed),requested));
  assert.equal(verifyPreview(preview({mode:'oresubmit',aID:requested.relistId}),requested,{...image,url:'https://auctions.c.yimg.jp/new-upload.jpg'}),null);
});

test("fresh form sequence posts only the three observed non-public paths", async () => {
  const requests = [];
  const session = YahooWebSession.fromHar(capture, { now, fetchImpl: async (url, options) => {
    requests.push(url);
    assert.equal(options.redirect, "manual");
    if (options.method === "GET") return html(inputForm());
    const body = options.body;
    assert.equal(body instanceof URLSearchParams, true);
    assert.equal(body.has("unknownAddedField"), false);
    if (url.endsWith("/topsubmit")) {
      assert.equal(body.get(".crumb"), "fresh-input-token");
      assert.equal(body.get("category"), "0");
      assert.equal(body.get("cpaAmount"), "");
      assert.equal(body.get("numResubmit"), "0");
      assert.equal(body.get("Description"), previewValues.Description);
      return html(selector);
    }
    if (url.endsWith("/show/submit")) {
      assert.equal(body.get("_crumb"), "selector-fresh-token");
      assert.equal(body.get("category"), input.categoryId);
      return html(inputForm(input.categoryId, "fresh-category-token"));
    }
    assert.equal(url, origin + "/sell/jp/show/preview");
    assert.equal(body.get(".crumb"), "fresh-category-token");
    assert.equal(body.get("BidOrBuyPrice"), "99999");
    assert.equal(body.get("ImageFullPath1"), image.url);
    return html(preview());
  } }).value;
  const result = await session.previewFixedListing(input, image);
  assert.equal(result.ok, true);
  assert.equal(result.value.publicationAttempted, false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(requests.length, 4);
  assert.equal(requests.some(u => u.includes("/config/")), false);
  assert.equal((await session.previewFixedListing(input, image)).code, "PREVIEW_ALREADY_ATTEMPTED");
  assert.equal(requests.length, 4);
});

test("changed category action, auth rejection and network ambiguity stop with no retry", async () => {
  for (const response of [() => html(selector.replace('/sell/jp/show/submit', '/sell/jp/config/submit')),
    () => new Response(null, {status:302,headers:{location:'https://login.yahoo.co.jp/'}}),
    () => new Response(secret,{status:403}), () => {throw Error(secret);}]) {
    let count = 0;
    const session = YahooWebSession.fromHar(capture, {now, fetchImpl: async () => ++count === 1 ? html(inputForm()) : response()}).value;
    const result = await session.previewFixedListing(input,image);
    assert.equal(result.ok,false); assert.equal(count,2);
    assert.equal(JSON.stringify(result).includes(secret),false);
    await session.previewFixedListing(input,image); assert.equal(count,2);
  }
});

test("HTTP 200 does not approve changed prices, fees, images, delivery, descriptions or ending time", () => {
  assert.equal(verifyPreview(preview(),input,image).publicationAttempted,false);
  for (const change of [{BidOrBuyPrice:'9999'},{StartPrice:'1'},{Quantity:'2'},{category:'1'}, {ImageFullPath2:image.url},
    {shipping:'buyer'}, {Description:'Other'}, {totalCharges:'100'}, {numResubmit:'3'}, {cpaAmount:'1'},
    {is_paypay_fleamarket_cross_listing:'1'}, {endDate:String(now/1000)}, {shipname1:'Other'}])
    assert.equal(verifyPreview(preview(change),input,image),null);
});

test("invalid and unsupported requests are rejected before any HTTP request", async () => {
  for (const change of [{priceYen:0}, {quantity:10}, {categoryId:'a'}, {closingDateJst:'2026-02-30'},
    {shipping:{...input.shipping,payer:'buyer'}}, {title:'a'.repeat(66)}]) {
    assert.equal(validPreviewInput({...input,...change},image),false);
    const session = YahooWebSession.fromHar(capture,{now,fetchImpl:async()=>{assert.fail('must not send')}}).value;
    assert.equal((await session.previewFixedListing({...input,...change},image)).code,'INVALID_PREVIEW_INPUT');
  }
  assert.throws(()=>categoryRequestFromInput(inputForm(),{...input,closingDateJst:'2026-10-25'},image));
  assert.throws(()=>categoryRequestFromInput(inputForm().replace('name="aID" value=""','name="aID" value="existing"'),input,image));
});
