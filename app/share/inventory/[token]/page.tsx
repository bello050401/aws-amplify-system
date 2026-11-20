import type { Metadata } from 'next';
import { PublicCatalog } from './PublicCatalog';

export const metadata: Metadata = {
  title: 'BELLO 商品カタログ',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false, noimageindex: true } },
  referrer: 'no-referrer',
};

export default async function SharedInventoryPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicCatalog token={token} />;
}
