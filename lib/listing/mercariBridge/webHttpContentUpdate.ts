import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { openMercariWebHttpCookieReadOnly } from "./webHttpReadOnlyClient";
import {
  buildObservedProductVisibilityRequest,
  buildObservedProductValidationRequest,
  observedProductContentFingerprint,
  observedProductValidationSucceeded,
  type ObservedProductRead,
} from "./webHttpObservedProductContract";
import {
  buildObservedImageAssetRequest,
  parseObservedImageAssetResponse,
} from "./webHttpObservedImageAsset";
import {
  reserveWebHttpContentImage,
  reserveWebHttpProductStopStart,
  webHttpSendPermitFresh,
  type WebHttpSendAttempt,
} from "./webHttpSendReservation";
import type { WebHttpProductStopPorts } from "./webHttpProductStop";
import { WEB_HTTP_SHOP_ID } from "./webHttpDraftJob";
import type { ListingImageRef } from "../types";
import type { EcReview } from "../ecManagement";

export type ContentSource = {
  fingerprint: string;
  title: string;
  description: string;
  price: number;
  quantity: number;
  images: ListingImageRef[];
};
type Result = Pick<
  EcReview,
  | "status"
  | "message"
  | "token"
  | "price"
  | "quantity"
  | "imageCount"
  | "details"
  | "nextAt"
> & { title?: string };
type Ports = Omit<WebHttpProductStopPorts, "repository"> & {
  readSource: (id: string) => Promise<ContentSource>;
  imageJpeg: (ref: ListingImageRef) => Promise<Uint8Array>;
  repository: WebHttpProductStopPorts["repository"] & {
    acknowledgeImageAsset: (
      requestId: string,
      attemptId: string,
      asset: string,
      sha: string,
      now: string,
    ) => Promise<void>;
    verifyProductStop: (
      requestId: string,
      attemptId: string,
      shopId: string,
      productId: string,
      fingerprint: string,
      now: string,
      status?: "STATUS_OPENED" | "STATUS_UNOPENED",
    ) => Promise<void>;
  };
  saveVerifiedState: (
    binding: NonNullable<
      Awaited<ReturnType<WebHttpProductStopPorts["readBinding"]>>
    >,
    status: "STATUS_OPENED" | "STATUS_UNOPENED",
  ) => Promise<void>;
};
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const block = (message: string): Result => ({ status: "BLOCKED", message });
const unknown = () =>
  block(
    "更新結果を確認できません。販売先の商品を確認してください。重複送信は行いません。",
  );

/** Preserves the remote visibility, category and shipping. One durable write per call. */
export async function updateObservedWebHttpContent(
  id: string,
  user: string,
  confirmed: string | null,
  ports: Ports,
  clock = Date.now,
): Promise<Result> {
  try {
    const binding = await ports.readBinding(id);
    if (
      !binding ||
      binding.inventoryId !== id ||
      binding.shopId !== WEB_HTTP_SHOP_ID ||
      !user
    )
      return block("登録済み商品の対応を確認してください。");
    const fresh = () =>
      ports.session.expiresAtMs !== null &&
      ports.session.expiresAtMs > clock() + 40_000;
    if (!fresh()) return block("メルカリShopsの接続を確認してください。");
    const opened = await openMercariWebHttpCookieReadOnly(ports.session, {
      fetchPort: ports.fetchPort,
      clock,
    });
    if (!opened.client || !(await opened.client.verifyTargetShop()).shopMatched)
      return block("メルカリShopsの接続を確認してください。");
    const client = opened.client;
    const sameBinding = async () =>
      hash(await ports.readBinding(id)) === hash(binding);
    const read = async () => {
      const p = (await client.readProduct(binding.remoteProductId)).product;
      return p &&
        p.shopId === binding.shopId &&
        p.variants.length === 1 &&
        p.variants[0].skuCode === binding.managementCode &&
        (await sameBinding())
        ? p
        : null;
    };
    const verify = async (a: WebHttpSendAttempt): Promise<Result> => {
      if (
        a.inventoryId !== id ||
        a.remoteProductId !== binding.remoteProductId ||
        a.requestedBy !== user ||
        ![
          "SEND_CLAIMED_RESULT_UNKNOWN",
          "PRODUCT_STOP_VERIFIED",
          "PRODUCT_REOPEN_VERIFIED",
        ].includes(a.status)
      )
        return unknown();
      const p = await read();
      if (
        !p ||
        p.status !== a.desiredProductStatus ||
        observedProductContentFingerprint(p) !== a.productContentFingerprint
      )
        return unknown();
      if (a.status === "SEND_CLAIMED_RESULT_UNKNOWN")
        await ports.repository.verifyProductStop(
          a.requestId,
          a.attemptId,
          binding.shopId,
          p.id,
          a.productContentFingerprint!,
          new Date(clock()).toISOString(),
          p.status,
        );
      await ports.saveVerifiedState(binding, p.status);
      return {
        status: "DONE",
        message: "メルカリShopsの商品内容と画像の更新を確認しました。",
      };
    };
    const pending = await ports.repository.getPendingProductStop(
      binding.shopId,
      binding.remoteProductId,
    );
    if (pending) {
      const a = await ports.repository.getAttempt(pending);
      if (
        a?.status === "RESERVED_NO_SEND" &&
        a.requestedBy === user &&
        clock() >= Date.parse(a.sendBeforeAt)
      ) {
        await ports.repository.cancelUnclaimedProductStop(a);
        return block(
          "前回は送信前に終了しました。内容を確認し直してください。",
        );
      }
      const previous = a ? await verify(a) : unknown();
      return previous.status === "DONE"
        ? block(
            "前回の操作結果を確認しました。商品内容を確認し直してください。",
          )
        : previous;
    }
    const s = await ports.readSource(id),
      p = await read();
    if (!p) return block("販売先の商品を確認できませんでした。");
    if (
      !s.title.trim() ||
      !s.description.trim() ||
      s.title.length > 130 ||
      s.description.length > 3000 ||
      !Number.isSafeInteger(s.price) ||
      s.price < 300 ||
      s.price > 9999999 ||
      !Number.isSafeInteger(s.quantity) ||
      s.quantity < 0 ||
      !s.images.length ||
      s.images.length > 20 ||
      !/^[a-f0-9]{64}$/.test(s.fingerprint)
    )
      return block("商品名・説明・単価・数量・画像を確認してください。");
    const sameSource = async () =>
      (await ports.readSource(id)).fingerprint === s.fingerprint &&
      (await sameBinding());
    const fingerprint = observedProductContentFingerprint(p);
    const token = hash([id, s.fingerprint, fingerprint, p.status]);
    const assetIds: string[] = [];
    let missing: { index: number; requestId: string } | null = null;
    for (let i = 0; i < s.images.length; i++) {
      const key = hash([
        "BELLO_SHOPS_CONTENT_IMAGE",
        binding.shopId,
        id,
        s.fingerprint,
        i,
      ]);
      const a = await ports.repository.getAttempt(key);
      if (!a) {
        missing = { index: i, requestId: key };
        break;
      }
      if (
        a.status !== "IMAGE_ACKNOWLEDGED" ||
        !a.remoteAssetId ||
        a.inventoryId !== id ||
        a.shopId !== binding.shopId ||
        a.snapshotFingerprint !== s.fingerprint
      )
        return unknown();
      assetIds.push(a.remoteAssetId);
    }
    const target: ObservedProductRead = {
      ...p,
      fields: {
        ...p.fields,
        name: s.title,
        description: s.description,
        price: s.price,
        assetIds,
      },
      variants: [{ ...p.variants[0], quantity: s.quantity }],
    };
    if (!missing && observedProductContentFingerprint(target) === fingerprint)
      return {
        status: "DONE",
        message: "保存した内容はメルカリShopsに反映済みです。",
      };
    if (confirmed === null)
      return {
        status: "READY",
        token,
        title: s.title,
        price: s.price,
        quantity: s.quantity,
        imageCount: s.images.length,
        message: "共通タブで保存した商品情報をメルカリShopsに反映します。",
        details: [
          "商品名・説明・単価・数量・画像を更新します。",
          "カテゴリ・配送方法・公開状態は現在の設定を保ちます。",
        ],
      };
    if (confirmed !== token)
      return block("確認後に商品情報が変わりました。確認し直してください。");
    const post = async (body: BodyInit, multipart = false) => {
      const r = await (ports.fetchPort ?? fetch)(
        "https://mercari-shops.com/graphql",
        {
          method: "POST",
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: AbortSignal.timeout(10000),
          headers: {
            ...(!multipart ? { "Content-Type": "application/json" } : {}),
            Accept: "application/json",
            Origin: "https://mercari-shops.com",
            Cookie: ports.session.cookieHeader,
          },
          body,
        },
      );
      return {
        status: r.status,
        body: !r.redirected && r.status === 200 ? await r.json() : null,
      };
    };
    const wait = (nextAt?: number): Result => ({
      status: "WAIT",
      token: confirmed,
      nextAt: nextAt ?? clock() + 61000,
      message: `画像を準備中（${assetIds.length} / ${s.images.length}枚）`,
    });
    if (missing) {
      const bytes = await ports.imageJpeg(s.images[missing.index]);
      const sha = createHash("sha256").update(bytes).digest("hex"),
        request = buildObservedImageAssetRequest(bytes, sha);
      if (!fresh() || !(await sameSource()))
        return block(
          "商品情報または接続が変わりました。確認し直してください。",
        );
      const reservation = await reserveWebHttpContentImage(
        { ...binding, requestedBy: user, snapshotFingerprint: s.fingerprint },
        missing.requestId,
        randomUUID(),
        ports.repository,
        clock,
      );
      if (!reservation.ok)
        return reservation.code === "WAIT_INTERVAL"
          ? wait(reservation.nextEligibleAtMs)
          : unknown();
      if (
        !fresh() ||
        !webHttpSendPermitFresh(reservation, clock()) ||
        !(await sameSource())
      )
        return unknown();
      await ports.repository.claimMutationStart(
        reservation.requestId,
        reservation.attemptId,
        new Date(clock()).toISOString(),
      );
      if (
        !fresh() ||
        !webHttpSendPermitFresh(reservation, clock()) ||
        !(await sameSource())
      )
        return unknown();
      const response = await post(request.body, true),
        ack = parseObservedImageAssetResponse(response.status, response.body);
      if (!ack) return unknown();
      await ports.repository.acknowledgeImageAsset(
        reservation.requestId,
        reservation.attemptId,
        ack.remoteAssetId,
        sha,
        new Date(clock()).toISOString(),
      );
      return wait();
    }
    if (new Set(assetIds).size !== assetIds.length)
      return block("画像が重複しています。共通タブで確認してください。");
    if (
      !observedProductValidationSucceeded(
        (
          await post(
            JSON.stringify(
              buildObservedProductValidationRequest(s.title, s.description),
            ),
          )
        ).body,
      )
    )
      return block("商品名または説明を販売先が受け付けませんでした。");
    const targetFingerprint = observedProductContentFingerprint(target);
    const reservation = await reserveWebHttpProductStopStart(
      {
        ...binding,
        requestedBy: user,
        productSnapshotId: p.snapshotId,
        productContentFingerprint: targetFingerprint,
        desiredProductStatus: p.status,
      },
      randomUUID(),
      ports.repository,
      clock,
    );
    if (!reservation.ok)
      return reservation.code === "WAIT_INTERVAL"
        ? wait(reservation.nextEligibleAtMs)
        : unknown();
    const current = await read();
    if (
      !current ||
      current.snapshotId !== p.snapshotId ||
      current.variants[0].stockSnapshotId !== p.variants[0].stockSnapshotId ||
      current.status !== p.status ||
      observedProductContentFingerprint(current) !== fingerprint ||
      !(await sameSource()) ||
      !fresh() ||
      !webHttpSendPermitFresh(reservation, clock())
    )
      return block(
        "商品情報が変わったため更新を止めました。確認し直してください。",
      );
    await ports.repository.claimMutationStart(
      reservation.requestId,
      reservation.attemptId,
      new Date(clock()).toISOString(),
    );
    if (
      fresh() &&
      webHttpSendPermitFresh(reservation, clock()) &&
      (await sameSource())
    ) {
      try {
        await post(
          JSON.stringify(
            buildObservedProductVisibilityRequest(
              target,
              p.status,
              Math.random(),
            ),
          ),
        );
      } catch {
        /* Reconcile only; never replay an uncertain update. */
      }
    }
    const attempt = await ports.repository.getAttempt(reservation.requestId);
    return attempt ? verify(attempt) : unknown();
  } catch {
    return unknown();
  }
}
