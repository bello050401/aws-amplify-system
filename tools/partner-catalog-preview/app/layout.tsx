import './preview.css';
export const metadata={title:'BELLO private QA fixture',robots:{index:false,follow:false},referrer:'no-referrer' as const};
export default function Layout({children}:{children:React.ReactNode}){return <html lang="ja"><body><aside className="qa-banner">非公開QA・検証用データ <a href="/share/inventory/demo">通常</a><a href="/share/inventory/empty">0件</a><a href="/share/inventory/expired">期限切れ</a><a href="/share/inventory/error">取得失敗</a><a href="/manage">管理</a></aside>{children}</body></html>}
