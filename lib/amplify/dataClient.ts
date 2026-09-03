import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { generateServerClientUsingCookies } from "@aws-amplify/adapter-nextjs/data";
import type { Schema } from "@/amplify/data/resource";
import outputs from "@/amplify_outputs.json";
import { createDirectDataClient } from "./directData";

/**
 * Server-side Amplify Data client for use inside Server Components,
 * Route Handlers, and Server Actions.
 *
 * IMPORTANT: this client does NOT automatically switch auth mode based on
 * whether a Cognito session exists. Every call uses the schema's
 * `defaultAuthorizationMode` ("apiKey") unless `authMode` is passed
 * explicitly per call — Amplify Data has no "use the session if there is
 * one" default. Concretely:
 *   - Reads on Feature / FeatureItem / BaseItemCache carry a public
 *     `allow.publicApiKey().to(["read"])` rule, so the apiKey default is
 *     fine for the public feature page AND happens to still work for
 *     admin reads too.
 *   - Every WRITE on those three models, and every call on
 *     `BaseOAuthToken` (admin-only, no public rule at all), requires
 *     `allow.group("Admins")` — which only a `userPool`-mode call can
 *     satisfy. Use `adminAuthMode` below on all of those, or the call
 *     fails with an authorization error even for a signed-in admin.
 */
const cookieDataClient = generateServerClientUsingCookies<Schema>({
  config: outputs,
  cookies,
});

/**
 * 2026-09-03 追加指示 §5/§6: 未認証経路のための切り替え。
 *
 * ── 何のためか ──────────────────────────────────────────────────
 *
 * 上のクライアントは Cookie + userPool 認証なので、**ログイン中のユーザーが
 * いる前提**。LINE Webhook のような未認証POSTから呼ぶと AppSync に弾かれ、
 * `data` が null で返る(errors は握り潰されることがある)。実測で
 * ReplyDraft も NotificationDelivery も作られない状態になっていた。
 *
 * 呼び出し側は10以上のモジュールに散っていて、そのすべてがこの
 * `serverDataClient` を直接 import している。**1箇所で差し替えられる**ように
 * Proxy を挟み、`runWithDirectData()` の中でだけ DynamoDB 直結の実装
 * (lib/amplify/directData.ts)へ向ける。
 *
 * ── 既定の挙動は変えていない ────────────────────────────────────
 *
 * `runWithDirectData()` で明示的に囲まれていない限り、これまでと**完全に
 * 同じ**クライアントが返る。画面・Server Action の経路は一切影響を受けない。
 */
const directDataScope = new AsyncLocalStorage<{ direct: true }>();

/**
 * この中で行う `serverDataClient` の呼び出しを DynamoDB 直結へ向ける。
 *
 * 未認証の経路(LINE Webhook / メール取込 / 定期実行スクリプト)からのみ使う。
 * 認証済みの経路で使ってはいけない —— AppSyncの認可チェックを回さずに
 * 読み書きすることになる。
 */
export function runWithDirectData<T>(fn: () => Promise<T>): Promise<T> {
  return directDataScope.run({ direct: true }, fn);
}

/** いま直結モードか。ログや分岐の説明に使う。 */
export function isDirectDataMode(): boolean {
  return directDataScope.getStore()?.direct === true;
}

let directClientSingleton: { models: Record<string, unknown> } | null = null;

export const serverDataClient = new Proxy(cookieDataClient as object, {
  get(target, prop, receiver) {
    if (prop === "models" && directDataScope.getStore()?.direct) {
      if (!directClientSingleton) directClientSingleton = createDirectDataClient();
      return directClientSingleton.models;
    }
    return Reflect.get(target, prop, receiver);
  },
}) as typeof cookieDataClient;

/** Spread/pass as the options argument on any admin-only Amplify Data call — see the note above. */
export const adminAuthMode = { authMode: "userPool" } as const;

/**
 * Pass as the options argument on every Inventory-area Data call
 * (Inventory / Category / Location / StatusMaster / CustomFieldDefinition
 * / InventoryHistory) — never omit it and never fall back to the
 * schema's `apiKey` default for these models.
 *
 * Unlike `adminAuthMode` above (which happens to also work for public
 * Feature reads, since apiKey would too), Inventory models carry NO
 * `allow.publicApiKey()` rule at all — a call without an explicit
 * `authMode: "userPool"` doesn't silently fall back to a working apiKey
 * path, it is simply rejected. This constant exists as the one
 * call-site-visible spelling of that requirement, so a reviewer sees
 * `inventoryAuthMode` at every Inventory call and never has to wonder
 * whether it was left off by mistake.
 *
 * Same underlying value as `adminAuthMode` today — kept as a separate
 * export because the two model groups' authorization rules (Cognito
 * "Admins" vs. "ADMIN"/"EDITOR"/"VIEWER") are unrelated and evolving
 * either one's auth design independently should never require touching
 * call sites for the other.
 */
export const inventoryAuthMode = { authMode: "userPool" } as const;
