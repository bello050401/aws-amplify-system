import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

declare module "node:module" {
  export function registerHooks(hooks: {
    resolve?: (specifier: string, context: { parentURL?: string }, nextResolve: (specifier: string, context: unknown) => unknown) => unknown;
  }): void;
}

const root = pathToFileURL(process.cwd() + "/").href;
const mocks = root + "scripts/__mocks__/";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "aws-amplify/auth/server") return { url: mocks + "inventoryAuthMiddleware.fetchAuthSession.mock.cjs", shortCircuit: true };
    if (specifier === "@/lib/amplify/serverUtils" || (specifier === "./serverUtils" && context.parentURL?.includes("/lib/amplify/requireInventoryUser"))) {
      return { url: mocks + "inventoryAuthTransient.serverUtils.mock.cjs", shortCircuit: true };
    }
    if (!specifier.startsWith("@/")) return nextResolve(specifier, context);
    const target = root + specifier.slice(2);
    try { return nextResolve(target, context); }
    catch { return nextResolve(target + ".ts", context); }
  },
});

async function main() {
  const { isCognitoRateLimitError } = await import("@/lib/amplify/cognitoTransientError");
  const { getInventorySessionStatus, getInventoryRole, requireInventoryUserOrRedirect } = await import("@/lib/amplify/requireInventoryUser");
  const mock = (await import(mocks + "inventoryAuthMiddleware.fetchAuthSession.mock.cjs")).default;
  let calls = 0;
  const set = (behavior: () => Promise<unknown>) => mock.__setBehavior(async () => { calls += 1; return behavior(); });
  const request = new Request("https://bello.example.com/inventory/item-id");

  assert.equal(isCognitoRateLimitError({ name: "NoSignedUser" }), false);
  assert.equal(isCognitoRateLimitError({ name: "NoSignedUser", underlyingError: { name: "TooManyRequestsException" } }), true);
  assert.equal(isCognitoRateLimitError({ cause: { code: "TooManyRequestsException" } }), true);
  assert.equal(isCognitoRateLimitError({ name: "NotAuthorizedException", cause: { name: "AccessDeniedException" } }), false);

  set(async () => ({ tokens: undefined }));
  assert.deepEqual(await getInventorySessionStatus(), { kind: "signed-out" });
  assert.equal(calls, 1, "signed-outでも認証確認は1回だけ");
  let response = await requireInventoryUserOrRedirect(request);
  assert.equal(response?.status, 307);
  assert.equal(response?.headers.get("location"), "https://bello.example.com/inventory/login");

  set(async () => { throw { name: "NoSignedUser", underlyingError: { name: "TooManyRequestsException" } }; });
  calls = 0;
  assert.deepEqual(await getInventorySessionStatus(), { kind: "temporarily-unavailable" });
  assert.equal(calls, 1, "一時エラーでも自動retryしない");
  assert.equal(await getInventoryRole(), null, "一時エラーで保護操作の権限を与えない");
  response = await requireInventoryUserOrRedirect(request);
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("location"), null, "ログイン画面へ誤誘導しない");

  set(async () => { throw { name: "NoSignedUser", underlyingError: { name: "NotAuthorizedException" } }; });
  assert.deepEqual(await getInventorySessionStatus(), { kind: "signed-out" }, "実認証失効は従来のログイン導線");

  set(async () => ({ tokens: { accessToken: { payload: { "cognito:groups": ["OtherGroup"] } } } }));
  assert.deepEqual(await getInventorySessionStatus(), { kind: "signed-in-not-authorized" });
  response = await requireInventoryUserOrRedirect(request);
  assert.equal(response?.headers.get("location"), "https://bello.example.com/inventory/login?error=not_authorized");

  set(async () => ({ tokens: { accessToken: { payload: { "cognito:groups": ["EDITOR", "ADMIN"] } } } }));
  calls = 0;
  assert.deepEqual(await getInventorySessionStatus(), { kind: "authorized", role: "ADMIN" });
  assert.equal(calls, 1, "通常経路の認証通信回数は増やさない");
  assert.equal(await requireInventoryUserOrRedirect(request), null);
  mock.__reset();
  console.log("[verify-inventory-auth-transient] passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
