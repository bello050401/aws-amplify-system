"use client";

import { useEffect, useState } from "react";
import { uploadData } from "aws-amplify/storage";
import { createPhotoProfileAction, listPhotoProfilesAction, setActivePhotoProfileAction, type PhotoProfileSummary } from "@/app/actions/imageProcessing";

/**
 * BELLO画像自動加工システム(2026-08-30指示書)§8.1: 「設定UIを必ず作る
 * ——理想写真を単にコード内の固定サンプルとして扱わない」の実装。
 * このラウンドで実装済みなのは基準写真の追加・一覧・version管理・
 * ACTIVE切替まで——「Profile再解析」(自動分類モデルによる基準値の
 * 自動再計算)はSubjectSegmentationProvider未実装のため対応していない
 * (types.tsのコメント参照)。基準値・許容範囲の手動微調整UIも今回は
 * 見送り(pipeline.tsのDEFAULT_OCCUPANCY_RANGEを毎回そのまま使う)。
 *
 * 参照写真はinventory/*プレフィックス配下(amplify/storage/resource.ts
 * の既存IAM境界をそのまま使う——新しいprefixを追加するとstorage側の
 * IAM設定変更が必要になるため、意図的にinventory/photo-profile/を
 * 選んだ)。
 */
export function PhotoProfilePanel() {
  const [profiles, setProfiles] = useState<PhotoProfileSummary[] | null>(null);
  const [name, setName] = useState("");
  const [pendingKeys, setPendingKeys] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setProfiles(await listPhotoProfilesAction());
  }

  useEffect(() => {
    refresh().catch((err) => setError(err instanceof Error ? err.message : "読み込みに失敗しました。"));
  }, []);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    try {
      const keys: string[] = [];
      for (const file of Array.from(files)) {
        const path = `inventory/photo-profile/${crypto.randomUUID()}.jpg`;
        await uploadData({ path, data: file, options: { cacheControl: "public, max-age=31536000, immutable" } }).result;
        keys.push(path);
      }
      setPendingKeys((prev) => [...prev, ...keys]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "アップロードに失敗しました。");
    } finally {
      setUploading(false);
    }
  }

  async function handleCreate() {
    setBusy(true);
    setError(null);
    try {
      await createPhotoProfileAction(name, pendingKeys);
      setName("");
      setPendingKeys([]);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "作成に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  async function handleActivate(id: string) {
    setBusy(true);
    setError(null);
    try {
      await setActivePhotoProfileAction(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "切替に失敗しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-3xl">
      <p className="mb-2 text-[12px] text-gray-500">
        画像自動加工の基準となる理想写真(Photo Profile)を管理します。約10枚程度から開始し、随時追加できます。新しいProfileを作成するとACTIVEが自動的に切り替わります(旧Profileは履歴として残ります)。
      </p>

      <div className="mb-4 border border-gray-200 p-3">
        <p className="mb-2 text-[11px] font-bold text-gray-700">新しいPhoto Profileを作成</p>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Profile名(例: 2026-09 木製家具基準)"
          className="mb-2 w-full border border-gray-300 px-2 py-1 text-[12px]"
        />
        <input type="file" accept="image/*" multiple onChange={(e) => handleFiles(e.target.files)} disabled={uploading} className="mb-2 text-[12px]" />
        {pendingKeys.length > 0 && <p className="mb-2 text-[11px] text-gray-500">{pendingKeys.length}枚アップロード済み</p>}
        <button
          type="button"
          onClick={handleCreate}
          disabled={busy || uploading || pendingKeys.length === 0}
          className="bg-gray-900 px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
        >
          {busy ? "作成中…" : "作成してACTIVEにする"}
        </button>
      </div>

      {error && <p className="mb-2 text-[12px] text-red-600">{error}</p>}

      <p className="mb-1 text-[11px] font-bold text-gray-400">Profile一覧(version降順)</p>
      {profiles === null ? (
        <p className="text-[12px] text-gray-400">読み込み中…</p>
      ) : profiles.length === 0 ? (
        <p className="text-[12px] text-gray-400">まだPhoto Profileがありません。</p>
      ) : (
        <table className="w-full border-collapse text-[12px]">
          <thead className="bg-gray-50 text-gray-500">
            <tr className="border-b border-gray-200">
              <th className="px-2 py-1 text-left font-normal">v</th>
              <th className="px-2 py-1 text-left font-normal">名前</th>
              <th className="px-2 py-1 text-left font-normal">基準写真数</th>
              <th className="px-2 py-1 text-left font-normal">状態</th>
              <th className="px-2 py-1"></th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr key={p.id} className="border-b border-gray-100">
                <td className="px-2 py-1">{p.version}</td>
                <td className="px-2 py-1">{p.name}</td>
                <td className="px-2 py-1">{p.referenceImageKeys.length}枚</td>
                <td className="px-2 py-1">{p.active ? <span className="font-bold text-emerald-700">ACTIVE</span> : <span className="text-gray-400">履歴</span>}</td>
                <td className="px-2 py-1">
                  {!p.active && (
                    <button type="button" onClick={() => handleActivate(p.id)} disabled={busy} className="text-[11px] text-gray-500 hover:text-gray-900">
                      ACTIVEにする
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
