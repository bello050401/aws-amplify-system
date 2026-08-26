import { SearchClient } from "./SearchClient";

export default function AdminSearchPage() {
  return (
    <div>
      <h1 className="text-lg font-normal text-ink">商品検索</h1>
      <p className="mt-1 text-sm text-muted">
        キーワードで検索し、特集に含める商品を選択してください。
      </p>
      <SearchClient />
    </div>
  );
}
