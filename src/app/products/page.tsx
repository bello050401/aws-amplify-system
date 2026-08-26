import Link from "next/link";
import { listProducts } from "@/domain/services/ProductService";
import { ProductTable, type ProductRow } from "@/components/products/ProductTable";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const products = await listProducts();

  const rows: ProductRow[] = products.map((p) => ({
    id: p.id,
    sku: p.sku,
    name: p.name,
    price: p.price,
    condition: p.condition,
    internalStatus: p.internalStatus,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    images: p.images,
    mercariListing: p.mercariListing,
  }));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">商品一覧</h1>
        <Link href="/products/new" className="btn-primary">
          + 新規商品登録
        </Link>
      </div>
      <ProductTable products={rows} />
    </div>
  );
}
