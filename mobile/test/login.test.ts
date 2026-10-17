import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loginErrorMessage, loginUsername, requestedLoginMode, resolveLoginId, STAFF_ACCOUNT_IDENTIFIER } from "../src/domain/login";

test("staff ID and full-width keyboard input resolve to the dedicated account", () => {
  for (const value of ["スタッフ", " スタッフ ", "ＳＴＡＦＦ", "staff"]) assert.equal(resolveLoginId(value), STAFF_ACCOUNT_IDENTIFIER);
  assert.equal(resolveLoginId(" owner@example.com "), "owner@example.com");
  assert.notEqual(resolveLoginId("スタッフ2"), STAFF_ACCOUNT_IDENTIFIER);
});

test("authentication errors are actionable and never echo server secrets", () => {
  const error = new Error("private payload"); error.name = "NotAuthorizedException";
  assert.match(loginErrorMessage(error), /ログインIDまたはパスワード/);
  assert.match(loginErrorMessage(error, "staff"), /^パスワードが違います/);
  error.name = "TooManyRequestsException";
  assert.match(loginErrorMessage(error), /少し時間/);
  assert.doesNotMatch(loginErrorMessage(new Error("private payload")), /private payload/);
});

test("staff entrance always targets the restricted account, while account switching preserves normal login", () => {
  assert.equal(loginUsername("staff", "owner@example.com"), STAFF_ACCOUNT_IDENTIFIER);
  assert.equal(loginUsername("staff", ""), STAFF_ACCOUNT_IDENTIFIER);
  assert.equal(loginUsername("account", "owner@example.com"), "owner@example.com");
  assert.equal(requestedLoginMode("?login=staff"), "staff");
  assert.equal(requestedLoginMode("?login=account"), "account");
  assert.equal(requestedLoginMode("?login=admin"), null);
  assert.equal(requestedLoginMode(""), null);
});
