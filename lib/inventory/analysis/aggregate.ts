import { buildInventoryValue, selectInventoryValueRow } from '../inventoryValue';
import { fields, hasEvidence, imageReference, importedLot, integer, nonnegative, positive, productCategories, quantityBand, quantityClass, readSources, sourceKey, text } from './normalize';
import { jstDay, recordedDay, rollingPeriod, shiftDay, sourceDay } from './period';
import { normalizedCapturedSalesRecords } from './salesProjection';
import { ANALYSIS_VERSION, UNKNOWN, type AcquisitionLot, type AnalysisBuild, type AnalysisSource, type Fact, type InventoryMetadata, type MetadataRow, type ProductKind } from './types';

const SALES_START = '2026-01-01';
const CLOSED_WORKFLOWS = new Set(['売り切れ', '発送完了', '出荷指示済', '出荷指示済み', '発送済み']);
const EXCLUDED_MARKETS = new Set(['トレファク業者間', 'リステージ業者間', 'バッタヤライブ', '業販', '社員販売', 'SNS', 'SNS用途', '雑収入']);

interface Assignment { category: string; kindId: string | null }
interface LotOrigin { lot: AcquisitionLot; date: string }

function metadataIndex(rows: readonly MetadataRow[]) {
  const seen = new Set<string>();
  const versions = new Map<string, number>();
  const inventory = new Map<string, InventoryMetadata>();
  const kinds = new Map<string, ProductKind>();
  const lots = new Map<string, AcquisitionLot>();
  for (const row of rows) {
    if (!text(row.id) || !positive(row.revision) || seen.has(row.id)) throw new Error('INVALID_ANALYSIS_METADATA');
    seen.add(row.id);
    const value = row.value;
    switch (value.type) {
      case 'taxonomy':
        versions.set(row.id, row.revision);
        break;
      case 'inventory':
        if (!text(value.inventoryId) || inventory.has(value.inventoryId)) throw new Error('DUPLICATE_ANALYSIS_ASSIGNMENT');
        inventory.set(value.inventoryId, value);
        break;
      case 'kind':
        if (!text(value.id) || kinds.has(value.id)) throw new Error('DUPLICATE_ANALYSIS_KIND');
        kinds.set(value.id, value);
        break;
      case 'lot':
        if (!text(value.source) || !text(value.sourceRecordId) || value.id !== sourceKey(value.source, value.sourceRecordId) || lots.has(value.id)) {
          throw new Error('INVALID_ANALYSIS_LOT_ID');
        }
        lots.set(value.id, value);
        break;
      default:
        throw new Error('INVALID_ANALYSIS_METADATA');
    }
  }
  return { versions, inventory, kinds, lots };
}

function fact(input: {
  id: string; row?: AnalysisSource; date: string | null; assignment: Assignment;
  lot?: AcquisitionLot; holding?: number; amount: number | null; quantity: number | null;
  title?: string; unknownChannel?: boolean; unknownOrigin?: boolean; missingCost?: boolean; countsLot?: boolean;
}): Fact {
  const { id, row, date, assignment, lot, holding = null, amount, quantity } = input;
  const { category, kindId } = assignment;
  const lotQuantity = positive(lot?.quantity);
  return {
    id, inventoryId: row?.id ?? null, title: row?.name?.trim() || input.title || row?.sku || '商品名未登録',
    imageRef: row ? imageReference(row) : null,
    date, category, kindId, holding: quantityClass(holding), holdingBand: quantityBand(holding),
    lot: quantityClass(lotQuantity), lotBand: quantityBand(lotQuantity), lotId: lot?.id ?? null,
    amount, quantity, kindCount: kindId ? 1 : 0,
    lotCount: lot && input.countsLot !== false ? 1 : 0,
    unknown: {
      amount: Number(amount === null), cost: Number(input.missingCost ?? (amount === null)), quantity: Number(quantity === null),
      category: Number(category === UNKNOWN), kind: Number(kindId === null),
      lot: Number(lotQuantity === null), channel: Number(input.unknownChannel ?? false),
      origin: Number(input.unknownOrigin ?? !lot), date: Number(date === null),
    },
  };
}

function saleQuantity(custom: Record<string, unknown>, meta?: InventoryMetadata): number | null {
  const source = positive(fields(custom.__belloSale)?.physicalQuantity);
  const confirmed = hasEvidence(meta?.salesQuantityEvidence) ? positive(meta?.salesQuantity) : null;
  if (source !== null && confirmed !== null && source !== confirmed) return null;
  return confirmed ?? source;
}

function equalImporterLine(a: LotOrigin, b: LotOrigin): boolean {
  return a.date === b.date && a.lot.merchandise === b.lot.merchandise && a.lot.quantity === b.lot.quantity && a.lot.costTotal === b.lot.costTotal;
}

export function buildAnalysis(
  rows: readonly AnalysisSource[],
  workflowCategories: readonly { id: string; name: string }[],
  metadataRows: readonly MetadataRow[],
  asOf: string,
  generation: string,
): AnalysisBuild {
  const today = jstDay(asOf);
  if (!text(generation)) throw new Error('INVALID_ANALYSIS_GENERATION');
  const coverageStart = today < SALES_START ? shiftDay(today, -89) : SALES_START;
  const acquisitionPeriod = rollingPeriod(asOf, 30);
  const referencePeriod = rollingPeriod(asOf, 90);
  const inventoryValue = buildInventoryValue(rows, workflowCategories, asOf);
  const masters = new Map(workflowCategories.map(category => [category.id, category.name]));
  const metadata = metadataIndex(metadataRows);
  const taxonomy = productCategories(metadataRows);
  const sources = readSources(rows);

  const lotCandidates = new Map<string, LotOrigin>();
  const ambiguousLots = new Set<string>();
  const lotByRoot = new Map<string, string>();
  for (const row of rows) {
    if (row.deletedAt || sources.roots.get(row.id) !== row.id) continue;
    const imported = importedLot(row, sources.custom.get(row.id)!, asOf);
    const nonMerchandise = selectInventoryValueRow(row, masters).labels.includes('事務所備品');
    const lot = imported && { ...imported, merchandise: !nonMerchandise };
    if (!lot) continue;
    lotByRoot.set(row.id, lot.id);
    const next = { lot, date: lot.date };
    const previous = lotCandidates.get(lot.id);
    if (previous && !equalImporterLine(previous, next)) ambiguousLots.add(lot.id);
    else lotCandidates.set(lot.id, previous ?? next);
  }
  for (const id of ambiguousLots) lotCandidates.delete(id);
  for (const [id, lot] of metadata.lots) {
    if (lot.state !== 'confirmed') continue;
    const date = sourceDay(lot.date, asOf);
    if (!date) {
      lotCandidates.delete(id);
      continue;
    }
    lotCandidates.set(id, { lot, date });
  }

  function acquisitionOrigin(id: string | null | undefined): LotOrigin | undefined {
    const candidate = id ? lotCandidates.get(id) : undefined;
    return candidate?.lot.operation === 'acquisition' ? candidate : undefined;
  }

  function rowLot(id: string): LotOrigin | undefined {
    const root = sources.roots.get(id);
    if (!root) return undefined;
    const local = metadata.inventory.get(id);
    const original = metadata.inventory.get(root);
    const explicit = local?.lotState === 'confirmed' ? local.lotId : null;
    const rootAssignment = original?.lotState === 'confirmed' ? original.lotId : lotByRoot.get(root);
    if (explicit && rootAssignment && explicit !== rootAssignment) return undefined;
    return acquisitionOrigin(explicit ?? rootAssignment);
  }

  function confirmedKind(id: string | null | undefined): ProductKind | undefined {
    const kind = id ? metadata.kinds.get(id) : undefined;
    return kind?.state === 'confirmed' ? kind : undefined;
  }

  const observedKinds = new Map<string, Set<string>>();
  function addKindCategory(kindId: string | null, category: string) {
    if (!kindId || category === UNKNOWN) return;
    const observed = observedKinds.get(kindId) ?? new Set<string>();
    observed.add(category);
    observedKinds.set(kindId, observed);
  }

  function assignment(meta: InventoryMetadata | undefined): Assignment {
    const kindId = meta?.kindState === 'confirmed' ? confirmedKind(meta.kindId)?.id ?? null : null;
    const category = meta?.categoryState === 'confirmed' ? taxonomy.canonical(meta.categoryId) : UNKNOWN;
    return { kindId, category };
  }

  const observedRows = new Map<string, Assignment>();
  for (const row of rows) {
    if (row.deletedAt) continue;
    const root = sources.roots.get(row.id);
    const local = metadata.inventory.get(row.id);
    const inherited = !local && root ? metadata.inventory.get(root) : undefined;
    const observed = assignment(local ?? inherited);
    observedRows.set(row.id, observed);
    addKindCategory(observed.kindId, observed.category);
  }

  const representatives = new Map<string, AnalysisSource>();
  const lotKinds = new Map<string, Set<string>>();
  const lotCategories = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.deletedAt) continue;
    const origin = rowLot(row.id);
    if (!origin) continue;
    const id = origin.lot.id;
    const previous = representatives.get(id);
    const root = sources.roots.get(row.id) === row.id;
    const previousRoot = previous && sources.roots.get(previous.id) === previous.id;
    if (!previous || (root && !previousRoot) || (root === previousRoot && row.id < previous.id)) representatives.set(id, row);
    const observed = observedRows.get(row.id)!;
    if (observed.kindId) {
      const kinds = lotKinds.get(id) ?? new Set<string>();
      kinds.add(observed.kindId);
      lotKinds.set(id, kinds);
    }
    if (observed.category !== UNKNOWN) {
      const categories = lotCategories.get(id) ?? new Set<string>();
      categories.add(observed.category);
      lotCategories.set(id, categories);
    }
  }

  function one(values: Set<string> | undefined): string | null {
    return values?.size === 1 ? values.values().next().value ?? null : null;
  }

  const lotAssignments = new Map<string, Assignment>();
  for (const { lot } of lotCandidates.values()) {
    const originalId = lot.originalLotId ?? lot.id;
    const kind = confirmedKind(lot.kindId)?.id ?? one(lotKinds.get(originalId));
    const explicit = taxonomy.canonical(lot.categoryId);
    const category = explicit !== UNKNOWN ? explicit : one(lotCategories.get(originalId)) ?? UNKNOWN;
    lotAssignments.set(lot.id, { kindId: kind, category });
    addKindCategory(kind, category);
  }

  function canonicalAssignment(observed: Assignment): Assignment {
    if (!observed.kindId) return observed;
    const kind = confirmedKind(observed.kindId);
    const canonical = taxonomy.canonical(kind?.categoryId);
    return {
      kindId: observed.kindId,
      category: canonical !== UNKNOWN ? canonical : one(observedKinds.get(observed.kindId)) ?? UNKNOWN,
    };
  }

  const result: AnalysisBuild = {
    metadata: {
      version: ANALYSIS_VERSION, generation, asOf, timezone: 'Asia/Tokyo', scopeId: 'bello-stock-and-closed-sales',
      amountBasis: '金額は円表示。在庫は登録購入単価、売上は確定販売総額、仕入れ・小売原価は確認済み金額で集計。',
      metadataVersions: Object.fromEntries(metadata.versions),
      coverageStart, coverageEnd: today, accuracy: 'captured-current-source',
      sourceRecordCount: rows.length, unlocatedAcquisitionRecords: 0, unlocatedSalesRecords: 0,
    },
    inventoryValue,
    categories: taxonomy.categories,
    inventory: [], sales: [], acquisitions: [], retailReference: [],
    referenceExclusions: { unknownChannel: 0, unknownCost: 0, unverifiedOrigin: 0, excluded: 0, salesAmount: 0 },
  };

  const eligibleRows = rows.filter(row => !row.deletedAt).map(row => ({
    row, value: selectInventoryValueRow(row, masters), observed: observedRows.get(row.id)!,
  }));
  const holdings = new Map<string, number>();
  for (const { value, observed } of eligibleRows) {
    if (!value.eligible || !observed.kindId) continue;
    const count = (holdings.get(observed.kindId) ?? 0) + value.quantity;
    if (!Number.isSafeInteger(count)) throw new Error('ANALYSIS_QUANTITY_OVERFLOW');
    holdings.set(observed.kindId, count);
  }

  const capturedSales = new Map(normalizedCapturedSalesRecords(rows, asOf).map(record => [record.id, record]));
  const unlocatedRoots = new Set<string>();
  for (const { row, value, observed } of eligibleRows) {
    const local = metadata.inventory.get(row.id);
    const origin = rowLot(row.id);
    const lot = origin?.lot;
    const root = sources.roots.get(row.id);
    const holding = observed.kindId ? holdings.get(observed.kindId) : undefined;
    const assignment = canonicalAssignment(observed);
    if (value.eligible) {
      result.inventory.push(fact({
        id: row.id, row, date: origin?.date ?? null, assignment, lot, holding,
        amount: value.validPrice ? value.amount : null, quantity: value.quantity,
      }));
    }
    if (!lot && (row.transactionDate || root === null || value.eligible || row.saleEndDate ||
      ['__restageImport', '__yahooPurchaseImport', '__trefacImport'].some(key => Object.hasOwn(sources.custom.get(row.id)!, key)))) {
      unlocatedRoots.add(root ?? row.id);
    }

    const captured = capturedSales.get(row.id);
    if (!captured) {
      const bookedDay = recordedDay(row.saleEndDate);
      if (!bookedDay && (row.saleEndDate || value.labels.some(label => CLOSED_WORKFLOWS.has(label)))) {
        result.metadata.unlocatedSalesRecords = (result.metadata.unlocatedSalesRecords ?? 0) + 1;
      }
      continue;
    }
    const { saleEndDate: date, salePrice: amount } = captured;
    if (!date || (date < coverageStart && date < referencePeriod.start)) continue;
    const quantity = saleQuantity(sources.custom.get(row.id)!, local);
    const rawCost = hasEvidence(local?.saleCostEvidence) ? integer(local?.saleCostTotal) : null;
    const cost = rawCost !== null && (amount === null || amount === 0 || rawCost === 0 || Math.sign(amount) === Math.sign(rawCost)) ? rawCost : null;
    const closedOrigin = origin && origin.date <= date ? origin.lot : undefined;
    const excluded = local?.retail === 'excluded' || value.groupKey === 'wholesale' || EXCLUDED_MARKETS.has(row.market?.trim() ?? '');
    const channel = excluded ? 'excluded' : local?.retail ?? 'unknown';
    const sale = fact({
      id: row.id, row, date, assignment, lot: closedOrigin, amount, quantity,
      unknownChannel: channel === 'unknown', missingCost: cost === null,
    });
    if (date >= coverageStart) result.sales.push(sale);
    if (date < referencePeriod.start) continue;
    if (channel === 'confirmed' && closedOrigin?.merchandise && cost !== null) {
      result.retailReference.push({ ...sale, amount: cost, unknown: { ...sale.unknown, amount: 0 } });
      continue;
    }

    const reasons = result.referenceExclusions;
    if (channel === 'unknown') reasons.unknownChannel++;
    else if (channel === 'excluded' || closedOrigin?.merchandise === false) reasons.excluded++;
    else if (!closedOrigin) reasons.unverifiedOrigin++;
    else reasons.unknownCost++;
    reasons.salesAmount += amount ?? 0;
    if (!Number.isSafeInteger(reasons.salesAmount)) throw new Error('ANALYSIS_AMOUNT_OVERFLOW');
  }
  result.metadata.unlocatedAcquisitionRecords = unlocatedRoots.size;

  for (const { lot, date } of lotCandidates.values()) {
    if (!lot.merchandise || date < acquisitionPeriod.start) continue;
    const origin = lot.operation === 'acquisition' ? { lot, date } : acquisitionOrigin(lot.originalLotId);
    if (!origin || origin.date > date || !origin.lot.merchandise) {
      result.metadata.unlocatedAcquisitionRecords++;
      continue;
    }
    const original = origin.lot;
    const quantity = nonnegative(lot.quantity);
    const cost = nonnegative(lot.costTotal);
    const sign = lot.operation === 'acquisition' ? 1 : -1;
    const row = representatives.get(original.id);
    result.acquisitions.push(fact({
      id: lot.id, row, date, assignment: canonicalAssignment(lotAssignments.get(lot.id)!), lot: original,
      amount: cost === null ? null : sign * cost, quantity: quantity === null ? null : sign * quantity,
      countsLot: sign > 0,
    }));
  }
  return result;
}


