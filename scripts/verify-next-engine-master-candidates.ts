import assert from "node:assert/strict";
import { listNextEngineMasterCandidates, MasterCandidatesError } from "../lib/listing/nextEngine/masterCandidates";

const origin = "https://claude-inventory-management-system-5vbvc7.d4hkkg7dty2du.amplifyapp.com";
const secretId = "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";
const binding = { clientId: "fixture", clientSecret: "fixture", expectedCompanyNeId: "fixture", credentialVersionId: "fixture" };
const original = { accessToken: "access-fixture", refreshToken: "refresh-fixture" };
const rotated = { accessToken: "access-rotated", refreshToken: "refresh-rotated" };

async function exercise(changeBindingAt: "never" | "readTokens" | "afterSupplier" = "never") {
  let currentBinding = binding;
  let stored = original;
  const calls: string[] = [];
  const result = listNextEngineMasterCandidates({
    env: { NEXT_ENGINE_PUBLIC_ORIGIN: origin, NEXT_ENGINE_TOKEN_SECRET_ID: secretId },
    configuration: async () => currentBinding,
    readTokens: async () => {
      if (changeBindingAt === "readTokens") currentBinding = { ...binding, credentialVersionId: "changed" };
      return stored;
    },
    saveTokens: async pair => { stored = pair; },
    request: async (url, init) => {
      const path = String(url).replace("https://api.next-engine.org", "");
      calls.push(path);
      assert.equal(init?.method, "POST");
      const body = init?.body as URLSearchParams;
      assert.equal(body.get("limit"), "50");
      assert.equal(body.get("access_token"), calls.length === 1 ? original.accessToken : rotated.accessToken);
      if (path === "/api_v1_master_supplier/search") {
        if (changeBindingAt === "afterSupplier") currentBinding = { ...binding, credentialVersionId: "changed" };
        return new Response(JSON.stringify({ result: "success", count: "1", data: [
          { supplier_id: "REAL", supplier_name: "Registered supplier", supplier_deleted_flag: "0" },
        ], ...(changeBindingAt === "never" ? { access_token: rotated.accessToken, refresh_token: rotated.refreshToken } : {}) }));
      }
      assert.equal(path, "/api_v1_master_shop/search");
      return new Response(JSON.stringify({ result: "success", count: "2", data: [
        { shop_id: "7", shop_name: "Test shop", shop_mall_id: "12", shop_deleted_flag: "0" },
        { shop_id: "8", shop_name: "Deleted", shop_mall_id: "12", shop_deleted_flag: "1" },
      ] }));
    },
  });
  if (changeBindingAt !== "never") await assert.rejects(result, { code: "BINDING_CHANGED" });
  else {
    assert.deepEqual(await result, {
      suppliers: [{ code: "REAL", name: "Registered supplier" }],
      shops: [{ id: "7", name: "Test shop", mallId: "12" }],
      suppliersMore: false, shopsMore: false,
    });
    assert.deepEqual(stored, rotated);
  }
  assert.deepEqual(calls, changeBindingAt === "readTokens" ? [] : changeBindingAt === "afterSupplier" ?
    ["/api_v1_master_supplier/search"] : ["/api_v1_master_supplier/search", "/api_v1_master_shop/search"]);
  if (changeBindingAt !== "never") assert.equal(stored, original);
}

async function main() {
  await exercise();
  await exercise("readTokens");
  await exercise("afterSupplier");
  await assert.rejects(listNextEngineMasterCandidates({
    env: { NEXT_ENGINE_PUBLIC_ORIGIN: "https://other.example", NEXT_ENGINE_TOKEN_SECRET_ID: secretId },
    configuration: async () => { throw new Error("should not read"); },
  }), { code: "STAGING_CONFIGURATION" });
  await assert.rejects(listNextEngineMasterCandidates({
    env: { NEXT_ENGINE_PUBLIC_ORIGIN: origin, NEXT_ENGINE_TOKEN_SECRET_ID: secretId },
    configuration: async () => { throw new Error("secret detail must not escape"); },
  }), { code: "CONNECTION" });
  await assert.rejects(listNextEngineMasterCandidates({
    env: { NEXT_ENGINE_PUBLIC_ORIGIN: origin, NEXT_ENGINE_TOKEN_SECRET_ID: secretId },
    configuration: async () => binding,
    readTokens: async () => original,
    request: async () => new Response(JSON.stringify({ result: "success", count: "1", data: [
      { supplier_id: "REAL", supplier_name: "", supplier_deleted_flag: "0" },
    ] })),
  }), { code: "SUPPLIER_ROWS" });
  assert.equal(new MasterCandidatesError("SHOP_API").message, "ネクストエンジンの登録情報を確認できませんでした。");
  console.log("Next Engine read-only master candidates: PASS");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
