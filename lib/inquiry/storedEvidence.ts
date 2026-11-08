import type { ReplyEvidence } from './types';

/** Old drafts predate the current evidence schema. Keep their readable facts,
 * but never manufacture the fresh proof required for customer delivery. */
export function storedReplyEvidence(value: unknown): ReplyEvidence | null {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const arrays = ['productCandidates','inventoryFieldsUsed','knowledgeDocuments','externalFacts','unresolvedFacts'] as const;
  const normalized: Record<string, unknown> = {...row};
  let complete = arrays.every(key => Array.isArray(row[key]));
  for (const key of arrays) normalized[key] = Array.isArray(row[key]) ? row[key] : [];
  normalized.productCandidates = (normalized.productCandidates as unknown[]).filter(item=>{
    const p = item as Record<string, unknown> | null;
    const valid = !!p && typeof p === 'object' && typeof p.inventoryId === 'string' &&
      typeof p.name === 'string' && Array.isArray(p.reasons) && p.reasons.every(r=>typeof r==='string');
    if(!valid)complete=false;
    return valid;
  });
  normalized.externalFacts = (normalized.externalFacts as unknown[]).filter(item=>{
    const valid = !!item && typeof item === 'object' && typeof (item as Record<string,unknown>).field === 'string';
    if(!valid)complete=false;
    return valid;
  });
  if (!complete) delete normalized.runtimeProof;
  return normalized as unknown as ReplyEvidence;
}
