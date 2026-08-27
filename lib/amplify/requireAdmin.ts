import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "./serverUtils";

export type SessionStatus = "admin" | "signed-in-not-admin" | "signed-out";

/**
 * Distinguishes "no session" from "a real, valid session that just isn't in
 * the Admins group" — these look identical as a boolean and, before this,
 * produced the exact same silent bounce back to /admin/login either way,
 * which made a missing group membership indistinguishable from not being
 * signed in at all. Both the layout and the login page use this now so
 * that case says what it is instead of just failing quietly.
 */
export async function getSessionStatus(): Promise<SessionStatus> {
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        if (!session.tokens) return "signed-out";
        const groups = (session.tokens.accessToken.payload["cognito:groups"] ?? []) as string[];
        return groups.includes("Admins") ? "admin" : "signed-in-not-admin";
      },
    });
  } catch {
    return "signed-out";
  }
}

/** Shared by the (protected) admin layout and any Route Handler that needs the same gate. */
export async function isAdmin(): Promise<boolean> {
  return (await getSessionStatus()) === "admin";
}

/** For use in Route Handlers (which don't get the page-level layout's redirect for free). */
export async function requireAdminOrRedirect(request: Request): Promise<NextResponse | null> {
  const status = await getSessionStatus();
  if (status === "admin") return null;

  const url = new URL("/admin/login", request.url);
  if (status === "signed-in-not-admin") url.searchParams.set("error", "not_admin");
  return NextResponse.redirect(url);
}
