import Image from "next/image";
import type { BaseItem } from "@/lib/base";
import { deriveVariationLabel, longestCommonTitlePrefix } from "@/lib/ai/templateHeuristic";

interface ColorVariationProps {
  items: BaseItem[];
  notes?: string;
}

const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY" });

/**
 * Only meaningful for a COLLECTION (same model, different color/spec) —
 * the page decides whether to render this section, not this component.
 * Labels are derived from the titles themselves (see deriveVariationLabel),
 * never guessed, per spec §11 ("色名についてもBASE情報にない場合はAIで断定しないでください").
 */
export function ColorVariation({ items, notes }: ColorVariationProps) {
  if (items.length < 2) return null;
  const commonPrefix = longestCommonTitlePrefix(items.map((i) => i.title));

  return (
    <section className="bg-stone px-6 py-16 sm:py-24">
      <div className="mx-auto max-w-content">
        <p className="text-xs uppercase tracking-label text-muted">Color Variation</p>
        {notes && <p className="mt-3 max-w-2xl text-sm font-light text-ink">{notes}</p>}

        <div className="mt-10 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-4 lg:grid-cols-8">
          {items.map((item) => {
            const label = deriveVariationLabel(item.title, commonPrefix) || item.title;
            const soldOut = item.stock <= 0;
            return (
              <a key={item.itemId} href={item.itemUrl} target="_blank" rel="noopener noreferrer" className="group block">
                <div className="relative aspect-square overflow-hidden bg-white">
                  {item.images[0] && (
                    <Image
                      src={item.images[0].url}
                      alt={label}
                      fill
                      sizes="(min-width: 1024px) 12vw, 25vw"
                      className={`object-cover ${soldOut ? "opacity-40 grayscale" : ""}`}
                    />
                  )}
                </div>
                <p className="mt-2 text-xs text-ink">{label}</p>
                <p className="text-xs font-light text-muted">
                  {soldOut ? "Sold Out" : yen.format(item.price)}
                </p>
              </a>
            );
          })}
        </div>
      </div>
    </section>
  );
}
