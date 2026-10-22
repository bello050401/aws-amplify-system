"use client";

import { useEffect, useState, useRef } from "react";
import type { InventoryImageRecord } from "@/lib/inventory/imageTypes";
import type { WebPhotoAssetView } from "@/lib/photoRegistration/webAdapter";
import type { ListingImageRef } from "@/lib/listing/types";
import {
  buildListingImageCandidates,
  restoreListingSelection,
  listingRefsFromSelection,
  initialListingSelection,
  type ListingImageCandidate,
} from "@/lib/photoRegistration/inventoryListingAdapter";
import {uploadData} from "aws-amplify/storage";
import {ConfigureAmplifyClientSide} from "@/lib/amplify/configureClient";
import {getListingOriginalDownloadAction} from "@/app/actions/listingImages";
import { InventoryThumbnail } from "../../../InventoryThumbnail";

const MAX_SELECTION = 20;

function candidateKey(candidate: ListingImageCandidate): string {
  return candidate.ref.photoAssetId ?? candidate.ref.storageKey;
}

export function ListingImageSelector({
  inventoryId,
  onBusy,
  images,
  photoAssets,
  initialImages,
  brandedImageKey,
  onChange,
}: {
  inventoryId: string;
  onBusy?: (busy:boolean)=>void;
  images: InventoryImageRecord[];
  photoAssets: WebPhotoAssetView[];
  initialImages: ListingImageRef[] | null;
  brandedImageKey?: string | null;
  onChange: (refs: ListingImageRef[]) => void;
}) {
  const [added,setAdded]=useState<ListingImageCandidate[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const fileInput=useRef<HTMLInputElement>(null),lock=useRef(false);
  const candidates = [...buildListingImageCandidates(images, photoAssets, initialImages, brandedImageKey ?? null),...added];

  const [selected, setSelected] = useState<ListingImageCandidate[]>(() => {
    return initialListingSelection(candidates, initialImages);
  });
  const [missingCount] = useState<number>(() =>
    initialImages && initialImages.length > 0 ? restoreListingSelection(candidates, initialImages).missing.length : 0,
  );

  const selectedKeys = new Set(selected.map(candidateKey));
  const available = candidates.filter((c) => !selectedKeys.has(candidateKey(c)));

  useEffect(() => {
    onChange(listingRefsFromSelection(selected));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  useEffect(() => {
    if (!brandedImageKey) return;
    setSelected((current) => {
      const branded = candidates.find((item) => item.ref.storageKey === brandedImageKey);
      if (!branded) return current;
      if (current.length >= MAX_SELECTION && !current.some((item) => item.ref.storageKey === brandedImageKey)) return current;
      return [branded, ...current.filter((item) => item.ref.storageKey !== brandedImageKey)];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brandedImageKey]);

  async function uploadFiles(files:FileList|null){
    if(!files?.length||lock.current)return;
    const picked=Array.from(files);
    if(selected.length+picked.length>MAX_SELECTION){setError('出品画像は20枚までです。');return;}
    if(picked.some(file=>!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>20*1024*1024)){setError('JPEG・PNG・WebPの20MB以下の画像を選択してください。');return;}
    lock.current=true;setBusy(true);onBusy?.(true);setError('');
    try{for(const file of picked){const ext=file.type==='image/jpeg'?'jpg':file.type==='image/png'?'png':'webp';
      const storageKey='inventory/listing-upload/'+inventoryId+'/'+crypto.randomUUID()+'.'+ext;
      await uploadData({path:storageKey,data:file,options:{contentType:file.type}}).result;
      const c:ListingImageCandidate={ref:{storageKey,source:'INVENTORY',sortOrder:0},label:file.name,previewUrl:null,available:true};
      setAdded(old=>[...old,c]);setSelected(old=>[...old,c]);
    }}catch{setError('画像を追加できませんでした。追加済みの画像は残しています。通信を確認してください。');}
    finally{lock.current=false;setBusy(false);onBusy?.(false);if(fileInput.current)fileInput.current.value='';}
  }
  async function download(candidate:ListingImageCandidate){
    setError('');try{const r=await getListingOriginalDownloadAction(inventoryId,candidate.ref.storageKey);if(!r.ok){setError(r.message);return;}const a=document.createElement('a');a.href=r.url;a.download='';a.click();}catch{setError('元画像を取得できませんでした。');}
  }
  function addCandidate(candidate: ListingImageCandidate) {
    if (lock.current) return;
    setSelected(prev=>prev.length>=MAX_SELECTION||prev.some(c=>candidateKey(c)===candidateKey(candidate))?prev:[...prev,candidate]);
  }
  function removeCandidate(candidate: ListingImageCandidate) {
    setSelected((prev) => prev.filter((c) => candidateKey(c) !== candidateKey(candidate)));
  }
  function moveUp(index: number) {
    if (index <= 0) return;
    setSelected((prev) => {
      const next = prev.slice();
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }
  function moveDown(index: number) {
    setSelected((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = prev.slice();
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
  }
  function makePrimary(index: number) {
    if (index <= 0) return;
    setSelected((prev) => {
      const next = prev.slice();
      const [item] = next.splice(index, 1);
      next.unshift(item);
      return next;
    });
  }

  function thumbnailFor(candidate: ListingImageCandidate) {
    if (candidate.ref.source === "PHOTO_ASSET") {
      return candidate.previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- 署名済みS3 URL(photo registration用バケット)
        <img src={candidate.previewUrl} alt={candidate.label} className="h-[60px] w-[60px] shrink-0 border border-gray-200 object-cover" />
      ) : (
        <div className="flex h-[60px] w-[60px] shrink-0 items-center justify-center border border-gray-200 bg-gray-50 text-[9px] text-gray-400">
          No Image
        </div>
      );
    }
    return <InventoryThumbnail storageKey={candidate.ref.storageKey} alt={candidate.label} size="medium" />;
  }

  return (
    <div className="mt-4 border border-gray-200 p-3">
      <ConfigureAmplifyClientSide />
      <button type="button" className="mb-3 rounded border border-blue-500 px-3 py-2 text-sm text-blue-700 disabled:opacity-40" disabled={busy||selected.length>=MAX_SELECTION} onClick={()=>fileInput.current?.click()}>{busy?'追加中…':'＋ 画像を追加'}</button>
      <input aria-label="追加する出品画像" ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={e=>void uploadFiles(e.target.files)}/>
      {error&&<p role="alert" className="mb-2 text-sm text-red-700">{error}</p>}
      <p className="mb-2 text-xs text-gray-500">追加・削除後は共通の商品情報を保存してください。出品画像から削除しても在庫の元画像は残ります。</p>
      <p className="mb-2 text-[12px] font-bold text-gray-700">出品画像（各販売先へこの順番で反映します。先頭が主画像）</p>
      {missingCount > 0 && (
        <p className="mb-2 text-[11px] text-amber-700">
          {missingCount}件の保存済み画像を復元できませんでした（削除済みの可能性があります）。
        </p>
      )}
      {selected.length === 0 ? (
        <p className="text-[11px] text-amber-700">出品画像が選択されていません。</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {selected.map((candidate, index) => (
            <li key={candidateKey(candidate)} className="flex items-center gap-2 border border-gray-100 p-1">
              {thumbnailFor(candidate)}
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-gray-600">{candidate.label}</p>
                {index === 0 && <p className="text-[10px] font-bold text-blue-700">主画像</p>}
              </div>
              <div className="flex shrink-0 flex-wrap gap-1">
                <button type="button" onClick={()=>void download(candidate)} className="border px-2 py-1 text-xs text-blue-700" title={candidate.ref.source==='PHOTO_ASSET'?'フォトステーションから保存した画像を取得します（撮影原本はPCに保存されています）':'保存された元サイズの画像を取得します'}>元画像をダウンロード</button>
                <button type="button" onClick={() => moveUp(index)} disabled={index === 0} className="border border-gray-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30">
                  ↑
                </button>
                <button type="button" onClick={() => moveDown(index)} disabled={index === selected.length - 1} className="border border-gray-300 px-1.5 py-0.5 text-[11px] disabled:opacity-30">
                  ↓
                </button>
                {index !== 0 && (
                  <button type="button" onClick={() => makePrimary(index)} className="border border-gray-300 px-1.5 py-0.5 text-[11px]">
                    主画像にする
                  </button>
                )}
                <button type="button" onClick={() => removeCandidate(candidate)} className="border border-gray-300 px-1.5 py-0.5 text-[11px] text-red-600">
                  削除
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {available.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 text-[11px] font-bold text-gray-500">候補（クリックで追加）</p>
          <div className="flex flex-wrap gap-1">
            {available.map((candidate) => (
              <button
                key={candidateKey(candidate)}
                type="button"
                onClick={() => addCandidate(candidate)}
                disabled={busy||selected.length >= MAX_SELECTION}
                title={candidate.label}
                aria-label={candidate.label+"を出品画像に追加"}
                className="opacity-80 hover:opacity-100 disabled:opacity-30"
              >
                {thumbnailFor(candidate)}<span className="block text-xs text-blue-700">＋追加</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {selected.length >= MAX_SELECTION && <p className="mt-1 text-[10px] text-gray-400">出品画像は最大{MAX_SELECTION}枚までです。</p>}
    </div>
  );
}
