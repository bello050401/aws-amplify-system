import Link from 'next/link';

export default function GmailIntegrationPage() {
  return <>
    <p className="eyebrow">BELLO / GMAIL INTEGRATION</p>
    <h1>購入通知から、正確な在庫管理へ。</h1>
    <p className="lead">BELLO自社管理システムは、株式会社BELLOの担当者が商品・在庫・売却情報を管理する業務用システムです。PCとiPhone用Webアプリから利用できます。</p>
    <p>Googleの連携画面では「Bello　system」と表示されます。</p>
    <section><h2>Gmail連携でできること</h2><p>BASE・メルカリShopsから届く購入通知を読み取り、商品名・数量・販売価格・注文IDなどを売却候補として取り込みます。担当者が商品画像と在庫を確認し、売却を確定すると在庫が更新されます。</p><p className="notice">メールを取得しただけで在庫が売却済みになることはありません。対象商品と数量は担当者が確認します。</p><p>既存の問い合わせ管理では、メルカリShopsの問い合わせ・取引メッセージ通知を取り込みます。設定に応じたAIによる返信案の作成や、社内担当者へのLINE通知で対応を支援します。購入通知の取得処理ではこれらの送信を行いません。</p></section>
    <section><h2>Googleへのアクセス範囲</h2><p>Gmailの読み取り権限を使用します。権限自体はメールを広く読み取れますが、取得処理は対応する送信元・件名・通知書式で対象を絞ります。メール送信・削除・既読変更の権限は要求しません。</p><p>取得する情報、保存期間、外部サービスでの処理は<Link href="/gmail-integration/privacy">プライバシーポリシー</Link>に記載しています。</p></section>
    <section><h2>利用できる方</h2><p>株式会社BELLOが許可した業務担当者が対象です。Gmail連携は管理者が行います。Googleで認可しただけでは、BELLOの業務画面や商品情報にはアクセスできません。</p><p><Link href="/gmail-integration/terms">利用規約</Link>を確認のうえご利用ください。</p><Link className="button" href="/inventory/login">BELLOのログイン画面へ</Link></section>
  </>;
}
