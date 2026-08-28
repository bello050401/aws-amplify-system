/**
 * BELLO独自のシンプルなラインアイコンセット。
 * ZAICO等のアイコン資産は使用せず、最小限のSVGパスで独自に用意する。
 */
type IconProps = { className?: string };

const base = "h-6 w-6";

export function HomeIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <path d="M4 11.5 12 4l8 7.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6 10v9h12v-9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 19v-5h4v5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ListIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="5" width="4" height="4" rx="1" />
      <rect x="4" y="15" width="4" height="4" rx="1" />
      <path d="M11 7h9M11 17h9" strokeLinecap="round" />
    </svg>
  );
}

export function ReceiveIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <path d="M12 3v11" strokeLinecap="round" />
      <path d="M7.5 10 12 14.5 16.5 10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v3h16v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ShipIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <path d="M12 17V6" strokeLinecap="round" />
      <path d="M7.5 10 12 5.5 16.5 10" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 17v3h16v-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function StocktakeIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m8 12 3 3 5-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function BulkIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function NewItemIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <rect x="4" y="6" width="16" height="14" rx="2" />
      <path d="M8 6V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1" />
      <path d="M12 11v5M9.5 13.5h5" strokeLinecap="round" />
    </svg>
  );
}

export function ScanIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M4 16v2a2 2 0 0 0 2 2h2M20 8V6a2 2 0 0 0-2-2h-2M20 16v2a2 2 0 0 1-2 2h-2" strokeLinecap="round" />
      <path d="M4 12h16" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon({ className = base }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.3-4.3" strokeLinecap="round" />
    </svg>
  );
}

export function PinIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={1.8}>
      <path d="M12 21s-6.5-6.09-6.5-11A6.5 6.5 0 0 1 18.5 10c0 4.91-6.5 11-6.5 11Z" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.2" />
    </svg>
  );
}

export function ChevronRight({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} stroke="currentColor" strokeWidth={2}>
      <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
