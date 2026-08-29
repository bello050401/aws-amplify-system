"use client";

import { useRef } from "react";

/**
 * BELLO統合改修 master指示書(2026-08-29統合改修版) §13: 日付欄の
 * UX要件3点 — (1) フィールドのどこをクリックしてもピッカーが開く、
 * (2) カレンダーアイコンは左側、(3) キーボード直接入力は引き続き可能
 * (禁止しない)。この1コンポーネントに集約し、日付入力を持つ3箇所
 * (ExtendedFieldsSection.tsx/FormFields.tsx/InventoryAdvancedSearchPanel.tsx)
 * がそれぞれ個別に実装しない — この既存アプリの「共通ロジックは1箇所
 * に定義する」方針(ExtendedFieldsSection.tsx自身のコメント参照)に
 * 合わせた。
 *
 * - (1): Chrome/Edge/Firefoxのネイティブ<input type="date">は元々
 *   フィールドのどこをクリックしてもピッカーが開く。それに加えて、
 *   対応ブラウザの標準API `HTMLInputElement.showPicker()` をクリック時
 *   に明示的に呼ぶことで、Safari等ネイティブ挙動がテキスト編集優先の
 *   環境でも確実にピッカーを開かせる — showPicker未対応環境
 *   ([UNVERIFIED]、この開発環境にはSafari実機が無いため実機確認は
 *   できていない)ではtry/catchで無視し、元のネイティブ挙動のまま
 *   動作する(壊れない)。
 * - (2): app/globals.cssの`.bello-date-field`
 *   (::-webkit-calendar-picker-indicatorの位置指定)とセットで機能する
 *   — WebKit/Blink系(Chrome/Edge/Safari)でのみアイコンが左へ移動し、
 *   Firefoxは非対応のため右側のまま(穏やかな劣化、崩れない)。
 * - (3): <input type="date">自体の標準キーボード入力機能は無変更 —
 *   このコンポーネントは onClick を1つ足しているだけで、キー入力経路
 *   には一切手を加えていない。
 */
export function DateField({
  value,
  onChange,
  className,
  required,
}: {
  value: string;
  onChange: (value: string) => void;
  className: string;
  required?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={ref}
      type="date"
      value={value}
      required={required}
      onChange={(e) => onChange(e.target.value)}
      onClick={() => {
        try {
          ref.current?.showPicker?.();
        } catch {
          // showPicker未対応、または既にピッカーが開いている等 —
          // 無視してネイティブの通常のクリック挙動に任せる。
        }
      }}
      className={`bello-date-field pl-8 ${className}`}
    />
  );
}
