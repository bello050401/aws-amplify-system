import "server-only";
import type { FeatureCopy } from "@/lib/ai/types";

export type FeatureContent = Omit<FeatureCopy, "title" | "slug" | "seoTitle" | "seoDescription">;

/**
 * `Feature.content` is an `a.json()` (AWSJSON) field. AWSJSON is a
 * JSON-*string* scalar on the wire — AppSync describes it as "a JSON
 * string [that is] automatically parsed and loaded [server-side]" — but
 * Amplify Data's generated TypeScript type for `a.json()` (`Json = null |
 * string | number | boolean | object | any[]`, see
 * `@aws-amplify/data-schema`'s `ModelField.ts`) is more permissive than
 * what a *write* actually accepts, which reads as if handing it a plain
 * JS object should just work. It doesn't: sending a raw object here fails
 * the mutation with `Variable 'content' has an invalid value.` — this
 * matches a long-standing, still-open class of Amplify Data issues (e.g.
 * aws-amplify/amplify-js#13298, aws-amplify/amplify-data#474) where the
 * generated types accept a JS shape the wire format then rejects. The fix
 * is to send an actual JSON string ourselves on every write.
 */
export function stringifyFeatureContent(content: FeatureContent): string {
  return JSON.stringify(content);
}

/**
 * Reverse of stringifyFeatureContent(), for reads. Tolerates either a
 * JSON string (the shape we now always write) or an already-parsed
 * object (AWSJSON reads have been observed to come back already parsed
 * in some Amplify Data versions) rather than assuming one — a read-side
 * mismatch should degrade to `null` (rendered as "not generated yet"),
 * never throw and break the whole page.
 */
export function parseFeatureContent(raw: unknown): FeatureContent | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as FeatureContent;
    } catch (err) {
      console.error("[Feature.content] failed to JSON.parse stored content:", raw, err);
      return null;
    }
  }
  return raw as FeatureContent;
}
