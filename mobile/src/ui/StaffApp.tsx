import {splitCategoryNames} from '../../../lib/inventory/categories';
import {newInventoryDefaults} from '../../../lib/inventory/newInventoryDefaults';
import { InventorySearchScreen, InventorySortSheet } from "./InventorySearchScreen";
import { cachedInventorySearch, cachedSearchFields, mobileSearchFields, DEFAULT_INVENTORY_SORT, type InventorySearchInput, type AdvancedSearchQuery, type InventorySort } from "../domain/search";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { InventoryEditor, type EditorPorts } from "../domain/editor";
import { mergeInventoryRead, mergeInventoryThumbnails, type InventoryThumbnail, type InventoryItem, type InventoryOptions } from "../domain/inventory";
import { SnapshotStore, type InventorySnapshot } from "../domain/snapshot";
import { InventoryEditorScreen } from "./InventoryEditorScreen";
import {StockSplitScreen,type StockSplitPorts} from './StockSplitScreen';
import {SoldOutScreen,type SoldOutPorts,type SoldOutSaved} from './SoldOutScreen';
import { colors } from "./theme";
import { canOpenTab, permittedTab, RESTRICTED_FEATURES, type MobileFeatures } from "../domain/access";
import { visibleDetailFields } from "../domain/detailFields";
import { InventoryPhotos } from "./InventoryPhotos";
import {BarcodeScanner} from "./BarcodeScanner";
import {SalesScreen, type SalesResponse} from "./SalesScreen";
import { InventoryReadError } from "../domain/readError";
import { HomeScreen } from "./HomeScreen";
import { OutboundEntry } from "./OutboundEntry";
import { PullToRefreshList } from "./PullToRefreshList";
import { DetailSwipeBack } from "./DetailSwipeBack";
import { deletionWarning, inventoryCopyDraft, removeConfirmedInventory, type DeleteRequest } from "../domain/inventoryActions";

type Tab = "home" | "inventory" | "outbound" | "sales";
type IconName = React.ComponentProps<typeof Ionicons>["name"];
const tabs: { key: Tab; label: string; icon: IconName }[] = [
  { key: "home", label: "ホーム", icon: "home" }, { key: "inventory", label: "在庫一覧", icon: "list" },
  { key: "outbound", label: "出庫", icon: "exit-outline" }, { key: "sales", label: "売上", icon: "stats-chart" },
];
export interface StaffAppPorts extends EditorPorts {
  snapshot: SnapshotStore;
  loadInventory: () => Promise<InventoryItem[]>;
  searchInventory?: (input: InventorySearchInput) => Promise<{ items: InventoryItem[]; imagesDeferred?: boolean; hasMore: boolean; nextOffset?: number; total?: number | null; totalQuantity?: number | null }>;
  loadThumbnails?: (ids: string[]) => Promise<InventoryThumbnail[]>;
  loadOptions?: () => Promise<InventoryOptions>;
  loadSales?: (year:number,month:number,items?:boolean)=>Promise<SalesResponse>;
  loadDetail?: (id: string) => Promise<InventoryItem>;
  removeInventory?: (request: DeleteRequest) => Promise<void>;
  sell?: SoldOutPorts['sell'];
  split?: StockSplitPorts['split']; checkBarcode?: StockSplitPorts['checkBarcode'];
  openEcListing?: () => Promise<void>;
}

export function StaffApp({ ports, offline, preview, onToggleOffline, onLogout, writesEnabled = false, canIssueDocuments = false, canSellInventory = false, features = RESTRICTED_FEATURES, previewAccount, onTogglePreviewAccount }: {
  ports: StaffAppPorts; offline: boolean; preview?: boolean; onToggleOffline?: () => void; onLogout?: () => void; writesEnabled?: boolean;
  canIssueDocuments?: boolean; canSellInventory?: boolean; features?: MobileFeatures; previewAccount?: string; onTogglePreviewAccount?: () => void;
}) {
  const [scanSearch,setScanSearch]=useState(false);
  const [creating,setCreating]=useState(false);
  const [requestedTab, setTab] = useState<Tab>("home");
  // Filter the screen as well as navigation, including when access changes on an open screen.
  const tab = permittedTab(requestedTab, features);
  const visibleTabs = tabs.filter(item => canOpenTab(item.key, features));
  useEffect(() => { if (requestedTab !== tab) setTab(tab); }, [requestedTab, tab]);
  const [snapshot, setSnapshot] = useState<InventorySnapshot | null>(null);
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [editor, setEditor] = useState<InventoryEditor | null>(null);
  const [splitting,setSplitting]=useState<InventoryItem|null>(null);
  const [selling,setSelling]=useState<InventoryItem|null>(null);
  const [deleteTarget, setDeleteTarget] = useState<InventoryItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deleteBusy = useRef(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [serverRows, setServerRows] = useState<InventoryItem[] | null>(null);
  const [advanced,setAdvanced]=useState<AdvancedSearchQuery>({combinator:"AND",conditions:[]});
  const [sort,setSort]=useState<InventorySort>(DEFAULT_INVENTORY_SORT);
  const [searchOpen,setSearchOpen]=useState(false);
  const [sortOpen,setSortOpen]=useState(false);
  const [options,setOptions]=useState<InventoryOptions|null>(null);
  const [total,setTotal]=useState<number|null>(null);
  const [totalQuantity,setTotalQuantity]=useState<number|null>(null);
  const [hasMore, setHasMore] = useState(false);
  const nextOffset = useRef(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const detailGeneration = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [categoryPicker, setCategoryPicker] = useState(false);
  const [feature, setFeature] = useState<string | null>(null);
  const generation = useRef(0);
  const imageGeneration = useRef(0);

  useEffect(() => {
    let active = true;
    ports.snapshot.read().then((cached) => { if (active) setSnapshot((current) => current ?? cached); })
      .catch(() => { if (active) setError("保存済みの在庫を読み込めませんでした。"); });
    return () => { active = false; generation.current++; imageGeneration.current++; detailGeneration.current++; };
  }, [ports]);

  useEffect(()=>{
    let active=true;
    if (!offline && ports.loadOptions) void ports.loadOptions().then(value=>{if(active)setOptions(value);}).catch(()=>{});
    return ()=>{active=false;};
  },[ports,offline]);
  const searchFields=options?.searchFields ? mobileSearchFields(options.searchFields,features) : cachedSearchFields(snapshot?.items ?? [],features);
  const refresh = async (append = false) => {
    if (append && loading) return;
    const currentGeneration = ++generation.current;
    if (!append) imageGeneration.current++;
    const currentImageGeneration = imageGeneration.current;
    setLoading(true); setError(null);
    try {
      const online = await ports.online();
      if (currentGeneration !== generation.current) return;
      if (!online) { setError("【圏外です】"); return; }
      const input = { q: query, category, advanced, sort, offset: append ? nextOffset.current : 0 };
      const page = ports.searchInventory ? await ports.searchInventory(input) : null;
      const received = page ? page.items : await ports.loadInventory();
      if (currentGeneration !== generation.current) return;
      const fresh = mergeInventoryRead(snapshotRef.current?.items ?? [], received, page?.imagesDeferred);
      const items = page ? [...fresh, ...(snapshotRef.current?.items ?? []).filter(row => !fresh.some(item => item.id === row.id))].slice(0, 500) : fresh;
      if (page) {
        setServerRows(previous => append ? [...(previous ?? []), ...fresh.filter(item => !previous?.some(row => row.id === item.id))] : fresh);
        nextOffset.current = page.nextOffset ?? ((append ? nextOffset.current : 0) + received.length);
        setTotal(page.total ?? null);setTotalQuantity(page.totalQuantity ?? null);
        setHasMore(page.hasMore);
      }
      const fetchedAt = new Date().toISOString();
      const next = { schema: 1 as const, owner: "current", items, fetchedAt };
      snapshotRef.current = next; setSnapshot(next);
      // Rendering/refresh completion must not wait for the offline copy or image lookups.
      void ports.snapshot.write(items, fetchedAt).catch(() => {
        if (currentGeneration === generation.current) setError("在庫を読み込みましたが、この端末に圏外用のデータを保存できませんでした。");
      });
      if (page?.imagesDeferred && ports.loadThumbnails) void ports.loadThumbnails(received.map(item => item.id)).then(thumbnails => {
        if (currentImageGeneration !== imageGeneration.current) return;
        setServerRows(rows => rows && mergeInventoryThumbnails(rows, thumbnails));
        const current = snapshotRef.current;
        if (!current) return;
        const withImages = { ...current, items: mergeInventoryThumbnails(current.items, thumbnails) };
        snapshotRef.current = withImages; setSnapshot(withImages);
        void ports.snapshot.write(withImages.items, withImages.fetchedAt).catch(() => {
          if (currentImageGeneration === imageGeneration.current) setError("在庫は更新しましたが、画像を端末に保存できませんでした。");
        });
      }).catch(() => {
        if (currentImageGeneration === imageGeneration.current) setError("在庫は更新しましたが、画像を読み込めませんでした。下に引くと再読み込みできます。");
      });
    } catch {
      if (currentGeneration === generation.current) setError("在庫を読み込めませんでした。保存済みの在庫があれば表示します。");
    } finally {
      if (currentGeneration === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    // Invalidate an older response immediately when search changes.
    generation.current++;
    imageGeneration.current++;
    setServerRows(null); setHasMore(false); setTotal(null);setTotalQuantity(null);
    const timer = setTimeout(() => { void refresh(); }, query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [ports, query, category, advanced, sort]); // Reconnection never submits edits.

  const updateSavedItem = (item: InventoryItem) => {
    setServerRows(rows => rows ? [item,...rows.filter(row=>row.id!==item.id)] : null);
    const items = [item,...(snapshot?.items ?? []).filter(row=>row.id!==item.id)].slice(0,500);
    // Only this record was refreshed; preserve the list's last-fetch timestamp.
    const fetchedAt = snapshot?.fetchedAt ?? new Date().toISOString();
    setSnapshot({ schema: 1, owner: "current", fetchedAt, items });
    void ports.snapshot.write(items, fetchedAt).catch(() => setError("変更は保存済みですが、端末の保存データを更新できませんでした。"));
    if (ports.searchInventory) void refresh();
  };
  const saved = (item: InventoryItem) => {
    updateSavedItem(item);
    setEditor(null); setSelected(null); setTab("inventory");
  };
  const sold = ({sold,source}:SoldOutSaved) => {
    const changed=new Map([source,sold].map(item=>[item.id,item]));
    const items=[...changed.values(),...(snapshot?.items??[]).filter(item=>!changed.has(item.id))].slice(0,500);
    const fetchedAt=snapshot?.fetchedAt??new Date().toISOString();
    setSnapshot({schema:1,owner:'current',fetchedAt,items});
    setServerRows(rows=>rows?[...changed.values(),...rows.filter(item=>!changed.has(item.id))]:null);
    void ports.snapshot.write(items,fetchedAt).catch(()=>setError('保存済みですが、端末の保存データを更新できませんでした。'));
    setSelling(null);setSelected(sold);setTab('inventory');
    if(ports.searchInventory)void refresh();
  };
  const startCreate=async()=>{
    if(creating)return;
    if(!writesEnabled){setError("在庫を登録する権限がありません。");return;}
    setCreating(true);setError(null);
    let options:InventoryOptions={categories:[],locations:[],statuses:[]};
    try{if(ports.loadOptions&&await ports.online())options=await ports.loadOptions();}
    catch{setError("選択肢を取得できませんでした。通信状態を確認してください。");}
    const defaults=newInventoryDefaults(options.categories.map(name=>({name})),options.locations.map(name=>({name})));
    const item:InventoryItem={id:ports.newMutationId(),sku:"保存時に自動採番",name:"",quantity:1,unit:"",location:defaults.location?.name??"",category:defaults.category?.name??"",condition:"",statusId:null,
      note:"",barcode:"",plannedSalePrice:null,thumbnailUrl:null,updatedAt:new Date().toISOString(),details:{},photos:[],photosComplete:true,
      statusOptions:options.statuses,categoryOptions:options.categories,locationOptions:options.locations};
    setEditor(new InventoryEditor(item,ports,true));setCreating(false);
  };
  const leaveEditor = () => { setEditor(null); setSelected(null); setError(null); setTab("inventory"); };
  const returnFromDetail = () => {
    detailGeneration.current++; setDetailLoading(false); setSelected(null); setFeature(null); setError(null); setTab("inventory");
  };
  const startCopy = () => {
    if (!selected || !writesEnabled || detailLoading) return;
    if (!selected.detailLoadedAt || !selected.photosComplete) { setError("写真を含む商品詳細を読み込んでからコピーしてください。"); return; }
    const draft = inventoryCopyDraft(selected, ports.newMutationId(), new Date().toISOString());
    setError(null);
    setEditor(new InventoryEditor(draft, ports, true, { id: selected.id, updatedAt: selected.updatedAt }));
  };
  const confirmDelete = async () => {
    if (!deleteTarget || !ports.removeInventory || !writesEnabled || deleteBusy.current) return;
    deleteBusy.current = true; setDeleting(true); setDeleteError(null);
    try {
      await removeConfirmedInventory(deleteTarget, { online: ports.online, removeInventory: ports.removeInventory });
      generation.current++; detailGeneration.current++; setLoading(false); setDetailLoading(false);
      const items = (snapshotRef.current?.items ?? []).filter(item => item.id !== deleteTarget.id);
      const fetchedAt = snapshotRef.current?.fetchedAt ?? new Date().toISOString();
      const next = { schema: 1 as const, owner: "current", items, fetchedAt };
      snapshotRef.current = next; setSnapshot(next);
      setServerRows(rows => rows?.filter(item => item.id !== deleteTarget.id) ?? null);
      setSelected(null); setDeleteTarget(null); setTab("inventory"); setError(null);
      try { await ports.snapshot.write(items, fetchedAt); }
      catch { setError("商品は削除しましたが、端末の保存データを更新できませんでした。再読み込みしてください。"); }
      if (ports.searchInventory) void refresh();
    } catch (error) { setDeleteError(deletionWarning(error)); }
    finally { deleteBusy.current = false; setDeleting(false); }
  };
  const openItem = async (item: InventoryItem) => {
    const attempt = ++detailGeneration.current;
    setSelected(item); setError(null); setDetailLoading(false);
    if (!ports.loadDetail) return;
    setDetailLoading(true);
    try {
      const online = await ports.online();
      if (attempt !== detailGeneration.current) return;
      if (!online) {
        if (!item.detailLoadedAt) setError("【圏外です】この商品の詳細は未取得です。保存済みの基本情報を表示しています。");
        return;
      }
      const detail = await ports.loadDetail(item.id);
      if (attempt !== detailGeneration.current) return;
      if (detail.id !== item.id) throw new Error("Detail identity mismatch");
      setSelected(detail);
      const current = snapshotRef.current;
      if (current) {
        const next = { ...current, items: current.items.map(row => row.id === detail.id ? detail : row) };
        snapshotRef.current = next; setSnapshot(next);
        try { await ports.snapshot.write(next.items, next.fetchedAt); }
        catch { if (attempt === detailGeneration.current) setError("最新の商品詳細を表示していますが、圏外用の保存ができませんでした。"); }
      }
    } catch (error) {
      if (attempt !== detailGeneration.current) return;
      if (error instanceof InventoryReadError && error.code === "not_found") {
        // Only an authenticated 404 confirms deletion. Keep cached records on network/server failures.
        setSelected(null); setTab("inventory");
        setServerRows(rows => rows?.filter(row => row.id !== item.id) ?? null);
        const current = snapshotRef.current;
        if (current) {
          const next = { ...current, items: current.items.filter(row => row.id !== item.id) };
          snapshotRef.current = next; setSnapshot(next);
          try { await ports.snapshot.write(next.items, next.fetchedAt); } catch {}
        }
        setError("この商品は自社システムから削除されています。一覧から取り除きました。");
      } else setError("商品詳細を読み込めませんでした。保存済みの情報を表示しています。");
    } finally { if (attempt === detailGeneration.current) setDetailLoading(false); }
  };
  const serverResults = !offline && !!ports.searchInventory && serverRows !== null;
  const rows = serverResults ? serverRows! : !offline && !!ports.searchInventory && !error ? [] : cachedInventorySearch(snapshot?.items ?? [],{q:query,category,advanced,sort},searchFields);
  const categories = options?.categories ?? Array.from(new Set((snapshot?.items ?? []).flatMap(item=>splitCategoryNames(item.category)).filter(Boolean)));
  const title = feature ?? (selected ? "物品詳細" : tabs.find((item) => item.key === tab)!.label);

  return <SafeAreaView style={[s.safe, tab === "home" && !selected && !editor && { backgroundColor: "#F8F6F1" }]}>
    {preview && <View style={s.preview}>
      <Text style={s.previewText}>操作確認用・実在庫には反映しません</Text>
      <Pressable accessibilityRole="button" onPress={onToggleOffline}><Text style={s.previewLink}>{offline ? "通信を戻す" : "圏外を試す"}</Text></Pressable>
    </View>}
    {preview && onTogglePreviewAccount && <Pressable accessibilityRole="button" accessibilityLabel="表示確認アカウントを切り替え" onPress={onTogglePreviewAccount} style={s.accountPreview}><Text style={s.previewText}>表示確認：{previewAccount}</Text><Text style={s.previewLink}>切り替え</Text></Pressable>}
    {splitting && writesEnabled && ports.split && ports.checkBarcode && ports.uploadPhoto ? <StockSplitScreen item={splitting} ports={{newMutationId:ports.newMutationId,split:ports.split,uploadPhoto:ports.uploadPhoto,checkBarcode:ports.checkBarcode}} onCancel={()=>setSplitting(null)} onSaved={({source,split})=>{setSplitting(null);sold({source,sold:split});}}/> : selling && canSellInventory && ports.sell ? <SoldOutScreen item={selling} ports={{newMutationId:ports.newMutationId,sell:ports.sell}} onCancel={()=>setSelling(null)} onSaved={sold}/> : editor ? <InventoryEditorScreen editor={editor} onLeave={leaveEditor} onSaved={item=>{saved(item);setSelected(item);}} onQrSaved={updateSavedItem} onPhotoDeleted={item=>{updateSavedItem(item);setSelected(item);}} features={features} /> : searchOpen ? <InventorySearchScreen value={advanced} fields={searchFields} onClose={()=>setSearchOpen(false)} onApply={value=>{setAdvanced(value);setSearchOpen(false);}}/> : <DetailSwipeBack enabled={!!selected && !feature && !deleteTarget && !scanSearch && !sortOpen && !categoryPicker} onBack={returnFromDetail}>
      <View style={s.header}>
        <View style={[s.headerSide, selected && {width:88}]}>{(selected || feature) && <Pressable accessibilityRole="button" accessibilityLabel="戻る" onPress={selected ? returnFromDetail : () => setFeature(null)} style={s.round}><Ionicons name="chevron-back" size={27} color={colors.text} /></Pressable>}</View>
        <Text style={s.title}>{title}</Text>
        <View style={[s.headerSide, selected && {width:88,flexDirection:"row"}]}>{selected && !selected.mergedIntoInventoryId && writesEnabled && <>
          <Pressable accessibilityRole="button" accessibilityLabel="この商品をコピーして新規登録" disabled={detailLoading} onPress={startCopy} style={s.round}><Ionicons name="copy-outline" size={23} color={colors.blue}/></Pressable>
          {ports.removeInventory && <Pressable accessibilityRole="button" accessibilityLabel="この商品を削除" disabled={detailLoading || !selected.detailLoadedAt} onPress={()=>{setDeleteError(null);setDeleteTarget(selected);}} style={s.round}><Ionicons name="trash-outline" size={23} color={colors.danger}/></Pressable>}
        </>}{tab === "inventory" && !selected && <Pressable accessibilityRole="button" accessibilityLabel="並び替え" onPress={() => setSortOpen(true)} style={s.round}><Ionicons name="swap-vertical" size={24} color={colors.text} /></Pressable>}{tab === "home" && !feature && onLogout && <Pressable accessibilityRole="button" accessibilityLabel="ログアウト" onPress={onLogout} style={s.round}><Ionicons name="log-out-outline" size={24} color={colors.text} /></Pressable>}</View>
      </View>
      {offline && <View style={s.offline}><Text style={s.offlineText}>【圏外です】保存済みの在庫を表示しています</Text>
        {snapshot && <Text style={s.timestamp}>最終取得 {new Date(snapshot.fetchedAt).toLocaleString("ja-JP")}</Text>}
      </View>}
      {selected?.mergedIntoInventoryId && <View style={s.offline}><Text>この在庫は出庫先の商品に合算済みです。</Text><Pressable accessibilityRole="button" onPress={()=>{if(ports.loadDetail)void ports.loadDetail(selected.mergedIntoInventoryId!).then(item=>openItem(item)).catch(()=>setError("合算先の商品を取得できませんでした。"));}}><Text style={s.blue}>合算先の商品を開く</Text></Pressable></View>}
      {error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      {error && selected && !detailLoading && <Pressable accessibilityRole="button" onPress={() => { void openItem(selected); }} style={{padding:14}}><Text style={{color:colors.blue}}>商品詳細を再読み込み</Text></Pressable>}
      {feature ? <View style={s.pending}><Text style={s.pendingTitle}>{feature}</Text><Text style={s.pendingText}>この操作は実装中です。実在庫への変更は行いません。</Text></View> : selected ? <ScrollView contentContainerStyle={s.detail}>
        <View style={{flexDirection:"row",flexWrap:"wrap",gap:4}}>{splitCategoryNames(selected.category).map(c=><Text key={c} style={s.tag}>{c}</Text>)}</View><Text style={s.itemTitle}>{selected.name}</Text>
        <View style={s.hero}><ProductImage item={selected} large /><View style={s.heroFacts}>
          <View style={s.heroFact}><Text style={s.label}>数量</Text><Text style={s.heroQuantity}>{selected.quantityUnset?"—":selected.quantity}<Text style={s.unit}> {selected.unit}</Text></Text></View>
          <View style={s.heroFact}><Text style={s.label}>保管場所</Text><Text style={s.location}>{selected.location || "未設定"}</Text></View>
        </View></View>
        {[["在庫ID", selected.displayId ?? selected.sku], ["管理番号", selected.sku], ["物品名", selected.name], ["カテゴリ", selected.category], ["ページ作成日", selected.createdAt?new Date(selected.createdAt).toLocaleString("ja-JP"):""], ["最終更新日時", new Date(selected.listUpdatedAt??selected.updatedAt).toLocaleString("ja-JP")], ["備考", selected.note], ["QRコード・バーコード", selected.barcode], ["販売予定価格", selected.plannedSalePrice === null ? "" : `${selected.plannedSalePrice.toLocaleString()}円`]].map(([label, value]) => <DetailFact key={label} label={label!} value={value} multiline={label === "備考"} />)}
        <InventoryPhotos item={selected} />
        {detailLoading && <ActivityIndicator accessibilityLabel="商品詳細を読み込み中" color={colors.blue} />}
        {!!selected.zaicoOriginalValues?.length&&<View><Text style={s.label}>ZAICOの元の値</Text>{selected.zaicoOriginalValues.map((value,index)=><DetailFact key={index} label={value.name} value={value.value}/>)}</View>}
        {selected.detailLoadedAt && visibleDetailFields(features).map((field, index, fields) => <View key={field.key}>
          {(index === 0 || fields[index - 1].section !== field.section) && <Text style={s.detailHeading}>{field.section}</Text>}
          <DetailFact label={field.label} value={selected.details?.[field.key]} multiline={field.kind === "multiline"} />
        </View>)}
        {!writesEnabled && <Text style={s.homeSub}>このアプリでは現在、在庫の閲覧のみ利用できます。</Text>}
      </ScrollView> : tab === "home" ? <HomeScreen offline={offline} creating={creating} writesEnabled={writesEnabled} onInventory={()=>setTab("inventory")} onCreate={()=>{void startCreate();}} onScan={()=>setScanSearch(true)} /> : tab === "inventory" ? <View style={s.list}>
        <PullToRefreshList keyboardShouldPersistTaps="handled" ListHeaderComponent={<View style={s.listHeader}>
        <View style={s.search}><Ionicons name="search" size={24} color={colors.text} /><TextInput accessibilityLabel="商品名を検索" placeholder="商品名" value={query} onChangeText={setQuery} style={s.searchInput} />{query !== "" && <Pressable accessibilityRole="button" accessibilityLabel="検索をクリア" onPress={() => setQuery("")}><Ionicons name="close-circle" size={22} color={colors.muted} /></Pressable>}</View>
        <View style={s.filterRow}><Pressable accessibilityRole="button" onPress={() => setCategoryPicker(true)} style={s.category}><Ionicons name="pricetag-outline" size={21} color={colors.text} /><Text numberOfLines={1} style={[s.categoryText,{maxWidth:130}]}>{category || "カテゴリ"}</Text><Ionicons name="chevron-down" size={16} color={colors.muted} /></Pressable><Pressable accessibilityRole="button" onPress={()=>setSearchOpen(true)} style={s.advancedButton}><Text style={s.blue}>詳細検索{advanced.conditions.length ? `（${advanced.conditions.length}）` : ""}</Text></Pressable></View>
        <View style={s.summaryRow}><Text style={s.result}>{serverResults && total!==null ? total.toLocaleString() : rows.length.toLocaleString()}件{serverResults&&total===null&&hasMore?" 読込済み":""}・数量合計 {(serverResults && totalQuantity!==null ? totalQuantity : rows.reduce((sum,item)=>sum+item.quantity,0)).toLocaleString()}{serverResults&&totalQuantity===null&&hasMore?"（表示分）":""}</Text></View>
        <Text style={s.scope}>{loading ? "自社システムから読み込み中…" : serverResults ? `${searchFields.find(field=>field.key===sort.field)?.label ?? "更新日"}・${sort.direction === "asc" ? "昇順" : "降順"}` : "読み込み済みの在庫のみ（未取得の詳細は対象外）"}</Text>
        </View>} data={rows} keyExtractor={(item) => item.id} refreshing={loading} onRefresh={() => refresh()}
          ListFooterComponent={!offline && hasMore ? <Pressable accessibilityRole="button" disabled={loading} onPress={() => { void refresh(true); }} style={s.pickerChoice}><Text style={s.blue}>{loading ? "読み込み中…" : "続きを読み込む"}</Text></Pressable> : undefined}
          contentContainerStyle={s.listContent} ListEmptyComponent={loading ? <ActivityIndicator color={colors.blue} /> : <Text style={s.empty}>{offline ? "この端末に保存済みの在庫がありません。通信が戻ったら読み込んでください。" : "該当する在庫がありません。"}</Text>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}、数量${item.quantityUnset?"未入力":item.quantity}`} onPress={() => { void openItem(item); }} style={s.row}>
            <ProductImage item={item} /><View style={s.rowMain}><View style={{flexDirection:"row",flexWrap:"wrap",gap:4}}>{splitCategoryNames(item.category).map(c=><Text key={c} style={s.tag}>{c}</Text>)}</View><Text style={s.rowName} numberOfLines={2}>{item.name}</Text></View>
            <View style={s.rowRight}><View style={s.quantityBox}><Text style={s.quantity}>{item.quantityUnset?"—":item.quantity}</Text></View><Text numberOfLines={1} style={s.rowLocation}>● {item.location || "未設定"}</Text></View>
          </Pressable>} />
      </View> : tab === "outbound" ? <OutboundEntry offline={offline}/> : tab === "sales" && ports.loadSales ? <SalesScreen canIssueDocuments={canIssueDocuments} load={ports.loadSales} offline={offline} onOpen={id=>{if(ports.loadDetail)void ports.loadDetail(id).then(item=>{setTab("inventory");void openItem(item);}).catch(()=>setError("商品を取得できませんでした。"));}}/> : <View style={s.pending}><Text style={s.pendingText}>売上を取得できませんでした。</Text></View>}
      {selected && !selected.mergedIntoInventoryId && writesEnabled && ports.split && <Pressable accessibilityRole="button" accessibilityLabel="在庫分け" disabled={offline||detailLoading||!selected.detailLoadedAt||selected.quantity<1} onPress={()=>setSplitting(selected)} style={[s.edit,s.floatingEdit,{bottom:canSellInventory?228:156},(offline||detailLoading||!selected.detailLoadedAt||selected.quantity<1)&&{opacity:.4}]}><Text style={[s.editLabel,{textAlign:'center'}]}>{'在庫\n分け'}</Text></Pressable>}
      {selected && !selected.mergedIntoInventoryId && writesEnabled && canSellInventory && ports.sell && features.sales && features.ecListing && <Pressable accessibilityRole="button" accessibilityLabel="売却" disabled={offline || detailLoading || !selected.detailLoadedAt || selected.quantity<1 || splitCategoryNames(selected.category).includes('売り切れ')} onPress={()=>setSelling(selected)} style={[s.edit,s.floatingEdit,{bottom:156},(offline||detailLoading||!selected.detailLoadedAt||selected.quantity<1||splitCategoryNames(selected.category).includes('売り切れ'))&&{opacity:.4}]}><Text style={s.editLabel}>売却</Text></Pressable>}
      {selected && !selected.mergedIntoInventoryId && writesEnabled && <Pressable accessibilityRole="button" accessibilityLabel="編集" disabled={detailLoading || (!!ports.loadDetail && !selected.detailLoadedAt)} onPress={() => setEditor(new InventoryEditor(selected, ports))} style={[s.edit, s.floatingEdit, (detailLoading || (!!ports.loadDetail && !selected.detailLoadedAt)) && { opacity: .4 }]}><Ionicons name="create-outline" size={21} color="white" /><Text style={s.editLabel}>編集</Text></Pressable>}
      <View style={s.tabBar}>{visibleTabs.map((item) => <Pressable accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: tab === item.key }} key={item.key} onPress={() => { detailGeneration.current++; setDetailLoading(false); setSelected(null); setFeature(null); setTab(item.key); }} style={[s.tab, tab === item.key && s.activeTab]}><Ionicons name={item.icon} size={22} color={tab === item.key ? colors.turquoise : colors.orange} /><Text style={[s.tabLabel, tab === item.key && s.activeLabel]}>{item.label}</Text></Pressable>)}</View>
    </DetailSwipeBack>}
    <Modal visible={!!deleteTarget} transparent animationType="fade" onRequestClose={()=>{if(!deleteBusy.current)setDeleteTarget(null);}}>
      <View style={s.deleteShade}><View accessibilityViewIsModal style={s.deleteDialog}>
        <Ionicons name="trash-outline" size={30} color={colors.danger}/><Text style={s.deleteTitle}>この商品を本当に削除しますか？</Text>
        <Text numberOfLines={5} style={s.deleteName}>{deleteTarget?.name}</Text>
        <Text style={s.deleteNote}>自社システムの在庫から削除されます。この操作は取り消せません。</Text>
        {deleteError && <Text accessibilityRole="alert" style={s.error}>{deleteError}</Text>}
        <View style={s.deleteButtons}><Pressable accessibilityRole="button" disabled={deleting} onPress={()=>setDeleteTarget(null)} style={s.deleteCancel}><Text style={s.blue}>キャンセル</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={deleting} onPress={()=>{void confirmDelete();}} style={[s.deleteConfirm,deleting&&{opacity:.5}]}><Text style={s.white}>{deleting?"削除中…":"削除する"}</Text></Pressable></View>
      </View></View>
    </Modal>
    {scanSearch&&<BarcodeScanner onClose={()=>setScanSearch(false)} onRead={value=>{setScanSearch(false);setQuery("");setCategory("");setAdvanced({combinator:"AND",conditions:[{id:"barcode-scan",field:"barcode",operator:"equals",value}]});setSelected(null);setTab("inventory");}}/>}
    {sortOpen&&<InventorySortSheet value={sort} fields={searchFields} onClose={()=>setSortOpen(false)} onApply={value=>{setSort(value);setSortOpen(false);}}/>}
    <Modal visible={categoryPicker} transparent animationType="slide" onRequestClose={() => setCategoryPicker(false)}><View style={s.shade}><View style={s.picker}><Text style={s.title}>カテゴリを選択</Text><ScrollView style={{maxHeight:450}}>{["", ...categories].map((value) => <Pressable accessibilityRole="button" key={value} style={s.pickerChoice} onPress={() => { setCategory(value); setCategoryPicker(false); }}><Text style={s.categoryText}>{value || "指定なし"}</Text></Pressable>)}</ScrollView><Pressable accessibilityRole="button" style={s.pickerChoice} onPress={() => setCategoryPicker(false)}><Text style={s.blue}>キャンセル</Text></Pressable></View></View></Modal>
  </SafeAreaView>;
}

function ProductImage({ item, large }: { item: InventoryItem; large?: boolean }) {
  const style = large ? s.largeImage : s.thumbnail;
  return item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} style={style} contentFit="cover" cachePolicy="memory-disk" accessibilityLabel={item.name} /> : <View style={[style, s.placeholder]}><Ionicons name="cube-outline" size={large ? 60 : 28} color="#C8BDAA" /></View>;
}

function DetailFact({ label, value, multiline = false }: { label: string; value?: string; multiline?: boolean }) {
  return <View style={[s.fact, multiline && s.factMultiline]}>
    <Text style={[s.factLabel, multiline && s.factLabelFull]}>{label}</Text>
    <Text style={[s.factValue, multiline && s.factValueFull]}>{value || "—"}</Text>
  </View>;
}

const s = StyleSheet.create({
  deleteShade:{flex:1,backgroundColor:"#00000066",justifyContent:"center",padding:24},deleteDialog:{backgroundColor:"white",borderRadius:22,padding:22,gap:16},deleteTitle:{fontSize:18,fontWeight:"700",lineHeight:27,color:colors.text},deleteName:{fontSize:16,lineHeight:24,color:colors.text},deleteNote:{fontSize:13,lineHeight:21,color:colors.muted},deleteButtons:{flexDirection:"row",gap:12,marginTop:8},deleteCancel:{flex:1,minHeight:48,alignItems:"center",justifyContent:"center"},deleteConfirm:{flex:1,minHeight:48,alignItems:"center",justifyContent:"center",backgroundColor:colors.danger,borderRadius:12},
  advancedButton:{borderWidth:1.5,borderColor:colors.blue,borderRadius:10,padding:11},summaryRow:{flexDirection:"row",alignItems:"center",justifyContent:"flex-end",marginTop:3},
  floatingEdit: { position: "absolute", right: 16, bottom: 84, zIndex: 1 },
  detailHeading: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: colors.text, paddingTop: 16, paddingBottom: 10 },
  accountPreview: { backgroundColor: "#344146", paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", justifyContent: "space-between" },
  safe: { flex: 1, backgroundColor: colors.cream }, preview: { backgroundColor: "#252D31", paddingVertical: 7, paddingHorizontal: 12, flexDirection: "row", justifyContent: "space-between", gap: 8 }, previewText: { color: "white", fontSize: 10, flex: 1 }, previewLink: { color: "#9FE4EB", fontSize: 11 },
  header: { height: 52, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, headerSide: { width: 44 }, title: { color: colors.text, fontSize: 16, fontWeight: "600" }, round: { width: 44, height: 44, backgroundColor: "#FFF9ED", borderRadius: 23, alignItems: "center", justifyContent: "center" },
  offline: { backgroundColor: "#FFF7C8", paddingHorizontal: 16, paddingVertical: 9 }, offlineText: { color: "#6E5108", fontSize: 13 }, timestamp: { color: "#776C45", fontSize: 11, marginTop: 3 }, error: { color: colors.danger, fontSize: 13, padding: 12, backgroundColor: "#FFF3EF" },
  homeSub: { fontSize: 13, lineHeight: 22, color: colors.muted, marginTop: 6 },
  list: { flex: 1, backgroundColor: "white" }, listHeader: { paddingTop: 10 }, search: { flexDirection: "row", alignItems: "center", paddingHorizontal: 13, gap: 10, borderWidth: 1, borderColor: "#AFB4AF", borderRadius: 12, minHeight: 48 }, searchInput: { flex: 1, fontSize: 16, paddingVertical: 11, minWidth: 0, color: colors.text }, filterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 }, category: { flexDirection: "row", gap: 9, alignItems: "center", minHeight: 44 }, categoryText: { fontSize: 16, color: colors.text }, result: { fontSize: 16, color: colors.text }, scope: { color: colors.muted, fontSize: 11, textAlign: "right", marginBottom: 4 },
  listContent: { paddingHorizontal: 16, paddingBottom: 20 }, row: { flexDirection: "row", gap: 9, paddingVertical: 10, borderBottomWidth: 1, borderColor: colors.border, alignItems: "flex-start" }, thumbnail: { width: 64, height: 64, borderRadius: 5 }, placeholder: { backgroundColor: "#F1ECE4", justifyContent: "center", alignItems: "center" }, rowMain: { flex: 1, minWidth: 0 }, tag: { color: colors.muted, fontSize: 11, backgroundColor: "#EFEFED", alignSelf: "flex-start", paddingHorizontal: 4, paddingVertical: 2 }, rowName: { fontSize: 15, fontWeight: "600", lineHeight: 21, color: colors.text, marginTop: 3 }, rowRight: { width: 72 }, quantityBox: { height: 48, borderWidth: 1, borderColor: colors.border, backgroundColor: "#F0F0EF", borderRadius: 8, alignItems: "center", justifyContent: "center" }, quantity: { fontSize: 23, color: colors.text, fontWeight: "700" }, rowLocation: { fontSize: 10, color: colors.muted, marginTop: 5 }, empty: { padding: 25, color: colors.muted, lineHeight: 23, textAlign: "center" },
  detail: { backgroundColor: "white", paddingHorizontal: 16, paddingTop: 10, flexGrow: 1, paddingBottom: 72 },
  itemTitle: { fontSize: 16, lineHeight: 20, color: colors.text, fontWeight: "700", marginTop: 4 },
  hero: { flexDirection: "row", marginVertical: 12, gap: 10 }, largeImage: { width: "36%", maxWidth: 130, aspectRatio: 1, borderRadius: 5 },
  heroFacts: { flex: 1, minWidth: 0, gap: 10 }, heroFact: { flexDirection: "row", alignItems: "flex-start", gap: 6 }, label: { color: colors.muted, fontSize: 12, lineHeight: 22, width: 52 },
  heroQuantity: { flex: 1, fontSize: 20, lineHeight: 24, textAlign: "right", fontWeight: "700", color: colors.text }, unit: { fontSize: 12, fontWeight: "400" }, location: { flex: 1, fontSize: 16, lineHeight: 21, textAlign: "right", fontWeight: "600", color: colors.text },
  fact: { borderTopWidth: 1, borderColor: colors.border, minHeight: 40, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  factLabel: { color: colors.muted, fontSize: 11, lineHeight: 15, width: "42%" }, factValue: { flex: 1, minWidth: 0, color: colors.text, fontSize: 14, lineHeight: 19 },
  factMultiline: { flexDirection: "column", alignItems: "stretch", gap: 6 }, factLabelFull: { width: "100%" }, factValueFull: { flex: 0 },
  edit: { backgroundColor: colors.blue, borderRadius: 28, width: 56, minHeight: 56, alignItems: "center", justifyContent: "center", gap: 2, padding: 8 }, editLabel: { color: "white", fontSize: 12, lineHeight: 16 }, white: { color: "white", fontSize: 17 },
  pending: { flex: 1, backgroundColor: "white", padding: 35, alignItems: "center", justifyContent: "center", gap: 18 }, pendingTitle: { fontSize: 23, color: colors.text, fontWeight: "700" }, pendingText: { fontSize: 15, color: colors.muted, lineHeight: 24, textAlign: "center" },
  tabBar: { flexDirection: "row", backgroundColor: "#FFFCF4", margin: 8, padding: 4, borderRadius: 32 }, tab: { flex: 1, minHeight: 52, gap: 2, alignItems: "center", justifyContent: "center", paddingVertical: 6, borderRadius: 26 }, activeTab: { backgroundColor: colors.selection }, tabLabel: { fontSize: 11, lineHeight: 14, color: colors.text }, activeLabel: { color: "#36848B", fontWeight: "600" },
  shade: { flex: 1, backgroundColor: "#00000055", justifyContent: "flex-end" }, picker: { backgroundColor: "white", borderTopLeftRadius: 25, borderTopRightRadius: 25, padding: 24, paddingBottom: 35 }, pickerChoice: { paddingVertical: 19, alignItems: "center", borderBottomWidth: 1, borderColor: colors.border }, blue: { color: colors.blue, fontSize: 17 },
});
