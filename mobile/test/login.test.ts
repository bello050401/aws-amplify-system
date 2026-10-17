import { strict as assert } from "node:assert";
import { test } from "node:test";
import { loginErrorMessage, resolveLoginId, STAFF_ACCOUNT_IDENTIFIER } from "../src/domain/login";

test("staff ID and full-width keyboard input resolve to the dedicated account", () => {
  for (const value of ["スタッフ", " スタッフ ", "ＳＴＡＦＦ", "staff"]) assert.equal(resolveLoginId(value), STAFF_ACCOUNT_IDENTIFIER);
  assert.equal(resolveLoginId(" owner@example.com "), "owner@example.com");
  assert.notEqual(resolveLoginId("スタッフ2"), STAFF_ACCOUNT_IDENTIFIER);
});

test("authentication errors are actionable and never echo server secrets", () => {
  const error = new Error("private payload"); error.name = "NotAuthorizedException";
  assert.match(loginErrorMessage(error), /ログインIDまたはパスワード/);
  error.name = "TooManyRequestsException";
  assert.match(loginErrorMessage(error), /少し時間/);
  assert.doesNotMatch(loginErrorMessage(new Error("private payload")), /private payload/);
});
