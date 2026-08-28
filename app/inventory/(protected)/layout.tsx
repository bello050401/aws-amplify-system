import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getInventorySessionStatus } from "@/lib/amplify/requireInventoryUser";
import { InventoryNavRail } from "../InventoryNavRail";
import { UnsavedChangesProvider } from "../UnsavedChangesProvider";

// The root layout (app/layout.tsx) sets title: "特集ページ" for the
// Feature system — there is only one <html>/<body> for the whole app, so
// every /inventory/* page inherited that title until this override.
// Per-segment metadata is the correct way to fix this without touching
// the Feature system's root layout at all.
export const metadata: Metadata = {
  title: "BELLO 在庫管理",
  // BELLO SYSTEM's icon (Phase C.5 §12/§13) — the root layout
  // (app/layout.tsx) sets no icons at all, so this doesn't override or
  // conflict with anything the Feature side relies on; a browser just
  // gets a normal 404 for the favicon request until the file is placed
  // at public/bello-system-icon.png, same graceful-absence behavior as
  // BelloLogo.tsx.
  icons: { icon: "/bello-system-icon.png" },
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
    // UnsavedChangesProvider wraps the whole route group (NavRail
    // included) — the logo/nav-item guardedNavigate calls in NavRail and
    // the dirty-tracking registration in /new and /[id]/edit's forms
    // must share exactly one instance of this context (see that file's
    // own comment). children stays a Server Component tree; wrapping it
    // in this Client Component provider doesn't change that.
    <UnsavedChangesProvider>
      <div className="flex h-screen bg-white text-gray-900">
        <InventoryNavRail />
        {/* Each page renders its own InventoryHeader (spec O/P/Q — see
            that component's file comment for why this replaced a single
            shared layout-level header bar) as the first child of this
            column, so it's not duplicated here. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>
    </UnsavedChangesProvider>
  );
}
