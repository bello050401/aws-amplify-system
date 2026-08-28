"use client";

import { BottomNavigation } from "./BottomNavigation";
import { DesktopSidebar } from "./DesktopSidebar";

/**
 * PC版・モバイル版共通の外枠。中身(ページ)はレスポンシブなTailwindクラスで
 * 自身をPC/モバイル両対応にし、この外枠がナビゲーションの出し分けを担当する
 * (指示書 §2, §28: 同じNext.jsアプリ内でレスポンシブに処理し、/mobileを無理に分けない)。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-surface-muted">
      <DesktopSidebar />
      <div className="flex min-h-screen flex-1 flex-col">
        <main className="flex-1 pb-safe-nav md:pb-0">
          <div className="mx-auto w-full max-w-4xl md:px-6 md:py-6">{children}</div>
        </main>
      </div>
      <BottomNavigation />
    </div>
  );
}
