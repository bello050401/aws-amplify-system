"use server";

import { headers } from "next/headers";
import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { listNextEngineMasterCandidates, MasterCandidatesError,
  type MasterCandidates, type MasterCandidatesErrorCode } from "@/lib/listing/nextEngine/masterCandidates";
import { PRIVATE_MASTER_STAGING_ORIGIN } from "@/lib/listing/nextEngine/privateMasterAcceptance";

export type MasterCandidatesResult = { ok: true; data: MasterCandidates } |
  { ok: false; message: string; code?: MasterCandidatesErrorCode };

export async function readNextEngineMasterCandidates(): Promise<MasterCandidatesResult> {
  try {
    if (headers().get("origin") !== PRIVATE_MASTER_STAGING_ORIGIN) {
      return { ok: false, message: "この画面から操作してください。" };
    }
    if (await getInventoryRole() !== "ADMIN") {
      return { ok: false, message: "管理者のみ操作できます。" };
    }
    return { ok: true, data: await listNextEngineMasterCandidates() };
  } catch (error) {
    if (error instanceof MasterCandidatesError) {
      return { ok: false, message: "登録情報を確認できませんでした。", code: error.code };
    }
    return { ok: false, message: "登録情報を確認できませんでした。接続状態を確認してください。" };
  }
}
