import { MobileHeader } from "@/components/layout/MobileHeader";
import { MovementHistoryList } from "@/components/inventory/MovementHistoryList";

export default function ReceiveHistoryPage() {
  return (
    <div>
      <MobileHeader title="入庫一覧" />
      <MovementHistoryList type="RECEIVE" emptyLabel="入庫履歴がありません" />
    </div>
  );
}
