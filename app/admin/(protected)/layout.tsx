import { redirect } from "next/navigation";
import { getSessionStatus } from "@/lib/amplify/requireAdmin";
import { AdminNav } from "../AdminNav";

/**
 * Route-group layout: covers /admin, /admin/search, /admin/features/*,
 * /admin/settings but NOT /admin/login (a sibling outside this group) —
 * otherwise a signed-out visitor hitting the auth check would be
 * redirected to a login page that itself redirects back to login, forever.
 */
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  const status = await getSessionStatus();
  if (status !== "admin") {
    // Carry the reason along so /admin/login can tell "not signed in" apart
    // from "signed in, but this account isn't in the Admins group" instead
    // of both looking like the exact same silent bounce back to the form.
    redirect(status === "signed-in-not-admin" ? "/admin/login?error=not_admin" : "/admin/login");
  }

  return (
    <div className="min-h-screen bg-white">
      <AdminNav />
      <div className="mx-auto max-w-content px-6 py-10">{children}</div>
    </div>
  );
}
