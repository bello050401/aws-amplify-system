import "server-only";
import { createAgentCoreSearchProvider } from "@/lib/inquiry/research/agentCoreProvider";
import { getAgentCoreGatewayUrl } from "@/lib/inquiry/research/service";
import type { ResearchSourceDocument } from "@/lib/inquiry/research/port";
import { officialDomainsForBrands } from "@/lib/inquiry/research/officialDomains";
import { createResearchCache } from "./researchCache";

type Reference = { fact: string; sourceUrl: string };
const reuseResearch = createResearchCache<Reference[]>();

export function selectProductReferences(documents: ResearchSourceDocument[], model: string, brand?: string | null): Reference[] {
  const escaped = model.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (model.trim().length < 3 || !brand?.trim()) return [];
  const matchModel = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu");
  const seenUrls = new Set<string>();
  return documents.filter(doc => !doc.injectionDetected && doc.sourceType !== "OTHER")
    .flatMap(doc => {
      // Keep only one bounded sentence containing both identifiers. Nearby
      // comparison rows and unrelated paragraphs are not product evidence.
      const sentence = doc.text.split(/(?<=[。.!?])\s+|[\r\n]+|(?<=。)/u).find(text =>
        text.length <= 400 && matchModel.test(text) && text.normalize("NFKC").toLowerCase().includes(brand.trim().normalize("NFKC").toLowerCase()));
      if (!sentence) return [];
      let url: URL;
      try { url = new URL(doc.url); } catch { return []; }
      if (!["https:", "http:"].includes(url.protocol)) return [];
      url.hash = "";
      if (seenUrls.has(url.href)) return [];
      seenUrls.add(url.href);
      return [{ fact: sentence.trim(), sourceUrl: doc.url }];
    }).slice(0, 2);
}

/** Reuse the configured search service; no new credentials or background polling. */
export async function researchProductIntroduction(brand: string | null, model: string | null): Promise<Reference[]> {
  const gatewayUrl = getAgentCoreGatewayUrl();
  if (!gatewayUrl || !brand?.trim() || !model || model.trim().length < 3) return [];
  const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const key = JSON.stringify([normalize(brand), normalize(model)]);
  return reuseResearch(key, async () => {
    const result = await createAgentCoreSearchProvider({ gatewayUrl, officialDomains: officialDomainsForBrands(brand ? [brand] : []) }).fetchDocuments({
      field: "デザイン 特徴 商品情報", queryText: [brand, model].filter(Boolean).join(" "),
      modelHints: [model.trim()], brandHints: brand ? [brand] : [],
    });
    if (result.status !== "OK") throw new Error("Product research unavailable");
    const references = selectProductReferences(result.documents, model, brand);
    return references;
  }, []);
}
