import type { Metadata } from 'next';
import Link from 'next/link';
export const metadata: Metadata = { title: '利用規約' };

export default function GmailTermsPage() {
  return <><p className="eyebrow">TERMS OF USE</p><h1>BELLO自社管理システムの利用規約</h1>
    <p>本規約は、株式会社BELLOが提供する業務用システムおよびGmail連携の利用条件を定めます。</p>
    <section><h2>1. 利用者と権限</h2><p>本システムは当社が許可した担当者の業務利用を対象とします。利用者は付与された権限の範囲で操作し、アカウント情報、顧客情報、取引情報を適切に管理してください。</p></section>
    <section><h2>2. Gmail連携</h2><p>接続できるのは、管理権限を有する業務用Gmailアカウントです。利用開始前に<Link href="/gmail-integration/privacy">プライバシーポリシー</Link>を確認してください。他人のメールアカウントの無断接続や、説明された業務目的を超えた情報の利用はできません。</p></section>
    <section><h2>3. 売却の確認</h2><p>通知から取得した値や手数料は入力を補助するものです。担当者は対象商品、在庫ID、数量、金額、決済方法、売買の成立状況を確認してから売却を確定してください。請求書の発行だけでは、入金・引渡し・売却の確定とはなりません。</p></section>
    <section><h2>4. 外部サービスと障害</h2><p>GoogleやECサービスの認可・仕様変更、通信状況により、通知の取得が遅延・停止する場合があります。取得失敗や保存結果不明の表示がある場合は処理状況を確認し、同じ内容を無条件に繰り返し登録しないでください。外部サービスの利用には当該サービスの規約が適用されます。</p></section>
    <section><h2>5. 利用停止・設定変更</h2><p>不正利用の防止や業務運用のため、当社は利用権限や連携設定を変更することがあります。データの利用目的や重要な条件を変更する場合は利用者へ案内し、必要な同意を取得します。連携解除と保存データの取扱いはプライバシーポリシーをご確認ください。</p></section>
    <section><h2>6. お問い合わせ</h2><p>運営：株式会社BELLO<br/>メール：<a href="mailto:bello050401@gmail.com">bello050401@gmail.com</a><br/>TEL：04-2997-9644</p></section>
  </>;
}
