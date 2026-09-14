import { AsyncLocalStorage } from "node:async_hooks";
import { cookies } from "next/headers";
import { generateServerClientUsingCookies } from "@aws-amplify/adapter-nextjs/data";
import type { Schema } from "@/amplify/data/resource";
import outputs from "@/amplify_outputs.json";
import { createDirectDataClient } from "./directData";
import { isQueryTimingEnabled, recordQuery } from "@/lib/perf/queryTiming";
import { isE2EFixtureModeActive } from "@/lib/inventory/e2eFixtures";

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

/**
 * QA隔離境界の診断(2026-09-14、task_9944d38b7e24f0afea 発案 / 2026-09-15
 * task_eb959e6dc9c6ac432f 統合時に是正)。
 *
 * E2E fixtureモード(isE2EFixtureModeActive)中に serverDataClient の呼び出しが
 * 実際に発生した記録——CSV候補の隔離QA(csv-isolated-own-e2e.log)で、
 * fixtureゲート済みのはずの経路の外側から`NoValidAuthTokens: No federated
 * jwt`が漏れていたため、原因経路を速やかに特定できるようにする目的で
 * 追加した。
 *
 * 【対象operationの範囲について — 統合時の是正】
 * 当初の実装(task_9944d38b7e24f0afea)は read系(list/get)だけを対象とし、
 * 「write系がfixture未対応のAWSスタブへ到達して失敗するのは既知・意図した
 * 挙動」という理由で write系(create/update/delete)を対象外にしていた。
 * これは誤り——**合成(E2E fixture)実行中に実SDKへ書き込みを試みること
 * 自体**が許容できない事象であり、「試みて失敗するから良い」という話では
 * ない。この統合では create/update/delete も対象に加え、fixtureモード中に
 * 書き込みが試みられた場合も同じ仕組みで検出・記録する(実際、CSV E2E ——
 * e2e/mercari-csv-image-download.spec.ts —— は書き込み系アクションを
 * 一切呼ばないため、この拡張は検出範囲を正しくするだけで、既存の挙動は
 * 変えない)。scripts/verify-e2e-boundary-spy.tsがread/write双方の対照で
 * これを検証する。
 *
 * 【本番負荷について — 統合時の是正】
 * 当初の実装は `models` を返す際、fixtureモードかどうかに関わらず常に
 * このProxyで包んでいた(本番でも同様)——isE2EFixtureModeActive()自体は
 * 本番で必ずfalseになるため実害(誤検出・誤ログ)は無かったが、
 * 「本番のあらゆるデータアクセスに常時Proxyが1段挟まる」という不要な
 * オーバーヘッド・複雑性が本番経路に残っていた。この統合では
 * isE2EFixtureModeActive()が真のときだけこのProxyを適用する——本番
 * (NODE_ENV==="production")では isE2EFixtureModeActive() の最初の条件で
 * 即falseになるため、このProxy自体が一切生成されず、元の(この診断を
 * 追加する前の)コードと全く同じオブジェクトがそのまま返る。
 */
export const e2eReadBoundaryLeaks: { model: string; op: string; stack: string }[] = [];

const E2E_BOUNDARY_OP_PATTERN = /^(get|list|create|update|delete)/;

function withE2EReadBoundarySpy(models: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(models, {
    get(target, modelName, receiver) {
      const model = Reflect.get(target, modelName, receiver);
      if (!model || typeof model !== "object" || typeof modelName !== "string") return model;
      return new Proxy(model as Record<string, unknown>, {
        get(m, opName, r) {
          const op = Reflect.get(m, opName, r);
          if (typeof op !== "function" || typeof opName !== "string" || !E2E_BOUNDARY_OP_PATTERN.test(opName)) return op;
          return (...args: unknown[]) => {
            if (isE2EFixtureModeActive()) {
              const stack = new Error(`[e2e-boundary-spy] ${modelName}.${opName}() reached the real serverDataClient while isE2EFixtureModeActive()`).stack ?? "";
              e2eReadBoundaryLeaks.push({ model: modelName, op: opName, stack });
              // 固定文言のみ — 商品名・トークン等の実データは一切含まない。
              console.error(`[lib/amplify/dataClient.ts] E2E fixture境界漏れ: ${modelName}.${opName}()が実serverDataClientへ到達しました`);
              console.error(stack);
            }
            return (op as (...a: unknown[]) => unknown).apply(m, args);
          };
        },
      });
    },
  });
}

let spiedCookieModels: Record<string, unknown> | null = null;
let spiedTimedCookieModels: Record<string, unknown> | null = null;

export const serverDataClient = new Proxy(cookieDataClient as object, {
  get(target, prop, receiver) {
    if (prop === "models" && (directDataScope.getStore()?.direct || isDevDirectDataEnabled())) {
      if (!directClientSingleton) directClientSingleton = createDirectDataClient();
      if (!timedDirectModels) timedDirectModels = withTiming(directClientSingleton.models);
      return timedDirectModels;
    }
    if (prop === "models" && isQueryTimingEnabled()) {
      if (isE2EFixtureModeActive()) {
        if (!spiedTimedCookieModels) {
          spiedTimedCookieModels = withTiming(withE2EReadBoundarySpy(Reflect.get(target, prop, receiver) as Record<string, unknown>));
        }
        return spiedTimedCookieModels;
      }
      if (!timedCookieModels) {
        timedCookieModels = withTiming(Reflect.get(target, prop, receiver) as Record<string, unknown>);
      }
      return timedCookieModels;
    }
    if (prop === "models" && isE2EFixtureModeActive()) {
      if (!spiedCookieModels) {
        spiedCookieModels = withE2EReadBoundarySpy(Reflect.get(target, prop, receiver) as Record<string, unknown>);
      }
      return spiedCookieModels;
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
