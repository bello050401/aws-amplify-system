import type { Metadata } from 'next';
import Link from 'next/link';
import './public.css';

export const metadata: Metadata = {
  title: { default: 'BELLO｜Gmail連携', template: '%s｜BELLO Gmail連携' },
  description: '株式会社BELLOの業務用システムとGmail連携に関する説明、データの取扱い、利用条件。',
};

export default function GmailInformationLayout({ children }: { children: React.ReactNode }) {
  return <div className="gmail-public">
    <header><Link className="brand" href="/gmail-integration">BELLO <span>自社管理システム</span></Link>
      <nav aria-label="Gmail連携のご案内"><Link href="/gmail-integration">アプリについて</Link><Link href="/gmail-integration/privacy">プライバシーポリシー</Link><Link href="/gmail-integration/terms">利用規約</Link></nav>
    </header>
    <main>{children}</main>
    <footer><strong>株式会社BELLO</strong><p>〒359-0011 埼玉県所沢市南永井939-1<br/>TEL：04-2997-9644<br/><a href="mailto:bello050401@gmail.com">bello050401@gmail.com</a></p><small>2026年10月25日制定</small></footer>
  </div>;
}
