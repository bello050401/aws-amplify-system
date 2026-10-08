import { diagnoseGeneralPrivateCreateForm } from
  "./generalPrivateCreateForm.mjs";
import { collectGeneralPrivateCreateDraftDetailsReadOnly } from
  "./generalPrivateCreateDraftCollector.mjs";
import { readStableGeneralPrivateDraftCount } from
  "./generalPrivateDraftDuplicateReader.mjs";
import { readAtomicGeneralPrivateDraftFormSnapshot } from
  "./generalPrivateDraftSaveOnce.mjs";
import { isExplicitDraftReadQueryRequest } from
  "./draftReadMetadataObserver.mjs";

const ORIGIN = "https://mercari-shops.com";
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function exactFormProof(snapshot, pack, selectedAssets) {
  if (!snapshot || !Array.isArray(snapshot.assets) ||
      !same(snapshot.assets, selectedAssets) ||
      snapshot.categoryLeaf?.trim() !== pack.categoryPath.split(" > ").at(-1))
    return false;
  const fields = snapshot.fields ?? {};
  return diagnoseGeneralPrivateCreateForm(pack, {
    name: fields.name, description: fields.description,
    price: fields.price, quantity: fields["variants.0.quantity"],
    sku: fields["variants.0.skuCode"], condition: snapshot.condition,
    category: snapshot.categoryGroup,
    shipping: Object.fromEntries([
      "shippingMethodType.id", "shippingPayerType.id",
      "shippingFromState.id", "shippingDurationType.id",
    ].map(name => [name, fields[name]])),
    imageCount: snapshot.assets.length,
  }) === null;
}

/** A new page re-reads the exact private draft after the save result is UNKNOWN. */
export function bindB005396PrivateDraftReadback(context, pack, {
  readCount = readStableGeneralPrivateDraftCount,
  collectDrafts = collectGeneralPrivateCreateDraftDetailsReadOnly,
  readForm = readAtomicGeneralPrivateDraftFormSnapshot,
} = {}) {
  return async ({ shopId, draftId, managementCode, selectedAssets }) => {
    if (!context || typeof context.newPage !== "function" ||
        shopId !== pack?.shopId || managementCode !== pack.managementCode ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(draftId ?? "") ||
        !Array.isArray(selectedAssets) || selectedAssets.length !== 1)
      return null;
    let page;
    let routeBlocked = false;
    try {
      page = await context.newPage();
      if (typeof page.route !== "function" ||
          typeof page.routeWebSocket !== "function") return null;
      await page.route("**/*", async route => {
        try {
          const request = route.request();
          if (["GET", "HEAD", "OPTIONS"].includes(request.method()) ||
              isExplicitDraftReadQueryRequest(request)) await route.continue();
          else { routeBlocked = true; await route.abort(); }
        } catch {
          routeBlocked = true;
          try { await route.abort(); } catch { /* Closing also blocks it. */ }
        }
      });
      await page.routeWebSocket("**/*", socket => {
        routeBlocked = true;
        return socket.close();
      });
      const count = await readCount({ page, shopId });
      if (routeBlocked || count?.status !== "DRAFT_COUNT_OBSERVED" ||
          count.allowFinalCreate !== false ||
          !Number.isSafeInteger(count.count) ||
          count.count < 1 || count.count > 50) return null;
      const first = await collectDrafts({ page, shopId,
        expectedRowCount: count.count });
      if (routeBlocked || first?.status !== "DRAFT_DETAILS_DOM_OBSERVED" ||
          first.allowFinalCreate !== false ||
          !Array.isArray(first.rows) || first.rows.length !== count.count)
        return null;
      await page.waitForTimeout(600);
      const second = await collectDrafts({ page, shopId,
        expectedRowCount: count.count });
      if (routeBlocked || second?.status !== "DRAFT_DETAILS_DOM_OBSERVED" ||
          second.allowFinalCreate !== false || !same(first.rows, second.rows))
        return null;
      const own = first.rows.filter(row => row?.draftId === draftId);
      if (own.length !== 1 || own[0].title !== pack.title ||
          own[0].skuCode !== managementCode) return null;
      const url = `${ORIGIN}/seller/shops/${shopId}/products/create?productDraftId=${draftId}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 12000 });
      let previous = null;
      let stable = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        const snapshot = await readForm(page);
        if (routeBlocked || page.url() !== url || snapshot?.href !== url ||
            !exactFormProof(snapshot, pack, selectedAssets))
          return null;
        stable = previous && same(previous, snapshot) ? stable + 1 : 1;
        previous = snapshot;
        if (stable === 3) return { status: "PRIVATE_DRAFT_READBACK_CONFIRMED",
          shopId, draftId, managementCode,
          title: snapshot.fields.name,
          description: snapshot.fields.description,
          priceYen: pack.priceYen, quantity: pack.quantity,
          condition: pack.condition, categoryPath: pack.categoryPath,
          shipping: pack.shipping, assets: snapshot.assets,
          visibility: "DRAFT_PRIVATE", public: false,
          observedAt: new Date().toISOString() };
        await page.waitForTimeout(600);
      }
      return null;
    } catch { return null; }
    finally { await page?.close().catch(() => {}); }
  };
}
