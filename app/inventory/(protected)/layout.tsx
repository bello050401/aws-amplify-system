import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getInventorySessionStatus } from "@/lib/amplify/requireInventoryUser";
import { InventoryNavRail } from "../InventoryNavRail";
import { InventoryTopBar } from "../InventoryTopBar";

// The root layout (app/layout.tsx) sets title: "特集ページ" for the
// Feature system — there is only one <html>/<body> for the whole app, so
// every /inventory/* page inherited that title until this override.
// Per-segment metadata is the correct way to fix this without touching
// the Feature system's root layout at all.
export const metadata: Metadata = {
  title: "BELLO 在庫管理",
};

/**
 * Route-group layout covering everything under /inventory except
 * /inventory/login (a sibling outside this group — same reasoning as
 * app/admin/(protected)/layout.tsx: otherwise a signed-out visitor gets
 * bounced to a login page that itself redirects back, forever).
 */
export default async function ProtectedInventoryLayout({ children }: { children: React.ReactNode }) {
  const status = await getInventorySessionStatus();
  if (status.kind !== "authorized") {
    redirect(status.kind === "signed-in-not-authorized" ? "/inventory/login?error=not_authorized" : "/inventory/login");
  }

  return (
    <div className="flex h-screen bg-white text-gray-900">
      <InventoryNavRail />
      <div className="flex min-w-0 flex-1 flex-col">
        <InventoryTopBar role={status.role} />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
