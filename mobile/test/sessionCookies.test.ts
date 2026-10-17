import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeSessionCookies } from "../src/runtime/sessionCookies";

test("native session uses the existing Cognito cookie names without forwarding refresh tokens", () => {
  const value = nativeSessionCookies({ clientId: "publicclient", username: "user-123", accessToken: "access.payload.signature", idToken: "id.payload.signature" });
  assert.match(value, /CognitoIdentityServiceProvider\.publicclient\.LastAuthUser=user-123/);
  assert.match(value, /\.user-123\.accessToken=access.payload.signature/);
  assert.match(value, /\.user-123\.idToken=id.payload.signature/);
  assert.equal(value.includes("refreshToken"), false);
});
test("session values cannot inject other cookies or request headers", () => {
  const valid = { clientId: "client", username: "user", accessToken: "one.two.three", idToken: "one.two.three" };
  for (const key of Object.keys(valid)) for (const payload of ["x; other=admin", "x\r\nX-Role: ADMIN", ""]) {
    assert.throws(() => nativeSessionCookies({ ...valid, [key]: payload }));
  }
});
