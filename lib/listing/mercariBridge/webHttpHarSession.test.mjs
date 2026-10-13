import test from "node:test";
import assert from "node:assert/strict";
import { sessionFromProvidedHar } from "./webHttpHarSession.ts";
const now = 1_000_000;
const token = exp => `header.${Buffer.from(JSON.stringify({exp})).toString("base64url")}.fixture`;
const entry = (cookie, overrides = {}) => ({ startedDateTime: new Date(now - 1000).toISOString(),
  request: { url: "https://mercari-shops.com/graphql", method: "POST",
    headers: [{ name: "Cookie", value: cookie }], ...overrides } });
const har = (...entries) => ({log:{entries}});
test("provided HAR yields only allowlisted cookies from the exact observed HTTPS endpoint", () => {
  const valid = token(2000);
  const s = sessionFromProvidedHar(har(entry(`unrelated=ignore; id_token=${valid}; __cf_bm=fixture`)), now);
  assert.equal(s.cookieHeader, `id_token=${valid}; __cf_bm=fixture`);
  assert.equal(s.expiresAtMs, 2_000_000);
  assert.equal(sessionFromProvidedHar(har(entry(`id_token=${valid}`, {url:"https://other.example/graphql"})),now), null);
});
test("expired, missing, duplicate and injected cookies never become runtime sessions", () => {
  for (const cookie of ["id_token="+token(1000), "__cf_bm=fixture", "id_token=opaque",
    `id_token=${token(2000)}; id_token=${token(2001)}`, `id_token=${token(2000)}\r\nHost: other`])
    assert.equal(sessionFromProvidedHar(har(entry(cookie)), now), null);
});
test("malformed capture records fail closed and the latest valid capture wins", () => {
  assert.equal(sessionFromProvidedHar(har(null, {request:null}, entry("ignored", {
    headers:[null,{name:42,value:"bad"}], cookies:[null,{name:"id_token",value:token(9e12)}]
  })),now),null);
  const recent = entry(`id_token=${token(3000)}`);
  recent.startedDateTime = new Date(now).toISOString();
  assert.equal(sessionFromProvidedHar(har(recent,entry(`id_token=${token(2000)}`)),now).expiresAtMs,3_000_000);
});
