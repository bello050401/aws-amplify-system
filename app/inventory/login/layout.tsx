import type { Metadata } from "next";

// page.tsx here is a "use client" component (it needs signIn()/useState/
// useEffect), and a client component can't export `metadata` itself — a
// thin server layout is the standard way to still set a per-segment title.
export const metadata: Metadata = {
  title: "BELLO 在庫管理 - ログイン",
};

export default function InventoryLoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
