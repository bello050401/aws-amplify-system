import { suggestNextSku } from "@/domain/services/ProductService";
import { getDefaultCondition, getDefaultShippingFromStateId } from "@/domain/services/AppSettingsService";
import { ProductForm, type ProductFormInitial } from "@/components/products/ProductForm";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const [sku, condition, shippingFromStateId] = await Promise.all([
    suggestNextSku(),
    getDefaultCondition(),
    getDefaultShippingFromStateId(),
  ]);

  const initial: ProductFormInitial = {
    sku,
    name: "",
    description: "",
    price: 0,
    condition,
    categoryMappingId: null,
    brandMappingId: null,
    janCode: null,
    catalogId: null,
    shippingPayer: "SELLER",
    shippingFromStateId,
    shippingDurationCode: null,
    shippingTemplateId: null,
    stockQuantity: 1,
  };

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">商品登録</h1>
      <ProductForm mode="create" initial={initial} />
    </div>
  );
}
