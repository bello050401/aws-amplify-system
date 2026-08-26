import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { fetchAuthSession } from "aws-amplify/auth/server";
import { runWithAmplifyServerContext } from "@/lib/amplify/serverUtils";
import { AdminNav } from "../AdminNav";

async function isAdmin(): Promise<boolean> {
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

/**
 * Route-group layout: covers /admin, /admin/search, /admin/features/* but
 * NOT /admin/login (a sibling outside this group) — otherwise a signed-out
 * visitor hitting the auth check would be redirected to a login page that
 * itself redirects back to login, forever.
 */
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await isAdmin();
  if (!admin) redirect("/admin/login");

  return (
    <div className="min-h-screen bg-white">
      <AdminNav />
      <div className="mx-auto max-w-content px-6 py-10">{children}</div>
    </div>
  );
}
