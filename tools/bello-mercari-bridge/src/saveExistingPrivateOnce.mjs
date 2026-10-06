import { openExistingProductReadSession } from "./session.mjs";
import { privateFromExactListRow } from "./existingProductReader.mjs";
import { observeManualShopsMutation, safeManualMutationSummary } from "./manualMutationObservation.mjs";
import { claimManualSaveOnce, readManualSaveClaim, writeManualSaveOutcome } from "./manualSaveAttempt.mjs";
import { readPrivateImageWorkflowClaim } from "./privateImageWorkflowAttempt.mjs";

function exactSingle(rows, label, name = null) {
  const matches = rows.filter(row => row.label === label && (name === null || row.name === name) &&
    typeof row.value === "string");
  return matches.length === 1 ? matches[0].value : null;
}

export async function readPinnedEditFields(page, expectedUrl, target, requireControls = true) {
  if (page.url() !== expectedUrl) return null;
  if (requireControls) {
    const heading = page.getByRole("heading", { name: "商品管理", exact: true });
    const next = page.getByRole("button", { name: "公開設定に進む", exact: true });
    if (await heading.count() === 0) {
      try { await heading.waitFor({ state: "visible", timeout: 12000 }); } catch { return null; }
    }
    if (await next.count() === 0) {
      try { await next.waitFor({ state: "visible", timeout: 12000 }); } catch { return null; }
    }
    if (await heading.count() !== 1 || await next.count() !== 1 || !await next.isEnabled()) return null;
  }
  const snapshot = await page.locator("input, textarea").evaluateAll(elements => {
    const rows = elements.flatMap(element => {
      if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) return [];
      const container = element.parentElement?.parentElement;
      const inputs = container?.querySelectorAll("input, textarea") ?? [];
      const labels = container?.querySelectorAll("label") ?? [];
      if (inputs.length !== 1 || inputs[0] !== element || labels.length !== 1) return [];
      return [{ name: element.name, label: (labels[0].textContent ?? "").replace(/\s+/g, "")
        .replace(/(任意|必須)$/, ""), value: element.value }];
    });
    const quantities = elements.filter(element => element instanceof HTMLInputElement &&
      /^variants\.[0-9]+\.quantity$/.test(element.name));
    let quantity = null;
    if (quantities.length === 1) {
      const field = quantities[0];
      const container = field.parentElement;
      const inputs = container?.querySelectorAll("input, textarea") ?? [];
      const labels = container?.querySelectorAll("label") ?? [];
      if (field.name === "variants.0.quantity" && field.type === "number" &&
          container?.tagName === "DIV" && inputs.length === 1 && inputs[0] === field &&
          labels.length === 1 && (labels[0].textContent ?? "").replace(/\s+/g, "") === "数量")
        quantity = field.value;
    }
    return { documentUrl: document.location.href, rows, quantity };
  });
  if (snapshot?.documentUrl !== expectedUrl || page.url() !== expectedUrl ||
      !Array.isArray(snapshot.rows)) return null;
  const title = exactSingle(snapshot.rows, "商品名");
  const sku = exactSingle(snapshot.rows, "商品管理コード", "variants.0.skuCode");
  const price = exactSingle(snapshot.rows, "販売価格", "price");
  if (!title?.trim() || sku !== (target.skuCode ?? target.inventoryCode) ||
      !/^(?:[¥￥]\s*)?(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)$/.test(price ?? "") ||
      Number(price.replace(/[¥￥,\s]/g, "")) !== target.priceYen ||
      snapshot.quantity !== String(target.quantity)) return null;
  return { title: title.trim(), sku, priceYen: target.priceYen, quantity: target.quantity };
}

async function confirmExistingPrivate(page, target, expectedUrl, title) {
  const result = await privateFromExactListRow(page, target.shopId, expectedUrl, title);
  return result.value.kind === "OBSERVED" && result.value.value === "PRIVATE" &&
    page.url() === expectedUrl;
}

export async function privateSaveControl(page, expectedUrl) {
  if (page.url() !== expectedUrl) return null;
  const dialog = page.getByRole("dialog");
  if (await dialog.count() !== 1 || await dialog.getAttribute("aria-modal") !== "true" ||
      await dialog.getByText("保存設定を選んでください", { exact: true }).count() !== 1)
    return null;
  const footer = dialog.locator("footer");
  if (await footer.count() !== 1 || await footer.getByRole("button").count() !== 3) return null;
  const privateButton = footer.getByRole("button", { name: "非公開で保存する", exact: true });
  const publicButton = footer.getByRole("button", { name: "公開する", exact: true });
  const cancelButton = footer.getByRole("button", { name: "キャンセル", exact: true });
  if (await privateButton.count() !== 1 || await publicButton.count() !== 1 ||
      await cancelButton.count() !== 1 || !await privateButton.isEnabled() ||
      await privateButton.getAttribute("type") !== "button") return null;
  return privateButton;
}

/** One already-private existing-product save. Every uncertain click is permanently non-retryable. */
export async function saveExistingPrivateOnce({ root, profileDir, playwrightModulePath, target,
  launchPersistentContext = null, onMetadata = null }, {
    openSession = openExistingProductReadSession, readFields = readPinnedEditFields,
    checkPrivate = confirmExistingPrivate, observe = observeManualShopsMutation,
  } = {}) {
  const [prior, workflow] = await Promise.all([
    readManualSaveClaim(root, target), readPrivateImageWorkflowClaim(root, target),
  ]);
  if (prior.claimed || workflow.claimed)
    return { status: "ALREADY_ATTEMPTED", listingConfirmed: false };
  const expectedUrl = `https://mercari-shops.com/seller/shops/${target.shopId}/products/${target.remoteId}/edit`;
  const session = await openSession({ root, profileDir, playwrightModulePath,
    shopId: target.shopId, remoteId: target.remoteId, launchPersistentContext });
  let contextClosed = false;
  const closeListeners = new Set();
  session.context.once("close", () => {
    contextClosed = true;
    for (const callback of closeListeners) callback();
    closeListeners.clear();
  });
  let observer = null;
  let claim = null;
  let nextMayHaveClicked = false;
  let clicked = false;
  let diagnostic = "CLAIMED_BEFORE_NEXT";
  let metadata = [];
  try {
    if (session.state !== "NAVIGATED_UNVERIFIED") return { status: "PREFLIGHT_BLOCKED", listingConfirmed: false };
    const before = await readFields(session.page, expectedUrl, target);
    if (!before || !await checkPrivate(session.page, target, expectedUrl, before.title))
      return { status: "PREFLIGHT_BLOCKED", listingConfirmed: false };
    const again = await readFields(session.page, expectedUrl, target);
    if (!again || again.title !== before.title) return { status: "PREFLIGHT_BLOCKED", listingConfirmed: false };
    observer = observe(session.page, expectedUrl);
    try { claim = await claimManualSaveOnce(root, target); }
    catch (error) {
      if (error?.code === "EEXIST") return { status: "ALREADY_ATTEMPTED", listingConfirmed: false };
      throw error;
    }
    try {
      diagnostic = "NEXT_CONTROL_CHECK";
      const next = session.page.getByRole("button", { name: "公開設定に進む", exact: true });
      if (await next.count() !== 1 || !await next.isEnabled() || session.page.url() !== expectedUrl)
        throw Error("Private save control changed");
      diagnostic = "NEXT_CLICK_UNCERTAIN";
      nextMayHaveClicked = true;
      await next.click({ timeout: 12000 });
      diagnostic = "POST_NEXT_FIELDS_CHECK";
      const beforeFinalSave = await readFields(session.page, expectedUrl, target, false);
      if (!beforeFinalSave || beforeFinalSave.title !== before.title)
        throw Error("Existing product values changed before save");
      diagnostic = "PRIVATE_CONTROL_CHECK";
      const privateButton = await privateSaveControl(session.page, expectedUrl);
      if (!privateButton) throw Error("Observed private save dialog changed");
      diagnostic = "PRIVATE_CLICK_UNCERTAIN";
      clicked = true;
      await privateButton.click({ timeout: 12000 });
      diagnostic = "PRIVATE_CLICK_RETURNED";
    } catch {
      // A click may have reached Shops even when the local call fails. Never retry it.
    }
    metadata = safeManualMutationSummary(observer.snapshot());
    if (typeof onMetadata === "function") {
      try { onMetadata(metadata); } catch { /* Local display cannot change the save outcome. */ }
    }
    const outcome = clicked || nextMayHaveClicked ? "UNKNOWN" : "BLOCKED_BEFORE_CLICK";
    try { await writeManualSaveOutcome(root, target, claim.attemptId, outcome,
      { diagnostic }); }
    catch { /* The claim still prevents replay when outcome recording fails. */ }
    // Keep Chrome and the observer alive. Navigation or close could abort an in-flight save.
    return { status: outcome, listingConfirmed: false, postflightPrivate: false,
      diagnostic,
      metadata, retainedSession: { context: session.context, observer,
        onClose: callback => {
          if (contextClosed) callback();
          else closeListeners.add(callback);
        } } };
  } finally {
    if (!claim) {
      if (observer) {
        try { await observer.stop(); } catch { /* No save was claimed. */ }
      }
      await session.context.close();
    }
  }
}
