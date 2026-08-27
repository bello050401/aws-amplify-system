"use client";

import { useRouter } from "next/navigation";
import { signOut } from "aws-amplify/auth";
import { ConfigureAmplifyClientSide } from "@/lib/amplify/configureClient";
import type { InventoryRole } from "@/lib/amplify/requireInventoryUser";

const ROLE_LABEL: Record<InventoryRole, string> = {
  ADMIN: "管理者 (ADMIN)",
  EDITOR: "編集者 (EDITOR)",
  VIEWER: "閲覧のみ (VIEWER)",
};

export function InventoryTopBar({ role }: { role: InventoryRole }) {
  const router = useRouter();
  return (
    <div className="flex h-9 items-center justify-end gap-4 border-b border-gray-200 bg-white px-4 text-xs text-gray-500">
      <ConfigureAmplifyClientSide />
      <span>{ROLE_LABEL[role]}</span>
      <button
        onClick={async () => {
          await signOut();
          router.push("/inventory/login");
        }}
        className="text-gray-500 hover:text-gray-900"
      >
        ログアウト
      </button>
    </div>
  );
}
