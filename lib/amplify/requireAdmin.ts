import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "./serverUtils";

/** Shared by the (protected) admin layout and any Route Handler that needs the same gate. */
export async function isAdmin(): Promise<boolean> {
  try {
    return await runWithAmplifyServerContext({
      nextServerContext: { cookies },
      operation: async (contextSpec) => {
        const session = await fetchAuthSession(contextSpec);
        const groups = (session.tokens?.accessToken?.payload["cognito:groups"] ?? []) as string[];
        return groups.includes("Admins");
      },
    });
  } catch {
    return false;
  }
}

/** For use in Route Handlers (which don't get the page-level layout's redirect for free). */
export async function requireAdminOrRedirect(request: Request): Promise<NextResponse | null> {
  if (await isAdmin()) return null;
  return NextResponse.redirect(new URL("/admin/login", request.url));
}
