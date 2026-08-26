import type { BaseItem } from "@/lib/base";
import { ProductCard } from "./ProductCard";

interface ProductGridProps {
  items: BaseItem[];
  heading?: string;
}

export function ProductGrid({ items, heading = "ITEMS" }: ProductGridProps) {
  if (items.length === 0) return null;

  return (
    <section className="mx-auto max-w-content px-6 py-16 sm:py-24">
      <p className="text-xs uppercase tracking-label text-muted">{heading}</p>
      <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-10 sm:grid-cols-3 sm:gap-x-8 lg:grid-cols-4">
        {items.map((item) => (
          <ProductCard key={item.itemId} item={item} />
        ))}
      </div>
    </section>
  );
}
