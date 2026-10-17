import { InventorySearchScreen, InventorySortSheet } from "./InventorySearchScreen";
import { cachedInventorySearch, cachedSearchFields, mobileSearchFields, DEFAULT_INVENTORY_SORT, type InventorySearchInput, type AdvancedSearchQuery, type InventorySort } from "../domain/search";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Image } from "expo-image";
import { SafeAreaView } from "react-native-safe-area-context";
import { InventoryEditor, type EditorPorts } from "../domain/editor";
import { mergeInventoryRead, type InventoryItem, type InventoryOptions } from "../domain/inventory";
import { SnapshotStore, type InventorySnapshot } from "../domain/snapshot";
import { InventoryEditorScreen } from "./InventoryEditorScreen";
import { colors } from "./theme";
import { canOpenTab, permittedTab, RESTRICTED_FEATURES, type MobileFeatures } from "../domain/access";
import { visibleDetailFields } from "../domain/detailFields";
import { InventoryPhotos } from "./InventoryPhotos";
import {BarcodeScanner} from "./BarcodeScanner";
import {SalesScreen, type SalesResponse} from "./SalesScreen";
import { InventoryReadError } from "../domain/readError";

type Tab = "home" | "inventory" | "ec" | "sales";
type IconName = React.ComponentProps<typeof Ionicons>["name"];
const tabs: { key: Tab; label: string; icon: IconName }[] = [
  { key: "home", label: "ホーム", icon: "home" }, { key: "inventory", label: "在庫一覧", icon: "list" },
  { key: "ec", label: "EC出品", icon: "storefront" }, { key: "sales", label: "売上", icon: "stats-chart" },
];
export interface StaffAppPorts extends EditorPorts {
  snapshot: SnapshotStore;
  loadInventory: () => Promise<InventoryItem[]>;
  searchInventory?: (input: InventorySearchInput) => Promise<{ items: InventoryItem[]; hasMore: boolean; nextOffset?: number; total?: number | null; totalQuantity?: number | null }>;
  loadOptions?: () => Promise<InventoryOptions>;
  loadSales?: (year:number,month:number,items?:boolean)=>Promise<SalesResponse>;
  loadDetail?: (id: string) => Promise<InventoryItem>;
}

export function StaffApp({ ports, offline, preview, onToggleOffline, onLogout, writesEnabled = false, features = RESTRICTED_FEATURES, previewAccount, onTogglePreviewAccount }: {
  ports: StaffAppPorts; offline: boolean; preview?: boolean; onToggleOffline?: () => void; onLogout?: () => void; writesEnabled?: boolean;
  features?: MobileFeatures; previewAccount?: string; onTogglePreviewAccount?: () => void;
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

  useEffect(() => {
    let active = true;
    ports.snapshot.read().then((cached) => { if (active) setSnapshot((current) => current ?? cached); })
      .catch(() => { if (active) setError("保存済みの在庫を読み込めませんでした。"); });
    return () => { active = false; generation.current++; detailGeneration.current++; };
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
    setLoading(true); setError(null);
    try {
      if (!await ports.online()) { setError("【圏外です】"); return; }
      const page = ports.searchInventory ? await ports.searchInventory({ q: query, category, advanced, sort, offset: append ? nextOffset.current : 0 }) : null;
      const received = page ? page.items : await ports.loadInventory();
      if (currentGeneration !== generation.current) return;
      const fresh = mergeInventoryRead(snapshotRef.current?.items ?? [], received);
      const items = page ? [...fresh, ...(snapshotRef.current?.items ?? []).filter(row => !fresh.some(item => item.id === row.id))].slice(0, 500) : fresh;
      if (page) {
        setServerRows(previous => append ? [...(previous ?? []), ...fresh.filter(item => !previous?.some(row => row.id === item.id))] : fresh);
        nextOffset.current = page.nextOffset ?? ((append ? nextOffset.current : 0) + received.length);
        setTotal(page.total ?? null);setTotalQuantity(page.totalQuantity ?? null);
        setHasMore(page.hasMore);
      }
      const fetchedAt = new Date().toISOString();
      setSnapshot({ schema: 1, owner: "current", items, fetchedAt });
      try { await ports.snapshot.write(items, fetchedAt); }
      catch { setError("在庫を読み込みましたが、この端末に圏外用のデータを保存できませんでした。"); }
    } catch {
      if (currentGeneration === generation.current) setError("在庫を読み込めませんでした。保存済みの在庫があれば表示します。");
    } finally {
      if (currentGeneration === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    // Invalidate an older response immediately when search changes.
    generation.current++;
    setServerRows(null); setHasMore(false); setTotal(null);setTotalQuantity(null);
    const timer = setTimeout(() => { void refresh(); }, query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [ports, query, category, advanced, sort]); // Reconnection never submits edits.

  const saved = (item: InventoryItem) => {
    setServerRows(rows => rows ? [item,...rows.filter(row=>row.id!==item.id)] : null);
    const items = [item,...(snapshot?.items ?? []).filter(row=>row.id!==item.id)].slice(0,500);
    // Only this record was refreshed; preserve the list's last-fetch timestamp.
    const fetchedAt = snapshot?.fetchedAt ?? new Date().toISOString();
    setSnapshot({ schema: 1, owner: "current", fetchedAt, items });
    void ports.snapshot.write(items, fetchedAt).catch(() => setError("変更は保存済みですが、端末の保存データを更新できませんでした。"));
    setEditor(null); setSelected(null); setTab("inventory");
    if (ports.searchInventory) void refresh();
  };
  const startCreate=async()=>{
    if(creating)return;
    if(!writesEnabled){setError("在庫を登録する権限がありません。");return;}
    setCreating(true);setError(null);
    let options:InventoryOptions={categories:[],locations:[],statuses:[]};
    try{if(ports.loadOptions&&await ports.online())options=await ports.loadOptions();}
    catch{setError("選択肢を取得できませんでした。通信状態を確認してください。");}
    const item:InventoryItem={id:ports.newMutationId(),sku:"保存時に自動採番",name:"",quantity:1,unit:"",location:"",category:"",condition:"",statusId:null,
      note:"",barcode:"",plannedSalePrice:null,thumbnailUrl:null,updatedAt:new Date().toISOString(),details:{},photos:[],photosComplete:true,
      statusOptions:options.statuses,categoryOptions:options.categories,locationOptions:options.locations};
    setEditor(new InventoryEditor(item,ports,true));setCreating(false);
  };
  const leaveEditor = () => { setEditor(null); setSelected(null); setError(null); setTab("inventory"); };
  const openItem = async (item: InventoryItem) => {
    const attempt = ++detailGeneration.current;
    setSelected(item); setError(null); setDetailLoading(false);
    if (!ports.loadDetail) return;
    setDetailLoading(true);
    try {
      if (!await ports.online()) {
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
  const rows = serverResults ? serverRows! : cachedInventorySearch(snapshot?.items ?? [],{q:query,category,advanced,sort},searchFields);
  const categories = options?.categories ?? Array.from(new Set((snapshot?.items ?? []).map(item=>item.category).filter(Boolean)));
  const title = feature ?? (selected ? "物品詳細" : tabs.find((item) => item.key === tab)!.label);

  return <SafeAreaView style={s.safe}>
    {preview && <View style={s.preview}>
      <Text style={s.previewText}>操作確認用・実在庫には反映しません</Text>
      <Pressable accessibilityRole="button" onPress={onToggleOffline}><Text style={s.previewLink}>{offline ? "通信を戻す" : "圏外を試す"}</Text></Pressable>
    </View>}
    {preview && onTogglePreviewAccount && <Pressable accessibilityRole="button" accessibilityLabel="表示確認アカウントを切り替え" onPress={onTogglePreviewAccount} style={s.accountPreview}><Text style={s.previewText}>表示確認：{previewAccount}</Text><Text style={s.previewLink}>切り替え</Text></Pressable>}
    {editor ? <InventoryEditorScreen editor={editor} onLeave={leaveEditor} onSaved={saved} features={features} /> : searchOpen ? <InventorySearchScreen value={advanced} fields={searchFields} onClose={()=>setSearchOpen(false)} onApply={value=>{setAdvanced(value);setSearchOpen(false);}}/> : <>
      <View style={s.header}>
        <View style={s.headerSide}>{(selected || feature) && <Pressable accessibilityRole="button" accessibilityLabel="戻る" onPress={() => { detailGeneration.current++; setDetailLoading(false); setSelected(null); setFeature(null); }} style={s.round}><Ionicons name="chevron-back" size={27} color={colors.text} /></Pressable>}</View>
        <Text style={s.title}>{title}</Text>
        <View style={s.headerSide}>{tab === "inventory" && !selected && <Pressable accessibilityRole="button" accessibilityLabel="並び替え" onPress={() => setSortOpen(true)} style={s.round}><Ionicons name="swap-vertical" size={24} color={colors.text} /></Pressable>}{tab === "home" && !feature && onLogout && <Pressable accessibilityRole="button" accessibilityLabel="ログアウト" onPress={onLogout} style={s.round}><Ionicons name="log-out-outline" size={24} color={colors.text} /></Pressable>}</View>
      </View>
      {offline && <View style={s.offline}><Text style={s.offlineText}>【圏外です】保存済みの在庫を表示しています</Text>
        {snapshot && <Text style={s.timestamp}>最終取得 {new Date(snapshot.fetchedAt).toLocaleString("ja-JP")}</Text>}
      </View>}
      {error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      {error && selected && !detailLoading && <Pressable accessibilityRole="button" onPress={() => { void openItem(selected); }} style={{padding:14}}><Text style={{color:colors.blue}}>商品詳細を再読み込み</Text></Pressable>}
      {feature ? <View style={s.pending}><Text style={s.pendingTitle}>{feature}</Text><Text style={s.pendingText}>この操作は実装中です。実在庫への変更は行いません。</Text></View> : selected ? <ScrollView contentContainerStyle={s.detail}>
        <Text style={s.tag}>{selected.category}</Text><Text style={s.itemTitle}>{selected.name}</Text>
        <View style={s.hero}><ProductImage item={selected} large /><View style={s.heroFacts}>
          <Text style={s.label}>数量</Text><Text style={s.heroQuantity}>{selected.quantity}<Text style={s.unit}> {selected.unit}</Text></Text>
          <Text style={s.label}>保管場所</Text><Text style={s.location}>{selected.location || "未設定"}</Text>
        </View></View>
        {[["在庫ID", selected.displayId ?? selected.sku], ["管理番号", selected.sku], ["物品名", selected.name], ["カテゴリ", selected.category], ["状態", selected.condition], ["備考", selected.note], ["QRコード・バーコード", selected.barcode], ["販売予定価格", selected.plannedSalePrice === null ? "" : `${selected.plannedSalePrice.toLocaleString()}円`]].map(([label, value]) => <View key={label} style={s.fact}><Text style={s.factLabel}>{label}</Text><Text style={s.factValue}>{value || "—"}</Text></View>)}
        <InventoryPhotos item={selected} />
        {detailLoading && <ActivityIndicator accessibilityLabel="商品詳細を読み込み中" color={colors.blue} />}
        {selected.detailLoadedAt && visibleDetailFields(features).map((field, index, fields) => <View key={field.key}>
          {(index === 0 || fields[index - 1].section !== field.section) && <Text style={s.detailHeading}>{field.section}</Text>}
          <View style={s.fact}><Text style={s.factLabel}>{field.label}</Text><Text style={s.factValue}>{selected.details?.[field.key] || "—"}</Text></View>
        </View>)}
        {!writesEnabled && <Text style={s.homeSub}>このアプリでは現在、在庫の閲覧のみ利用できます。</Text>}
      </ScrollView> : tab === "home" ? <ScrollView contentContainerStyle={s.home}>
        <Image source={require("../../assets/bello-system-icon.png")} style={{width:190,height:190,alignSelf:"center",borderRadius:30}} contentFit="contain" accessibilityLabel="Bello SYSTEM"/>
        <View style={s.tiles}>{[
          { label: "新規登録", icon: "add" as IconName },
          { label: "スキャン検索", icon: "qr-code-outline" as IconName },
        ].map((tile) => <Pressable accessibilityRole="button" accessibilityLabel={tile.label} key={tile.label} style={s.tile} disabled={creating} onPress={() => {if(tile.label === "新規登録")void startCreate();else setScanSearch(true);}}><Ionicons name={tile.icon} size={49} color={colors.turquoise} /><Text style={s.tileLabel}>{tile.label}</Text></Pressable>)}</View>
        <View style={s.homeSummary}><Text style={s.label}>この端末で読み込んだ在庫</Text><Text style={s.count}>{snapshot?.items.length ?? 0}<Text style={s.unit}> 件</Text></Text><Text style={s.homeSub}>圏外でも直前に読み込んだ情報を確認できます。</Text></View>
      </ScrollView> : tab === "inventory" ? <View style={s.list}>
        <View style={s.search}><Ionicons name="search" size={24} color={colors.text} /><TextInput accessibilityLabel="在庫を検索" placeholder="物品名・管理番号・コード" value={query} onChangeText={setQuery} style={s.searchInput} />{query !== "" && <Pressable accessibilityRole="button" accessibilityLabel="検索をクリア" onPress={() => setQuery("")}><Ionicons name="close-circle" size={22} color={colors.muted} /></Pressable>}</View>
        <View style={s.filterRow}><Pressable accessibilityRole="button" onPress={() => setCategoryPicker(true)} style={s.category}><Ionicons name="pricetag-outline" size={21} color={colors.text} /><Text numberOfLines={1} style={[s.categoryText,{maxWidth:130}]}>{category || "カテゴリ"}</Text><Ionicons name="chevron-down" size={16} color={colors.muted} /></Pressable><Pressable accessibilityRole="button" onPress={()=>setSearchOpen(true)} style={s.advancedButton}><Text style={s.blue}>詳細検索{advanced.conditions.length ? `（${advanced.conditions.length}）` : ""}</Text></Pressable></View>
        <View style={s.summaryRow}><Pressable accessibilityRole="button" accessibilityLabel="在庫を再読み込み" onPress={()=>{void refresh();}} style={{padding:8}}><Ionicons name="refresh" size={18} color={colors.muted}/></Pressable><Text style={s.result}>{serverResults && total!==null ? total.toLocaleString() : rows.length.toLocaleString()}件{serverResults&&total===null&&hasMore?" 読込済み":""}{(!serverResults||totalQuantity!==null)?` 合計 ${(serverResults ? totalQuantity! : rows.reduce((sum,item)=>sum+item.quantity,0)).toLocaleString()}`:""}</Text></View>
        <Text style={s.scope}>{loading ? "自社システムから読み込み中…" : serverResults ? `${searchFields.find(field=>field.key===sort.field)?.label ?? "更新日"}・${sort.direction === "asc" ? "昇順" : "降順"}` : "読み込み済みの在庫のみ（未取得の詳細は対象外）"}</Text>
        <FlatList data={rows} keyExtractor={(item) => item.id} refreshing={loading} onRefresh={() => { void refresh(); }}
          ListFooterComponent={!offline && hasMore ? <Pressable accessibilityRole="button" disabled={loading} onPress={() => { void refresh(true); }} style={s.pickerChoice}><Text style={s.blue}>{loading ? "読み込み中…" : "続きを読み込む"}</Text></Pressable> : undefined}
          contentContainerStyle={s.listContent} ListEmptyComponent={loading ? <ActivityIndicator color={colors.blue} /> : <Text style={s.empty}>{offline ? "この端末に保存済みの在庫がありません。通信が戻ったら読み込んでください。" : "該当する在庫がありません。"}</Text>}
          renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item.name}、数量${item.quantity}`} onPress={() => { void openItem(item); }} style={s.row}>
            <ProductImage item={item} /><View style={s.rowMain}><Text style={s.tag}>{item.category}</Text><Text style={s.rowName} numberOfLines={3}>{item.name}</Text><Text style={s.sku}>{item.sku}</Text></View>
            <View style={s.rowRight}><View style={s.quantityBox}><Text style={s.quantity}>{item.quantity}</Text></View><Text numberOfLines={1} style={s.rowLocation}>● {item.location || "未設定"}</Text></View>
          </Pressable>} />
      </View> : tab === "sales" && ports.loadSales ? <SalesScreen load={ports.loadSales} offline={offline} onOpen={id=>{if(ports.loadDetail)void ports.loadDetail(id).then(item=>{setTab("inventory");void openItem(item);}).catch(()=>setError("商品を取得できませんでした。"));}}/> : <View style={s.pending}><Ionicons name={tab === "ec" ? "storefront-outline" : "stats-chart-outline"} size={55} color={colors.turquoise} /><Text style={s.pendingTitle}>{tab === "ec" ? "EC出品" : "売上"}</Text><Text style={s.pendingText}>既存の自社システムとの接続を実装中です。{offline ? "通信が戻ってから操作できます。" : ""}</Text></View>}
      {selected && writesEnabled && <Pressable accessibilityRole="button" accessibilityLabel="編集" disabled={detailLoading || (!!ports.loadDetail && !selected.detailLoadedAt)} onPress={() => setEditor(new InventoryEditor(selected, ports))} style={[s.edit, s.floatingEdit, (detailLoading || (!!ports.loadDetail && !selected.detailLoadedAt)) && { opacity: .4 }]}><Ionicons name="create-outline" size={22} color="white" /><Text style={s.white}>編集</Text></Pressable>}
      <View style={s.tabBar}>{visibleTabs.map((item) => <Pressable accessibilityRole="tab" accessibilityLabel={item.label} accessibilityState={{ selected: tab === item.key }} key={item.key} onPress={() => { detailGeneration.current++; setDetailLoading(false); setSelected(null); setFeature(null); setTab(item.key); }} style={[s.tab, tab === item.key && s.activeTab]}><Ionicons name={item.icon} size={25} color={tab === item.key ? colors.turquoise : colors.orange} /><Text style={[s.tabLabel, tab === item.key && s.activeLabel]}>{item.label}</Text></Pressable>)}</View>
    </>}
    {scanSearch&&<BarcodeScanner onClose={()=>setScanSearch(false)} onRead={value=>{setScanSearch(false);setQuery("");setCategory("");setAdvanced({combinator:"AND",conditions:[{id:"barcode-scan",field:"barcode",operator:"equals",value}]});setSelected(null);setTab("inventory");}}/>}
    {sortOpen&&<InventorySortSheet value={sort} fields={searchFields} onClose={()=>setSortOpen(false)} onApply={value=>{setSort(value);setSortOpen(false);}}/>}
    <Modal visible={categoryPicker} transparent animationType="slide" onRequestClose={() => setCategoryPicker(false)}><View style={s.shade}><View style={s.picker}><Text style={s.title}>カテゴリを選択</Text><ScrollView style={{maxHeight:450}}>{["", ...categories].map((value) => <Pressable accessibilityRole="button" key={value} style={s.pickerChoice} onPress={() => { setCategory(value); setCategoryPicker(false); }}><Text style={s.categoryText}>{value || "指定なし"}</Text></Pressable>)}</ScrollView><Pressable accessibilityRole="button" style={s.pickerChoice} onPress={() => setCategoryPicker(false)}><Text style={s.blue}>キャンセル</Text></Pressable></View></View></Modal>
  </SafeAreaView>;
}

function ProductImage({ item, large }: { item: InventoryItem; large?: boolean }) {
  const style = large ? s.largeImage : s.thumbnail;
  return item.thumbnailUrl ? <Image source={{ uri: item.thumbnailUrl }} style={style} contentFit="cover" cachePolicy="memory-disk" accessibilityLabel={item.name} /> : <View style={[style, s.placeholder]}><Ionicons name="cube-outline" size={large ? 60 : 28} color="#C8BDAA" /></View>;
}

const s = StyleSheet.create({
  advancedButton:{borderWidth:1.5,borderColor:colors.blue,borderRadius:10,padding:11},summaryRow:{flexDirection:"row",alignItems:"center",justifyContent:"space-between",paddingHorizontal:16,marginTop:6},
  floatingEdit: { position: "absolute", right: 20, bottom: 105, zIndex: 1 },
  detailHeading: { fontSize: 20, fontWeight: "700", color: colors.text, paddingTop: 26, paddingBottom: 16 },
  accountPreview: { backgroundColor: "#344146", paddingHorizontal: 12, paddingVertical: 8, flexDirection: "row", justifyContent: "space-between" },
  safe: { flex: 1, backgroundColor: colors.cream }, preview: { backgroundColor: "#252D31", paddingVertical: 7, paddingHorizontal: 12, flexDirection: "row", justifyContent: "space-between", gap: 8 }, previewText: { color: "white", fontSize: 10, flex: 1 }, previewLink: { color: "#9FE4EB", fontSize: 11 },
  header: { height: 80, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, headerSide: { width: 46 }, title: { color: colors.text, fontSize: 21, fontWeight: "700" }, round: { width: 46, height: 46, backgroundColor: "#FFF9ED", borderRadius: 23, alignItems: "center", justifyContent: "center" },
  offline: { backgroundColor: "#FFF7C8", paddingHorizontal: 16, paddingVertical: 9 }, offlineText: { color: "#6E5108", fontSize: 13 }, timestamp: { color: "#776C45", fontSize: 11, marginTop: 3 }, error: { color: colors.danger, fontSize: 13, padding: 12, backgroundColor: "#FFF3EF" },
  home: { padding: 24, paddingBottom: 35 }, homeHeading: { fontSize: 25, fontWeight: "700", color: colors.text, marginTop: 18 }, homeSub: { fontSize: 13, lineHeight: 22, color: colors.muted, marginTop: 6 }, tiles: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginTop: 28 }, tile: { flexBasis: "46%", flexGrow: 1, height: 150, backgroundColor: "white", borderRadius: 22, alignItems: "center", justifyContent: "center", gap: 14 }, tileLabel: { fontSize: 17, fontWeight: "600", color: colors.text }, homeSummary: { backgroundColor: "#FFFAF1", borderRadius: 20, padding: 20, marginTop: 28 }, count: { fontSize: 34, fontWeight: "700", color: colors.text, marginTop: 8 },
  list: { flex: 1, backgroundColor: "white", paddingTop: 14 }, search: { flexDirection: "row", alignItems: "center", marginHorizontal: 16, paddingHorizontal: 13, gap: 10, borderWidth: 1, borderColor: "#AFB4AF", borderRadius: 12, minHeight: 55 }, searchInput: { flex: 1, fontSize: 17, paddingVertical: 14, minWidth: 0, color: colors.text }, filterRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, marginTop: 15 }, category: { flexDirection: "row", gap: 9, alignItems: "center", minHeight: 44 }, categoryText: { fontSize: 16, color: colors.text }, result: { fontSize: 16, color: colors.text }, scope: { color: colors.muted, fontSize: 11, textAlign: "right", marginRight: 16, marginBottom: 6 },
  listContent: { paddingHorizontal: 16, paddingBottom: 20 }, row: { flexDirection: "row", gap: 9, paddingVertical: 14, borderBottomWidth: 1, borderColor: colors.border, alignItems: "flex-start" }, thumbnail: { width: 64, height: 76, borderRadius: 5 }, placeholder: { backgroundColor: "#F1ECE4", justifyContent: "center", alignItems: "center" }, rowMain: { flex: 1, minWidth: 0 }, tag: { color: colors.muted, fontSize: 11, backgroundColor: "#EFEFED", alignSelf: "flex-start", paddingHorizontal: 4, paddingVertical: 2 }, rowName: { fontSize: 15, fontWeight: "600", lineHeight: 21, color: colors.text, marginTop: 3 }, sku: { color: colors.muted, fontSize: 11, marginTop: 5 }, rowRight: { width: 82 }, quantityBox: { height: 66, borderWidth: 1, borderColor: colors.border, backgroundColor: "#F0F0EF", borderRadius: 8, alignItems: "center", justifyContent: "center" }, quantity: { fontSize: 25, color: colors.text, fontWeight: "700" }, rowLocation: { fontSize: 10, color: colors.muted, marginTop: 7 }, empty: { padding: 25, color: colors.muted, lineHeight: 23, textAlign: "center" },
  detail: { backgroundColor: "white", padding: 20, flexGrow: 1, paddingBottom: 32 }, itemTitle: { fontSize: 21, lineHeight: 29, color: colors.text, fontWeight: "700", marginTop: 7 }, hero: { flexDirection: "row", marginVertical: 24, gap: 18 }, largeImage: { width: 145, height: 170, borderRadius: 8 }, heroFacts: { flex: 1, gap: 9 }, label: { color: colors.muted, fontSize: 14 }, heroQuantity: { fontSize: 29, fontWeight: "700", color: colors.text }, unit: { fontSize: 15, fontWeight: "400" }, location: { fontSize: 19, fontWeight: "600", color: colors.text }, fact: { borderTopWidth: 1, borderColor: colors.border, paddingVertical: 16, flexDirection: "row", gap: 15 }, factLabel: { color: colors.muted, fontSize: 13, width: 95 }, factValue: { flex: 1, color: colors.text, fontSize: 15, lineHeight: 23 }, edit: { backgroundColor: colors.blue, borderRadius: 26, flexDirection: "row", alignItems: "center", gap: 7, alignSelf: "flex-end", paddingHorizontal: 23, paddingVertical: 14, marginTop: 18 }, white: { color: "white", fontSize: 17 },
  pending: { flex: 1, backgroundColor: "white", padding: 35, alignItems: "center", justifyContent: "center", gap: 18 }, pendingTitle: { fontSize: 23, color: colors.text, fontWeight: "700" }, pendingText: { fontSize: 15, color: colors.muted, lineHeight: 24, textAlign: "center" },
  tabBar: { flexDirection: "row", backgroundColor: "#FFFCF4", margin: 12, padding: 5, borderRadius: 40 }, tab: { flex: 1, gap: 5, alignItems: "center", justifyContent: "center", paddingVertical: 11, borderRadius: 30 }, activeTab: { backgroundColor: colors.selection }, tabLabel: { fontSize: 11, color: colors.text }, activeLabel: { color: "#36848B", fontWeight: "600" },
  shade: { flex: 1, backgroundColor: "#00000055", justifyContent: "flex-end" }, picker: { backgroundColor: "white", borderTopLeftRadius: 25, borderTopRightRadius: 25, padding: 24, paddingBottom: 35 }, pickerChoice: { paddingVertical: 19, alignItems: "center", borderBottomWidth: 1, borderColor: colors.border }, blue: { color: colors.blue, fontSize: 17 },
});
