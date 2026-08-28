import { MobileHeader } from "@/components/layout/MobileHeader";
import { MovementHistoryList } from "@/components/inventory/MovementHistoryList";

export default function ShipHistoryPage() {
  return (
    <div>
      <MobileHeader title="出庫一覧" />
      <MovementHistoryList type="SHIP" emptyLabel="出庫履歴がありません" />
    </div>
  );
}
