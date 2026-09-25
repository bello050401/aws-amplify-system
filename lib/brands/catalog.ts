import "server-only";
import catalog from "./catalog.generated.json";

export type BrandEntry = (typeof catalog)[number];

export function findBrandByName(name: string | null | undefined): BrandEntry | null {
  const key = name?.trim().toLocaleLowerCase();
  return key ? catalog.find((brand) => brand.name.toLocaleLowerCase() === key) ?? null : null;
}

export function searchBrands(query: string, limit = 20): Pick<BrandEntry, "id" | "name" | "reading">[] {
  const key = query.trim().toLocaleLowerCase();
  if (!key) return [];
  return catalog
    .filter((brand) => brand.name.toLocaleLowerCase().includes(key) || brand.reading.toLocaleLowerCase().includes(key))
    .slice(0, limit)
    .map(({ id, name, reading }) => ({ id, name, reading }));
}
