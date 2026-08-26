import { notFound } from "next/navigation";
import { getProductDetail } from "@/domain/services/ProductService";
import { ProductForm, type ProductFormInitial } from "@/components/products/ProductForm";
import { ListingPreviewDialog } from "@/components/products/ListingPreviewDialog";
import { ProductStatusBadge } from "@/components/products/ProductStatusBadge";
import { conditionLabel } from "@/integrations/mercari-shops/mapper/condition";
import { shippingPayerLabel } from "@/integrations/mercari-shops/mapper/shippingPayer";
import { shippingDurationLabel } from "@/integrations/mercari-shops/mapper/shippingDuration";
import { formatDateTime } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProductDetail(id);
  if (!product) notFound();

  const initial: ProductFormInitial = {
    id: product.id,
    sku: product.sku,
    name: product.name,
    description: product.description,
    price: product.price,
    condition: product.condition,
    categoryMappingId: product.categoryMappingId,
    categoryPath: product.categoryMapping?.path ?? null,
    brandMappingId: product.brandMappingId,
    brandName: product.brandMapping?.name ?? null,
    janCode: product.janCode,
    catalogId: product.catalogId,
    shippingPayer: product.shippingPayer,
    shippingFromStateId: product.shippingFromStateId,
    shippingDurationCode: product.shippingDurationCode,
    shippingTemplateId: product.shippingTemplateId,
    stockQuantity: product.variants[0]?.stockQuantity ?? 1,
    images: product.images,
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">{product.name || "(無題の商品)"}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            <span className="font-mono">{product.sku}</span>
            <ProductStatusBadge status={product.internalStatus} />
            {product.mercariListing?.mercariProductId && (
              <span>Mercari Product ID: {product.mercariListing.mercariProductId}</span>
            )}
          </div>
        </div>
        <ListingPreviewDialog
          productId={product.id}
          summary={{
            name: product.name,
            price: product.price,
            conditionLabel: conditionLabel(product.condition),
            categoryPath: product.categoryMapping?.path ?? null,
            brandName: product.brandMapping?.name ?? null,
            shippingPayerLabel: shippingPayerLabel(product.shippingPayer),
            shippingDurationLabel: product.shippingDurationCode
              ? shippingDurationLabel(product.shippingDurationCode)
              : null,
            imageCount: product.images.length,
          }}
        />
      </div>

      {product.mercariListing?.lastError && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          直近のMercari APIエラー: {product.mercariListing.lastError}
        </div>
      )}

      <ProductForm mode="edit" initial={initial} />

      <div className="card p-5">
        <h2 className="section-title mb-3">APIログ（直近20件）</h2>
        <ul className="space-y-1.5 text-xs">
          {product.integrationLogs.map((log) => (
            <li key={log.id} className={log.level === "ERROR" ? "text-red-600" : "text-slate-600"}>
              [{formatDateTime(log.createdAt)}] {log.message}
              {log.errorMessage ? `: ${log.errorMessage}` : ""}
            </li>
          ))}
          {product.integrationLogs.length === 0 && (
            <li className="text-slate-400">まだログはありません。</li>
          )}
        </ul>
      </div>
    </div>
  );
}
