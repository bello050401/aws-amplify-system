import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "./serverUtils";

export type InventoryRole = "ADMIN" | "EDITOR" | "VIEWER";
const INVENTORY_ROLES: InventoryRole[] = ["ADMIN", "EDITOR", "VIEWER"];

export type InventorySessionStatus =
  | { kind: "authorized"; role: InventoryRole }
  | { kind: "signed-in-not-authorized" }
  | { kind: "signed-out" };

/**
 * Inventory's own version of lib/amplify/requireAdmin.ts's getSessionStatus
 * — deliberately a separate function, not a shared/generalized one, because
 * the two systems check membership in unrelated Cognito groups ("Admins"
 * vs. ADMIN/EDITOR/VIEWER) and must keep evolving independently (see the
 * comment in amplify/auth/resource.ts). A signed-in user can be in both
 * worlds' groups at once; each system only ever looks at its own.
 *
 * When a user belongs to more than one Inventory group (e.g. both ADMIN
 * and EDITOR), ADMIN wins — there is no scenario where a user should be
 * treated as less privileged than a group they actually hold.
 */
/**
 * 第五ラウンド§7/P1-A: Playwright E2E専用の、明示的opt-inかつ二重ゲート
 * 付きの認証bypass。
 *
 * 【安全設計、必ずこの順で読むこと】
 *   1. `process.env.NODE_ENV !== "production"`——AWS Amplify Hostingの
 *      SSRコンピュートはNext.jsの標準挙動により常にNODE_ENV=production
 *      で実行される(`next start`が強制する、Amplify Hosting固有の
 *      設定ではなくNext.js自体の挙動)。つまり実際にデプロイされた
 *      環境では、下の環境変数を誤って設定してもこの分岐は構造的に
 *      絶対に通らない——ここが最初かつ最強の防御線。
 *   2. `INVENTORY_E2E_AUTH_TOKEN`環境変数——16文字以上の秘密トークン。
 *      ローカルの`npm run test:e2e`(playwright.config.tsが`.env.test`
 *      相当から読む)だけが設定する。amplify.yml/Amplify Console環境
 *      変数には一切記載しない。
 *   3. さらにCookie(`__inv_e2e_role`)の値が`${role}:${token}`と完全
 *      一致する必要がある——tokenが未設定(=本番)ならこの比較は
 *      `undefined`との比較になり、どんなCookie値を攻撃者が設定しても
 *      絶対に一致しない。
 * 3つとも同時に成立しない限り、この関数は実Cognitoチェックへ
 * フォールスルーする——既存の認可ロジックには一切手を加えていない。
 */
function getE2EBypassRole(): InventoryRole | null {
  if (process.env.NODE_ENV === "production") return null;
  const token = process.env.INVENTORY_E2E_AUTH_TOKEN;
  if (!token || token.length < 16) return null;
  const raw = cookies().get("__inv_e2e_role")?.value;
  if (!raw) return null;
  const separatorIndex = raw.indexOf(":");
  if (separatorIndex < 0) return null;
  const role = raw.slice(0, separatorIndex);
  const suppliedToken = raw.slice(separatorIndex + 1);
  if (suppliedToken !== token) return null;
  return (INVENTORY_ROLES as string[]).includes(role) ? (role as InventoryRole) : null;
}

export async function getInventorySessionStatus(): Promise<InventorySessionStatus> {
  const bypassRole = getE2EBypassRole();
  if (bypassRole) return { kind: "authorized", role: bypassRole };
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        if (!session.tokens) return { kind: "signed-out" };
        const groups = (session.tokens.accessToken.payload["cognito:groups"] ?? []) as string[];
        const role = INVENTORY_ROLES.find((r) => groups.includes(r));
        return role ? { kind: "authorized", role } : { kind: "signed-in-not-authorized" };
      },
    });
  } catch {
    return { kind: "signed-out" };
  }
}

export async function getInventoryRole(): Promise<InventoryRole | null> {
  const status = await getInventorySessionStatus();
  return status.kind === "authorized" ? status.role : null;
}

export function canEditInventory(role: InventoryRole | null): boolean {
  return role === "ADMIN" || role === "EDITOR";
}

export function canHardDeleteInventory(role: InventoryRole | null): boolean {
  return role === "ADMIN";
}

/** Identity string for Inventory.createdBy/updatedBy and InventoryHistory.changedBy — email if the token carries one, else the Cognito sub, so a write is never silently attributed to "unknown". */
export async function getCurrentInventoryUserEmail(): Promise<string | null> {
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        if (!session.tokens) return null;
        const payload = session.tokens.idToken?.payload ?? session.tokens.accessToken.payload;
        return (payload.email as string | undefined) ?? (payload.sub as string | undefined) ?? null;
      },
    });
  } catch {
    return null;
  }
}

/** For use in Route Handlers, mirroring requireAdminOrRedirect in requireAdmin.ts. */
export async function requireInventoryUserOrRedirect(request: Request): Promise<NextResponse | null> {
  const status = await getInventorySessionStatus();
  if (status.kind === "authorized") return null;

  const url = new URL("/inventory/login", request.url);
  if (status.kind === "signed-in-not-authorized") url.searchParams.set("error", "not_authorized");
  return NextResponse.redirect(url);
}
