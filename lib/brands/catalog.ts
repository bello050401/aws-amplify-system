import "server-only";
import catalog from "./catalog.generated.json";

export type BrandEntry = (typeof catalog)[number];

function normalizeBrandKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

export function findBrandByName(name: string | null | undefined): BrandEntry | null {
  const key = name ? normalizeBrandKey(name) : "";
  if (!key) return null;
  return catalog.find((brand) => normalizeBrandKey(brand.name) === key)
    ?? catalog.find((brand) => normalizeBrandKey(brand.reading) === key)
    ?? null;
}

export function searchBrands(query: string, limit = 20): Pick<BrandEntry, "id" | "name" | "reading">[] {
  const key = query.trim().toLocaleLowerCase();
  if (!key) return [];
  return catalog
    .filter((brand) => brand.name.toLocaleLowerCase().includes(key) || brand.reading.toLocaleLowerCase().includes(key))
    .slice(0, limit)
    .map(({ id, name, reading }) => ({ id, name, reading }));
}
