import {wholesaleImageSource} from '../domain/wholesaleImage';
import React,{useEffect,useMemo,useState} from 'react';
import {ActivityIndicator,Image,Pressable,ScrollView,StyleSheet,Text,View} from 'react-native';
import {WholesaleController,sortWholesale,wholesaleAmount,type WholesalePorts,type WholesaleSortKey} from '../domain/wholesale';

const columns:Array<{key:WholesaleSortKey;label:string}>= [{key:'purchaseAmount',label:'仕入額'},{key:'shipping',label:'送料'},{key:'totalCost',label:'合計原価'},{key:'sellingDays',label:'販売日数'},{key:'quantity',label:'在庫数'}];
export function WholesaleScreen({ports,offline,onClose,controller:retained}:{ports:WholesalePorts;offline:boolean;onClose():void;controller?:WholesaleController}){
 const controller=useMemo(()=>retained??new WholesaleController(ports),[ports,retained]);
 const [state,setState]=useState(controller.state),[sort,setSort]=useState<{key:WholesaleSortKey;direction:'asc'|'desc'}>({key:'sellingDays',direction:'desc'}),[expanded,setExpanded]=useState<string[]>([]);
 useEffect(()=>{const unsubscribe=controller.subscribe(setState);if(!offline)void controller.load();return unsubscribe;},[controller,offline]);
 const busy=state.loading||state.saving,locked=busy||controller.unknown;
 const rows=sortWholesale(state.data?.items??[],sort.key,sort.direction);
 const button=(label:string,onPress:()=>void,disabled=false,primary=false)=><Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.button,primary&&s.primary,disabled&&s.disabled]}><Text style={[s.buttonText,primary&&s.white]}>{label}</Text></Pressable>;
 return <View style={s.screen}>
  <View style={s.header}>{button('ホームへ戻る',onClose,state.saving||controller.unknown)}<Text style={s.heading}>業販</Text></View>
  <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
   <Text style={s.description}>現在販売中のeコンビニ連携商品です。1回に100件まで選択できます。選択した商品にカテゴリ「業者間」を追加します。</Text>
   <Text style={s.small}>金額は1点あたり。仕入額は送料を除いた金額、合計原価は送料込みの確定原価です。未登録は0円と区別して表示します。</Text>
   {offline&&<Text accessibilityRole="alert" style={s.error}>圏外です。最新確認と保存には通信が必要です。選択は保持しています。</Text>}
   {!!state.error&&<Text accessibilityRole="alert" style={s.error}>{state.error}</Text>}
   {!!state.notice&&<Text accessibilityRole="status" style={s.notice}>{state.notice}</Text>}
   {button(state.loading?'読み込み中…':'最新情報を再読み込み',()=>{void controller.load();},locked||offline)}
   {state.loading&&<ActivityIndicator accessibilityLabel="業販一覧を読み込み中" color="#36746A"/>}
   {state.data&&<>
    <Text style={s.small}>連携状態の確認日時：{state.data.checkedAt??'未確認'}。販売日数は登録済みの販売開始日を基準に表示します。</Text>{state.data.warnings.map((warning,index)=><Text key={index} style={s.error}>{warning}</Text>)}<Text style={s.small}>在庫未対応 {state.data.unlinkedCount}件・対応不明 {state.data.ambiguousCount}件を除外</Text><Text style={s.count}>{rows.length}件・選択中 {state.selected.length}件</Text>
    {!state.data?.canEdit&&<Text style={s.description}>閲覧のみの権限です。</Text>}
    <Text style={s.label}>並び替え（もう一度押すと昇順・降順を切替）</Text>
    <View style={s.actions}>{columns.map(c=><Pressable key={c.key} accessibilityRole="button" accessibilityLabel={`${c.label}で並び替え${sort.key===c.key?(sort.direction==='asc'?'・昇順':'・降順'):''}`} accessibilityState={{selected:sort.key===c.key}} onPress={()=>setSort(current=>({key:c.key,direction:current.key===c.key&&current.direction==='asc'?'desc':'asc'}))} style={[s.sort,sort.key===c.key&&s.activeSort]}><Text style={s.buttonText}>{c.label}{sort.key===c.key?(sort.direction==='asc'?' ↑':' ↓'):''}</Text></Pressable>)}</View>
    {state.data.canEdit&&<View style={s.actions}>{button('全選択（100件まで）',()=>controller.selectAll(),locked||!rows.some(i=>!i.alreadyWholesale))}{button('全解除',()=>controller.clear(),locked||!state.selected.length)}</View>}
    {rows.map(item=>{const checked=state.selected.includes(item.id),open=expanded.includes(item.id);return <View key={item.id} style={[s.card,checked&&s.checked]}>
     <View style={s.row}>
      <Pressable accessibilityRole="checkbox" aria-checked={checked} accessibilityLabel={`${item.name}を選択`} accessibilityState={{checked,disabled:locked||!state.data?.canEdit||item.alreadyWholesale}} disabled={locked||!state.data?.canEdit||item.alreadyWholesale} onPress={()=>controller.toggle(item.id)} style={[s.checkbox,(item.alreadyWholesale||!state.data?.canEdit)&&s.disabled]}><Text style={s.check}>{checked?'☑':'☐'}</Text></Pressable>
      {item.imageUrl?<Image accessibilityLabel={`${item.name}の写真`} source={wholesaleImageSource(item.imageUrl,state.data?.authenticatedImageOrigin,state.data?.imageHeaders)} style={s.photo}/>:<View style={[s.photo,s.placeholder]}><Text style={s.small}>写真なし</Text></View>}
      <View style={s.itemText}><Text numberOfLines={open?undefined:3} style={s.title}>{item.name}</Text><Text style={s.small}>{item.displayId}</Text><Pressable accessibilityRole="button" accessibilityLabel={`${item.name}の${open?'タイトルを閉じる':'全タイトルを表示'}`} onPress={()=>setExpanded(current=>open?current.filter(id=>id!==item.id):[...current,item.id])} style={s.expand}><Text style={s.link}>{open?'タイトルを閉じる':'全タイトルを表示'}</Text></Pressable></View>
     </View>
     <View style={s.metrics}>{columns.map(c=><View key={c.key} style={s.metric}><Text style={s.small}>{c.label}{['purchaseAmount','shipping','totalCost'].includes(c.key)?' / 点':''}</Text><Text style={s.value}>{['purchaseAmount','shipping','totalCost'].includes(c.key)?wholesaleAmount(item[c.key]):item[c.key]===null?'未登録':`${item[c.key]}${c.key==='sellingDays'?'日':'点'}`}</Text></View>)}</View>
     {item.alreadyWholesale&&<Text style={s.registered}>業者間 追加済み</Text>}
    </View>;})}
    {!rows.length&&!state.loading&&<Text style={s.description}>対象の商品はありません。</Text>}
   </>}
   {state.outcomes.map(outcome=><View key={outcome.id} style={outcome.success?s.result:s.error}><Text style={s.label}>{state.data?.items.find(i=>i.id===outcome.id)?.name??outcome.id}</Text><Text style={s.description}>{outcome.message}</Text></View>)}
  </ScrollView>
  <View style={s.footer}><Text style={s.small}>販売中と既存カテゴリを保持します。</Text>{button(state.saving?'保存中…':controller.unknown?'同じ操作の結果を再確認':`業者間行きにする（${state.selected.length}件）`,()=>{void controller.save();},busy||offline||!state.data?.canEdit||!state.data?.snapshotVersion||!state.selected.length,true)}</View>
 </View>;
}
const s=StyleSheet.create({screen:{flex:1,backgroundColor:'#F8F6F1'},header:{padding:12,flexDirection:'row',alignItems:'center',gap:16},heading:{fontSize:22,fontWeight:'700',color:'#263D3C'},content:{padding:12,paddingBottom:24,gap:12,width:'100%',maxWidth:760,alignSelf:'center'},description:{fontSize:13,lineHeight:21,color:'#53665D'},small:{fontSize:11,lineHeight:17,color:'#69796E'},label:{fontSize:13,fontWeight:'600',color:'#263D3C'},button:{minHeight:44,paddingHorizontal:12,paddingVertical:10,borderWidth:1,borderColor:'#AABAB0',borderRadius:10,alignItems:'center',justifyContent:'center',backgroundColor:'white'},buttonText:{fontSize:13,fontWeight:'600',color:'#214C3C'},primary:{backgroundColor:'#214C3C'},white:{color:'white'},disabled:{opacity:.45},actions:{flexDirection:'row',flexWrap:'wrap',gap:8},sort:{minHeight:44,padding:10,borderWidth:1,borderColor:'#DDE3DA',borderRadius:10,justifyContent:'center',backgroundColor:'white'},activeSort:{backgroundColor:'#E7F1E7',borderColor:'#36746A'},count:{fontSize:16,fontWeight:'700',color:'#263D3C'},card:{borderWidth:1,borderColor:'#DDE3DA',borderRadius:14,padding:10,backgroundColor:'white',gap:10},checked:{borderColor:'#36746A',backgroundColor:'#EFF7F0'},row:{flexDirection:'row',alignItems:'flex-start',gap:8},checkbox:{width:36,minHeight:48,alignItems:'center',justifyContent:'center'},check:{fontSize:27,color:'#214C3C'},photo:{width:54,height:64,borderRadius:7,resizeMode:'cover'},placeholder:{alignItems:'center',justifyContent:'center',backgroundColor:'#E6EAE4'},itemText:{flex:1,minWidth:0},title:{fontSize:14,lineHeight:22,fontWeight:'600',color:'#263D3C'},expand:{minHeight:44,justifyContent:'center'},link:{fontSize:12,color:'#36746A'},metrics:{flexDirection:'row',flexWrap:'wrap',gap:8},metric:{minWidth:110,flexGrow:1,padding:8,backgroundColor:'#F4F5F0',borderRadius:7},value:{fontSize:15,fontWeight:'600',color:'#263D3C',marginTop:3},registered:{fontSize:12,color:'#36746A'},footer:{padding:12,gap:6,borderTopWidth:1,borderTopColor:'#DBE2DA',backgroundColor:'white'},error:{padding:12,color:'#9C2222',backgroundColor:'#FFF0EC',fontSize:13,lineHeight:22},notice:{padding:12,color:'#214C3C',backgroundColor:'#E7F1E7',fontSize:13,lineHeight:22},result:{padding:12,backgroundColor:'#E7F1E7',gap:4}});
