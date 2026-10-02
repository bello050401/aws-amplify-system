"use server";

import { headers } from "next/headers";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { readNextEngineOrderWindow } from "@/lib/listing/nextEngine/orderWindowClient";
import { withBoundNextEngineRead } from "@/lib/listing/nextEngine/boundRead";
import { nextEngineBindingReadRef } from "@/lib/listing/nextEngine/bindingReadRef";
import { validateNextEngineOrderWindow, type NextEngineOrderSummary,
  type NextEngineOrderWindow } from "@/lib/listing/nextEngine/orderWindow";
import { PRIVATE_MASTER_STAGING_ORIGIN } from "@/lib/listing/nextEngine/privateMasterAcceptance";

const STAGING_TOKEN_SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:203918843421:secret:bello/next-engine-tokens-staging-jAJyao";

export type NextEngineOrderPreviewResult =
  | { ok: true; orders: NextEngineOrderSummary[] }
  | { ok: false; message: string };

class StoreSelectionExpired extends Error {}

/** A manual, one-shop, 24-hour read. Never imports orders or changes stock. */
export async function previewNextEngineOrdersAction(window: NextEngineOrderWindow,
  bindingRef: string): Promise<NextEngineOrderPreviewResult> {
  if (headers().get("origin") !== PRIVATE_MASTER_STAGING_ORIGIN ||
      process.env.NEXT_ENGINE_PUBLIC_ORIGIN !== PRIVATE_MASTER_STAGING_ORIGIN ||
      process.env.NEXT_ENGINE_TOKEN_SECRET_ID !== STAGING_TOKEN_SECRET_ARN) {
    return { ok: false, message: "この確認は検証環境からのみ利用できます。" };
  }
  if (await getInventoryRole() !== "ADMIN") return { ok: false, message: "管理者のみ確認できます。" };
  try {
    validateNextEngineOrderWindow(window);
    if (!/^[a-f0-9]{64}$/.test(bindingRef)) throw new StoreSelectionExpired();
    const orders = await withBoundNextEngineRead((tokens, persist, binding) => {
      if (nextEngineBindingReadRef(binding) !== bindingRef) throw new StoreSelectionExpired();
      return readNextEngineOrderWindow(tokens, persist, window);
    });
    return { ok: true, orders };
  } catch (error) {
    if (error instanceof StoreSelectionExpired) {
      return { ok: false, message: "NEの接続先が変わりました。登録情報を読み直して店舗を選び直してください。" };
    }
    return { ok: false, message: "指定店舗の受注を確認できませんでした。店舗と24時間以内の期間を確認してください。" };
  }
}
