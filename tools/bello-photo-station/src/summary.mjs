/**
 * 完了時/一部失敗時に画面へ出す文言を組み立てる。仕様の「完了時の表示例」
 * と一致させる。UI(WPF/CLI どちらから呼んでも同じ文言になるよう、
 * 表示テキストの生成だけをここに切り出す。
 */
export function formatSummary(result, { photoCount }) {
  if (result.status === "COMPLETE") {
    return [
      `写真${photoCount}枚の編集と検証環境へのアップロードが完了しました。`,
      "BELLO画像登録画面から商品との紐付けを行えます。",
      "SDカードを取り外せます。",
    ].join("\n");
  }
  const failedNames = [...result.editFailures, ...result.uploadFailures].map((f) => f.fileName);
  const succeeded = result.uploaded.length;
  return [
    `写真${photoCount}枚中${succeeded}枚の編集・アップロードが完了し、${failedNames.length}枚が失敗しました(${failedNames.join("、")})。`,
    "失敗した画像は原本を保持したまま再実行できます。",
    "アップロード済みの画像が二重送信されることはありません。",
  ].join("\n");
}
