import type {ReactNode} from 'react';
import './preview.css';
import '../../../app/inventory/(protected)/sales/analysis/analysis.css';

export const viewport = {width:"device-width",initialScale:1};
export const metadata = {title:'BELLO｜売上・在庫分析の確認'};
export default function PreviewLayout({children}:{children:ReactNode}) {
  return <html lang="ja"><body><header className="preview-header"><strong>BELLO</strong><span>売上</span><small>検証用データ</small></header>{children}
    <nav className="preview-navigation" aria-label="下部ナビゲーション（表示見本）"><span>ホーム</span><span>在庫一覧</span><span>出庫</span><strong>売上</strong></nav>
  </body></html>;
}

