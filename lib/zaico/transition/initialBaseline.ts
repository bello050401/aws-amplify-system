import type { BelloCurrentValues, FieldConflict, MergeResult, ZaicoProposedValues } from '../../inventory/zaicoSyncMerge';
import { HUMAN_EDITED_FIELDS, humanEditedFields } from '../../inventory/humanEdits';
import { valuesEqual } from '../../inventory/zaicoUpdatePolicy';

/**
 * Bootstrap is intentionally not a two-way merge: existing BELLO differences
 * must never become outbound changes merely because integration was enabled.
 * The caller must durably archive the original inventory before applying this.
 * Only fields actually supplied by the upstream mapper belong to this baseline.
 */
export function buildZaicoAuthoritativeBaseline(zaico: ZaicoProposedValues, bello: BelloCurrentValues): MergeResult {
  const updates: Record<string, unknown> = {};
  const extendedFields: Record<string, unknown> = {};
  const customFields = { ...bello.customFields };
  const baseline: Record<string, unknown> = {};
  const differences: FieldConflict[] = [];
  const edited = humanEditedFields(bello.customFields);
  const accept = (key: string, incoming: unknown, current: unknown, sink: Record<string, unknown>, outputKey = key) => {
    if (incoming === undefined) return; // missing is not a request to erase
    if (!valuesEqual(incoming, current)) {
      sink[outputKey] = incoming;
      differences.push({field:key,label:key,belloValue:current,zaicoValue:incoming,
        reason:'初回同期のためZAICOを優先。変更前のBELLO値はバックアップに保持。'});
    }
    edited.delete(key);
  };
  for (const [field, value] of Object.entries(zaico)) {
    if (field==='extendedFields'||field==='customFields'||value===undefined) continue;
    if (field==='categoryId' && zaico.categoryIds!==undefined) continue;
    accept(field,value,bello[field as keyof BelloCurrentValues],updates);
    baseline[field]=value;
  }
  if (zaico.categoryIds!==undefined) {
    // Primary category is a compatibility projection of the multi-select.
    updates.categoryId=zaico.categoryIds[0]??null;
    baseline.categoryId=updates.categoryId;
    edited.delete('categoryId');
  }
  for (const [field,value] of Object.entries(zaico.extendedFields)) {
    if (value===undefined) continue;
    accept(field,value,bello.extendedFields[field],extendedFields);
    baseline[field]=value;
  }
  const upstreamCustom:Record<string,unknown>={};
  for (const [key,value] of Object.entries(zaico.customFields)) {
    // Internal shipping, image and edit metadata never belongs to ZAICO.
    if (key.startsWith('__')||value===undefined) continue;
    accept(`customFields.${key}`,value,bello.customFields[key],customFields,key);
    upstreamCustom[key]=value;
  }
  if (HUMAN_EDITED_FIELDS in customFields) customFields[HUMAN_EDITED_FIELDS]=[...edited].sort();
  baseline.__customFields=upstreamCustom;
  return {updates,extendedFields,customFields,skipped:[],conflicts:[],
    nextSnapshotJson:JSON.stringify(baseline),hasChanges:true,mode:'ZAICO_BASELINE',
    writesBusinessValues:true,baselineDifferences:differences};
}
