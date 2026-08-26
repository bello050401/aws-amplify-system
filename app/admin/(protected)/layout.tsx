import { redirect } from "next/navigation";
import { isAdmin } from "@/lib/amplify/requireAdmin";
import { AdminNav } from "../AdminNav";

/**
 * Route-group layout: covers /admin, /admin/search, /admin/features/*,
 * /admin/settings but NOT /admin/login (a sibling outside this group) —
 * otherwise a signed-out visitor hitting the auth check would be
 * redirected to a login page that itself redirects back to login, forever.
 */
export default async function ProtectedAdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAdmin())) redirect("/admin/login");

  return (
    <div className="min-h-screen bg-white">
      <AdminNav />
      <div className="mx-auto max-w-content px-6 py-10">{children}</div>
    </div>
  );
}
