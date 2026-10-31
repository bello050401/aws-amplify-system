import assert from "node:assert/strict";
import {build} from 'esbuild';
import vm from 'node:vm';
import {NextResponse} from 'next/server';
import * as transient from '../lib/amplify/cognitoTransientError';
import {pathToFileURL} from 'node:url';
const mocks=pathToFileURL(process.cwd()+'/scripts/__mocks__/').href;

async function main() {
  const { isCognitoRateLimitError, isCognitoInvalidLoginTokenError } = await import("@/lib/amplify/cognitoTransientError");

  const mock = (await import(mocks + "inventoryAuthMiddleware.fetchAuthSession.mock.cjs")).default;
  // Execute the real auth boundary; all network ports are explicit and fail closed.
  const ports:Record<string,unknown>={
    './requestCache':{requestCache:(fn:unknown)=>fn},
    'next/headers':{cookies:()=>({get:()=>undefined})},
    'next/server':{NextResponse},
    'aws-amplify/auth/server':mock,
    './userPoolServer':{runWithUserPoolServerContext:async({operation}:any)=>operation({})},
    './cognitoTransientError':transient,
  };
  const bundle=await build({entryPoints:['lib/amplify/requireInventoryUser.ts'],bundle:true,platform:'node',format:'cjs',write:false,plugins:[{name:'ports',setup(b){b.onResolve({filter:/.*/},a=>a.kind==='entry-point'?undefined:{path:a.path,external:true});}}]});
  const mod={exports:{} as any};vm.runInNewContext(bundle.outputFiles[0].text,{module:mod,exports:mod.exports,process:{env:{NODE_ENV:'production'}},URL,console,require:(name:string)=>{if(!(name in ports))throw Error('Unmocked '+name);return ports[name];}});
  const {getInventorySessionStatus,getInventoryRole,requireInventoryUserOrRedirect}=mod.exports;
  let calls = 0;
  const set = (behavior: () => Promise<unknown>) => mock.__setBehavior(async () => { calls += 1; return behavior(); });
  const request = new Request("https://bello.example.com/inventory/item-id");

  assert.equal(isCognitoRateLimitError({ name: "NoSignedUser" }), false);
  assert.equal(isCognitoRateLimitError({ name: "NoSignedUser", underlyingError: { name: "TooManyRequestsException" } }), true);
  assert.equal(isCognitoRateLimitError({ cause: { code: "TooManyRequestsException" } }), true);
  assert.equal(isCognitoRateLimitError({ name: "NotAuthorizedException", cause: { name: "AccessDeniedException" } }), false);
  assert.equal(isCognitoInvalidLoginTokenError({ name: "NoSignedUser", underlyingError: { name: "NotAuthorizedException", message: "Invalid login token. Couldn't verify signed token." } }), true);
  assert.equal(isCognitoInvalidLoginTokenError({ name: "NotAuthorizedException", message: "Permission denied" }), false);
  assert.equal(isCognitoInvalidLoginTokenError({ name: "NoSignedUser", underlyingError: { name: "TooManyRequestsException", message: "Rate exceeded" } }), false);
  assert.equal(isCognitoInvalidLoginTokenError({ name: "NoSignedUser" }), false);

  set(async () => ({ tokens: undefined }));
  assert.deepEqual(JSON.parse(JSON.stringify(await getInventorySessionStatus())), { kind: "signed-out" });
  assert.equal(calls, 1, "signed-outでも認証確認は1回だけ");
  let response = await requireInventoryUserOrRedirect(request);
  assert.equal(response?.status, 307);
  assert.equal(response?.headers.get("location"), "https://bello.example.com/inventory/login");

  set(async () => { throw { name: "NoSignedUser", underlyingError: { name: "TooManyRequestsException" } }; });
  calls = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(await getInventorySessionStatus())), { kind: "temporarily-unavailable" });
  assert.equal(calls, 1, "一時エラーでも自動retryしない");
  assert.equal(await getInventoryRole(), null, "一時エラーで保護操作の権限を与えない");
  response = await requireInventoryUserOrRedirect(request);
  assert.equal(response?.status, 503);
  assert.equal(response?.headers.get("location"), null, "ログイン画面へ誤誘導しない");

  set(async () => { throw { name: "NoSignedUser", underlyingError: { name: "NotAuthorizedException" } }; });
  assert.deepEqual(JSON.parse(JSON.stringify(await getInventorySessionStatus())), { kind: "signed-out" }, "実認証失効は従来のログイン導線");

  set(async () => ({ tokens: { accessToken: { payload: { "cognito:groups": ["OtherGroup"] } } } }));
  assert.deepEqual(JSON.parse(JSON.stringify(await getInventorySessionStatus())), { kind: "signed-in-not-authorized" });
  response = await requireInventoryUserOrRedirect(request);
  assert.equal(response?.headers.get("location"), "https://bello.example.com/inventory/login?error=not_authorized");

  set(async () => ({ tokens: { accessToken: { payload: { "cognito:groups": ["EDITOR", "ADMIN"] } } } }));
  calls = 0;
  assert.deepEqual(JSON.parse(JSON.stringify(await getInventorySessionStatus())), { kind: "authorized", role: "ADMIN" });
  assert.equal(calls, 1, "通常経路の認証通信回数は増やさない");
  assert.equal(await requireInventoryUserOrRedirect(request), null);
  mock.__reset();
  console.log("[verify-inventory-auth-transient] passed");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
