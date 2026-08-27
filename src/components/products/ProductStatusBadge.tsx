import type { ProductInternalStatus } from "@prisma/client";

const STATUS_LABEL: Record<ProductInternalStatus, string> = {
  DRAFT: "下書き",
  READY: "出品可能",
  PUBLISHED: "出品中",
  SOLD_OUT: "売り切れ",
  HIDDEN: "非公開",
  ERROR: "APIエラー",
};

const STATUS_STYLE: Record<ProductInternalStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  READY: "bg-blue-50 text-blue-700",
  PUBLISHED: "bg-green-50 text-green-700",
  SOLD_OUT: "bg-amber-50 text-amber-700",
  HIDDEN: "bg-slate-100 text-slate-500",
  ERROR: "bg-red-50 text-red-700",
};

export function ProductStatusBadge({ status }: { status: ProductInternalStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
