import Image from "next/image";
import type { BaseItem } from "@/lib/base";

interface ProductCardProps {
  item: BaseItem;
  /** Optional label pulled from BASE variation data — never invented client-side. */
  variationLabel?: string;
}

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });

export function ProductCard({ item, variationLabel }: ProductCardProps) {
  const soldOut = item.stock <= 0;

  return (
    <a
      href={item.itemUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="group block"
    >
      <div className="relative aspect-square overflow-hidden bg-stone">
        {item.images[0] && (
          <Image
            src={item.images[0].url}
            alt={item.title}
            fill
            sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw"
            className={`object-cover transition-opacity duration-300 group-hover:opacity-90 ${
              soldOut ? "opacity-40 grayscale" : ""
            }`}
          />
        )}
        {soldOut && (
          <span className="absolute left-3 top-3 bg-ink px-2 py-1 text-[10px] uppercase tracking-label text-white">
            Sold Out
          </span>
        )}
      </div>
      <div className="mt-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-normal text-ink">{item.title}</p>
          {variationLabel && <p className="mt-0.5 text-xs text-muted">{variationLabel}</p>}
        </div>
        <p className="whitespace-nowrap text-sm font-light text-ink">{yen.format(item.price)}</p>
      </div>
      <p className="mt-1 text-xs uppercase tracking-label text-muted group-hover:text-ink">
        商品を見る →
      </p>
    </a>
  );
}
