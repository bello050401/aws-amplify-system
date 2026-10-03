import Link from "next/link";
import { notFound } from "next/navigation";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { InventoryHeader } from "../../InventoryHeader";
import { MercariExistingReadPanel } from "./MercariExistingReadPanel";

export const metadata = { title: "メルカリShops既存商品照合 | BELLO" };

export default async function MercariBridgePage({ searchParams }: {
  searchParams: { inventoryId?: string; requestId?: string };
}) {
  const role = await getInventoryRole();
  if (role !== "ADMIN") notFound();
  const inventoryId = typeof searchParams.inventoryId === "string" ? searchParams.inventoryId : "";
  const requestId = typeof searchParams.requestId === "string" && /^[a-f0-9]{64}$/.test(searchParams.requestId)
    ? searchParams.requestId : "";
  return (
    <div className="flex h-full flex-col">
      <InventoryHeader role={role} center={<h1 className="text-base font-bold">メルカリShops既存商品照合</h1>} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-xl space-y-4">
          <Link href={inventoryId ? `/inventory/${encodeURIComponent(inventoryId)}/listing` : "/inventory"}
            className="text-sm text-blue-700 underline">← BELLOに戻る</Link>
          <MercariExistingReadPanel inventoryId={inventoryId} initialRequestId={requestId} />
        </div>
      </div>
    </div>
  );
}
