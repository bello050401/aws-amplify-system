"use server";

import { getInventoryRole } from "@/lib/amplify/requireInventoryUser";
import { generateSystemAuditReport } from "@/lib/systemAudit/report";

/**
 * §7: BELLO System Audit Reportの生成Server Action。ADMIN限定
 * (レポート自体に秘密情報は含まれないが、AI利用コスト等の経営情報を
 * 含むため、他の経営判断系設定と同じADMIN境界に揃える)。
 */
export async function generateSystemAuditReportAction(): Promise<string> {
  const role = await getInventoryRole();
  if (role !== "ADMIN") throw new Error("この操作にはADMIN権限が必要です。");
  return generateSystemAuditReport();
}
