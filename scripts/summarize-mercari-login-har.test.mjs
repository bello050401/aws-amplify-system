import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { summarizeMercariHar } from "./summarize-mercari-login-har.mjs";

const secret = "PRIVATE_JANE_OTP654321_TOKEN";
const har = { log: { entries: [
  { request: { method: "POST",
    url: `https://private.mercari-shops.com/signin/${secret}?code=${secret}`,
    headers: [
      { name: "Content-Type", value: `application/json; boundary=${secret}` },
      { name: "Authorization", value: `Bearer ${secret}` },
      { name: "Cookie", value: `session=${secret}` },
      { name: "X-CSRF-Token", value: secret },
      { name: "Referer", value: `https://mercari-shops.com/${secret}` },
      { name: `X-${secret}`, value: secret },
    ],
    cookies: [{ name: "session", value: secret }],
    postData: { mimeType: "application/json",
      text: JSON.stringify({ password: secret, otp: secret }) } },
    response: { status: 302, headers: [
      { name: "Location", value: `https://mercari-shops.com/${secret}` },
      { name: "Set-Cookie", value: `session=${secret}` },
      { name: "Content-Type", value: "text/html" },
    ], cookies: [{ name: "session", value: secret }],
    content: { mimeType: "text/html", text: secret } },
    startedDateTime: secret },
  { request: { method: "POST",
    url: `https://mercari-shops.com/graphql?token=${secret}`,
    headers: [{ name: "Content-Type", value: "application/json" }],
    postData: { text: JSON.stringify({ operationName: secret,
      variables: { email: secret, smsCode: secret } }) } },
    response: { status: 200, headers: [],
      content: { text: secret, mimeType: "application/json" } } },
  { request: { method: "POST", url: "https://mercari-shops.com/graphql",
    headers: [], postData: { text: JSON.stringify({
      operationName: "GetProductDraft", variables: { token: secret },
    }) } }, response: { status: 200, headers: [], content: {} } },
  { request: { method: "GET", url: `https://unrelated.example/${secret}` },
    response: { status: 200 } },
] } };

test("only bounded Mercari metadata survives the projection", () => {
  const summary = summarizeMercariHar(har);
  const output = JSON.stringify(summary);
  assert.equal(summary.mercariEntryCount, 3);
  assert.equal(summary.entries[0].host, "*.mercari-shops.com");
  assert.equal(summary.entries[0].path, "/signin/:redacted");
  assert.deepEqual(summary.entries[0].requestHeaderNames,
    ["content-type", "referer", "x-csrf-token"]);
  assert.deepEqual(summary.entries[0].responseHeaderNames,
    ["content-type", "location"]);
  assert.equal(summary.entries[0].requestContentType, "application/json");
  assert.equal(summary.entries[0].cookieHeaderPresent, true);
  assert.equal(summary.entries[0].authorizationHeaderPresent, true);
  assert.equal(summary.entries[0].csrfHeaderPresent, true);
  assert.equal(summary.entries[0].setCookieHeaderPresent, true);
  assert.equal(summary.entries[0].requestCookieCount, 1);
  assert.equal(summary.entries[0].responseCookieCount, 1);
  assert.equal(summary.entries[1].requestCookieCount, null);
  assert.equal(summary.entries[1].cookieHeaderPresent, false);
  assert.equal(summary.entries[1].graphqlOperationName, "REDACTED");
  assert.equal(summary.entries[2].graphqlOperationName, "GetProductDraft");
  assert.equal(output.includes(secret), false);
  for (const forbidden of ["Bearer", "session=", "password", "smsCode",
    "Set-Cookie", "Authorization", "unrelated.example", "?token="])
    assert.equal(output.includes(forbidden), false);
});

test("CLI emits only the summary and generic errors for a local HAR", () => {
  const directory = mkdtempSync(join(tmpdir(), "bello-har-summary-"));
  const file = join(directory, "synthetic.har");
  const script = fileURLToPath(new URL("./summarize-mercari-login-har.mjs",
    import.meta.url));
  try {
    writeFileSync(file, JSON.stringify(har));
    const okay = spawnSync(process.execPath, [script, file],
      { encoding: "utf8" });
    assert.equal(okay.status, 0);
    assert.equal(okay.stderr, "");
    assert.equal(JSON.parse(okay.stdout).mercariEntryCount, 3);
    assert.equal(okay.stdout.includes(secret), false);
    writeFileSync(file, `{ "secret": "${secret}"`);
    const invalid = spawnSync(process.execPath, [script, file],
      { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.equal(invalid.stderr, "HAR_SUMMARY_FAILED\n");
    assert.equal(invalid.stderr.includes(secret), false);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
});

test("a long capture is bounded without copying any raw request", () => {
  const many = { log: { entries: Array.from({ length: 1_001 }, () =>
    har.log.entries[0]) } };
  const summary = summarizeMercariHar(many);
  assert.equal(summary.mercariEntryCount, 1_001);
  assert.equal(summary.entries.length, 1_000);
  assert.equal(summary.truncated, true);
  assert.equal(JSON.stringify(summary).includes(secret), false);
});

test("reviewed fixed login path parts remain visible without URL values", () => {
  const summary = summarizeMercariHar({ log: { entries: [{
    request: { method: "POST",
      url: `https://mercari-shops.com/auth/signin/idp?state=${secret}` },
    response: { status: 200 },
  }] } });
  assert.equal(summary.entries[0].path, "/auth/signin/idp");
  assert.equal(JSON.stringify(summary).includes(secret), false);
});
