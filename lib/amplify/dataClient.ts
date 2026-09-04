import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { generateServerClientUsingCookies } from "@aws-amplify/adapter-nextjs/data";
import type { Schema } from "@/amplify/data/resource";
import outputs from "@/amplify_outputs.json";
import { createDirectDataClient } from "./directData";
import { isQueryTimingEnabled, recordQuery } from "@/lib/perf/queryTiming";

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

/**
 * 開発機で「実データのまま画面を描画して計測する」ための切り替え
 * (2026-09-04 性能総点検)。
 *
 * ── なぜ必要になったか ──────────────────────────────────────────
 *
 * ログイン済みの画面を実測したいが、AppSync は Cognito のセッションを
 * 要求する。開発機の認証バイパス(INVENTORY_E2E_AUTH_TOKEN)は
 * アプリ側の認可判定だけを通すもので、AppSync のトークンは作れない
 * (実際に `NoValidAuthTokens` で落ちる)。E2E fixture へ切り替えると
 * 今度は**データ量が実物と違う**ので、性能の計測には使えない。
 *
 * そこで、開発機に限って読み書きを DynamoDB 直結へ向ける口を用意する。
 * 実データ・実件数のまま、画面の往復回数と直列/並列の構造をそのまま
 * 測れる。AppSync の往復ぶんは載らないので、そこは別に見積もる。
 *
 * ── 本番では絶対に効かない ──────────────────────────────────────
 *
 * `NODE_ENV !== "production"` と専用の環境変数の**二重ゲート**。
 * E2E fixture と同じ形にしてある(lib/inventory/e2eFixtures.ts)。
 * Amplify Console にはこの変数を置かない。
 */
export function isDevDirectDataEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.BELLO_DEV_DIRECT_DATA === "1";
}

/** いま直結モードか。ログや分岐の説明に使う。 */
export function isDirectDataMode(): boolean {
  return directDataScope.getStore()?.direct === true || isDevDirectDataEnabled();
}

let directClientSingleton: { models: Record<string, unknown> } | null = null;

/**
 * 2026-09-04 性能総点検 §12: データアクセスを1本ずつ計測する。
 *
 * ── なぜここで包むのか ──────────────────────────────────────────
 *
 * 画面のデータアクセスは例外なくこの `models` を通る。ここを包めば、
 * 今後どんな画面が増えても自動的に計測に乗る —— 画面ごとに計測コードを
 * 書く形にすると、新しい画面には付いてこない(それでは「遅くなったことを
 * 検知する」という目的を果たさない)。
 *
 * ── 何も変えない ────────────────────────────────────────────────
 *
 * 計測が無効(既定)なら、包んだ関数はそのまま元の関数を呼ぶだけ。
 * 戻り値も例外も引数も一切変わらない。有効時も、記録するのは
 * **モデル名・操作名・所要時間・件数**だけで、条件や結果は持たない。
 */
function withTiming(models: Record<string, unknown>): Record<string, unknown> {
  if (!isQueryTimingEnabled()) return models;
  return new Proxy(models, {
    get(target, modelName, receiver) {
      const model = Reflect.get(target, modelName, receiver);
      if (!model || typeof model !== "object" || typeof modelName !== "string") return model;
      return new Proxy(model as Record<string, unknown>, {
        get(m, opName, r) {
          const op = Reflect.get(m, opName, r);
          if (typeof op !== "function" || typeof opName !== "string") return op;
          return (...args: unknown[]) => {
            const started = performance.now();
            const out = (op as (...a: unknown[]) => unknown).apply(m, args);
            if (!(out instanceof Promise)) return out;
            return out.then(
              (value) => {
                const data = (value as { data?: unknown } | null)?.data;
                recordQuery({
                  model: modelName,
                  op: opName,
                  ms: performance.now() - started,
                  items: Array.isArray(data) ? data.length : data ? 1 : 0,
                });
                return value;
              },
              (err) => {
                // 失敗も記録する。失敗が遅いのか、そもそも呼ばれていないのかは別物。
                recordQuery({ model: modelName, op: opName, ms: performance.now() - started, items: null });
                throw err;
              },
            );
          };
        },
      });
    },
  });
}

let timedCookieModels: Record<string, unknown> | null = null;
let timedDirectModels: Record<string, unknown> | null = null;

export const serverDataClient = new Proxy(cookieDataClient as object, {
  get(target, prop, receiver) {
    if (prop === "models" && (directDataScope.getStore()?.direct || isDevDirectDataEnabled())) {
      if (!directClientSingleton) directClientSingleton = createDirectDataClient();
      if (!timedDirectModels) timedDirectModels = withTiming(directClientSingleton.models);
      return timedDirectModels;
    }
    if (prop === "models" && isQueryTimingEnabled()) {
      if (!timedCookieModels) {
        timedCookieModels = withTiming(Reflect.get(target, prop, receiver) as Record<string, unknown>);
      }
      return timedCookieModels;
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
