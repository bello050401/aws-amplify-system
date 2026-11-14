import React,{useState} from 'react';
import {ActivityIndicator,Image,Pressable,StyleSheet,Text,useWindowDimensions,View} from 'react-native';
import Svg,{Circle,Path,Text as SvgText} from 'react-native-svg';
import {formatJstDateTime} from '../../../lib/inventory/sales';
import {
  analysisRequest,arcPath,categoryBasisLabel,chartBasis,chartContent,displayRows,formatMetric,formatRecordCount,graphSegments,groupingFor,holdingBasisLabel,holdingBasisNote,inventoryCompositionNote,jstDay,metricFor,metricLabel,
  unknownAmount,type AnalysisPorts,type AnalysisState,type Bucket,type Dimension,type DisplayRow,type Metric,type ProductFact,type Slice,type Target,
} from '../../../lib/inventory/analysisUi/model';
import {useAnalysis,useDetail} from '../../../lib/inventory/analysisUi/useAnalysis';

export interface NativeAnalysisProps {
  state:AnalysisState;
  change:(change:Partial<AnalysisState>)=>void;
  ports?:AnalysisPorts;
  offline:boolean;
  today?:string;
  inventoryRead?:ReturnType<typeof useAnalysis>;
  onOpen:(id:string)=>void;
}

const button = (label:string,press:()=>void,selected?:boolean) =>
  <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : {selected}}
    onPress={press} style={[s.button,selected&&s.active]}><Text style={[s.buttonText,selected&&s.activeText]}>{label}</Text></Pressable>;

export function NativeAnalysis({state,change,ports,offline,onOpen,today=jstDay(),inventoryRead}:NativeAnalysisProps) {
  const request = analysisRequest(state,today);
  const metric = metricFor(state);
  const {key,detailed} = groupingFor(state);
  const read = useAnalysis(ports?.load,inventoryRead || state.slice ? null : request,!offline);
  const api = inventoryRead ?? read;
  const {data,retry} = api;
  const acquisition = state.tab === 'breakdown' && state.breakdown === 'acquisitions';
  const compare = acquisition && metric === 'amount' && data?.status === 'ok';
  const reference = useAnalysis(ports?.load,state.reference && compare ? {target:'retailReference',generation:data.metadata.generation} : null,!offline);
  if (state.slice) {
    const slice = state.slice;
    return <View style={s.section}>{button('← グラフに戻る',()=>change({slice:null}))}
      <Text accessibilityRole="header" style={s.heading}>{slice.label}の内訳</Text>
      <Text style={s.note}>{metricLabel(slice.request.target,slice.request.target==='retailReference'?'amount':metric)}{slice.request.start && slice.request.end ? ' · '+slice.request.start.replace(/-/g,'/')+' ～ '+slice.request.end.replace(/-/g,'/') : ''}</Text>
      {offline ? <Text style={s.note}>通信できる状態で内訳を確認してください。</Text> : <NativeDetails key={slice.request.generation+':'+slice.dimension+':'+slice.key} slice={slice} drill={ports?.drill} onOpen={onOpen}/>}
    </View>;
  }
  const graphs = (value:Extract<NonNullable<typeof data>,{status:'ok'}>, selected:Metric, isReference=false) => {
    const {summary,target,period,metadata} = value;
    const {gross,total,returned,net} = chartBasis(summary,selected);
    const inventory = target === 'inventory';
    const label = isReference ? '直近90日の小売実績' : target === 'sales' ? '選択期間の売上' : target === 'acquisitions' ? '直近30日の仕入れ' : '現在庫';
    const missingAmount = unknownAmount(summary,target);
    const unknown = summary.records > 0 && missingAmount >= summary.records;
    const unknownList = [
      ...(target==='sales' ? [['売上金額未登録',missingAmount] as const] : []),
      ['原価未登録',summary.unknown.cost],['数量未確認',summary.unknown.quantity],['未分類',summary.unknown.category],
      ['種類未判定',summary.unknown.kind],['ロット未判定',summary.unknown.lot],
    ] as const;
    return <View style={s.section}>
      {inventory && state.tab !== 'inventory' && <Text style={s.note}>
        {formatJstDateTime(metadata.asOf)} JST 時点
        {selected === 'kinds' && summary.unknown.kind > 0 && ' · 商品種類が未照合の在庫記録 '+summary.unknown.kind.toLocaleString('ja-JP')+'件'}
      </Text>}
      {!inventory && <View style={[s.card,s.summary]}>
        <Text accessibilityRole="header" style={s.heading}>{label}</Text>
        <Text style={s.total}>{unknown ? '—' : formatMetric(summary.amount,'amount')}</Text>
        {target === 'acquisitions' && <>
          <Text style={s.note}>確認できた仕入数量 {formatMetric(summary.quantity,'quantity')} · {formatMetric(summary.lots,'lots')}</Text>
          <Text style={s.note}>商品として仕入れた分を集計しています。販売済み・業販予定分を含みます。{metadata.unlocatedAcquisitionRecords > 0 && ' 仕入日や元明細を確認できない記録 '+metadata.unlocatedAcquisitionRecords+'件。'}</Text>
        </>}
        {period && <Text style={s.note}>{period.start.replace(/-/g,'/')} ～ {period.end.replace(/-/g,'/')}{period.partial ? '（途中）' : ''}</Text>}
        <Text style={s.note}>{formatJstDateTime(metadata.asOf)} JST 時点</Text>
        <Text style={s.note}>{metadata.amountBasis}</Text>
        {unknownList.some(([,count])=>count>0) && <Text style={s.note}>{unknownList.filter(([,count])=>count>0).map(([name,count])=>name+' '+count+'件').join(' · ')}</Text>}
        {gross && <Text style={s.note}>円グラフは返品前の構成です。返品・取消 {formatMetric(returned,selected)} · 差引 {formatMetric(net,selected)}</Text>}
        {isReference && <Text style={s.note}>確認済みの小売実績の参考配分。販路未確認 {value.referenceExclusions.unknownChannel}件 · 原価未確認 {value.referenceExclusions.unknownCost}件 · 取得元未確認 {value.referenceExclusions.unverifiedOrigin}件 · その他の対象外 {value.referenceExclusions.excluded}件（対象外の売上 {formatMetric(value.referenceExclusions.salesAmount,'amount')}）</Text>}
      </View>}
      {!inventory && !isReference && button(detailed ? '単品・複数に戻す' : '数量帯を詳しく',()=>change({detailed:{...state.detailed,[key]:!detailed}}),detailed)}
      {chartContent(target,selected,detailed).map(({title,dimension})=><NativeDonut
        key={metadata.generation+':'+target+':'+selected+':'+dimension} title={title} target={target} metric={selected} dimension={dimension}
        note={inventory ? dimension === 'holdingCount' ? holdingBasisNote : '商品名による分類を含みます。' : undefined}
        denominator={inventory ? inventoryCompositionNote(selected) : undefined}
        unavailable={dimension === 'holdingCount' && summary.dimensions[dimension] === undefined}
        buckets={summary.dimensions[dimension]??[]} total={total} gross={gross} records={summary.records} unknown={unknown && selected==='amount'}
        select={row=>change({slice:{dimension,key:row.key,label:row.label,request:{...(isReference ? {target} : request!),generation:metadata.generation}}})}
      />)}
    </View>;
  };

  return <View style={s.section}>
    {state.tab === 'breakdown' && <>
      <Choices label="在庫内訳の対象" value={state.breakdown} options={[{key:'inventory',label:'現在庫'},{key:'acquisitions',label:'直近30日の仕入れ'}] as const} select={breakdown=>change({breakdown})}/>
      {acquisition
        ? <Choices label="仕入れの集計単位" value={state.acquisitionUnit} options={[{key:'amount',label:'仕入原価'},{key:'quantity',label:'仕入数量'},{key:'lots',label:'仕入ロット数'}] as const} select={acquisitionUnit=>change({acquisitionUnit})}/>
        : <Choices label="現在庫の集計単位" value={state.stockUnit} options={[{key:'quantity',label:'数量'},{key:'kinds',label:'確認済みの商品種類数'}] as const} select={stockUnit=>change({stockUnit})}/>}
    </>}
    {offline ? <Text style={s.note}>通信できる状態で集計を確認してください。</Text>
      : !request ? <Text style={s.note}>2026年1月1日以降で有効な開始日と終了日を指定してください。</Text>
      : !data ? <ActivityIndicator accessibilityLabel="集計を読み込み中"/>
      : data.status === 'ok' ? graphs(data,metric)
      : <View style={s.card}><Text accessibilityRole="alert" style={s.note}>{data.status==='missing' ? '集計データなし' : data.status==='expired' ? 'この集計版は参照期限を過ぎました。' : '集計を取得できませんでした。'}</Text>
        {data.status!=='missing' && button('集計を再試行',retry)}</View>}
    {compare && <>
      {button('小売実績の参考配分と比較',()=>change({reference:!state.reference}),state.reference)}
      {state.reference && (!reference.data ? <ActivityIndicator accessibilityLabel="参考配分を読み込み中"/>
        : reference.data.status === 'ok' ? graphs(reference.data,'amount',true)
        : <View style={s.card}><Text style={s.note}>{reference.data.status==='missing' ? '集計データなし' : '参考配分を取得できませんでした。'}</Text>
          {reference.data.status!=='missing' && button('参考配分を再試行',reference.retry)}</View>)}
    </>}
  </View>;
}

function Choices<K extends string>({label,value,options,select}:{
  label:string; value:K; options:readonly {key:K;label:string}[]; select:(key:K)=>void;
}) {
  return <View accessibilityLabel={label} style={s.controls}>{options.map(option=><React.Fragment key={option.key}>
    {button(option.label,()=>select(option.key),value===option.key)}
  </React.Fragment>)}</View>;
}

function NativeDonut({title,target,metric,dimension,buckets,total,gross,records,unknown,note,denominator,unavailable,select}:{
  title:string; target:Target; metric:Metric; dimension:Dimension; buckets:Bucket[]; total:number; gross:boolean; records:number;
  unknown:boolean; note?:string; denominator?:string; unavailable?:boolean; select:(row:DisplayRow)=>void;
}) {
  const [showAll,setShowAll] = useState(false);
  const [other,setOther] = useState<DisplayRow[]|null>(null);
  const wide = useWindowDimensions().width >= 700;
  const {rows,expandable} = displayRows(buckets,metric,gross,showAll,dimension==='category',target,dimension);
  const label = metricLabel(target,metric)+(gross ? '（返品前）' : '');
  const radius = 88;
  function open(row:DisplayRow) {
    if (row.categories) setOther(previous=>previous ? null : row.categories!);
    else select(row);
  }
  if (unavailable) return <View style={s.card}>
    <Text accessibilityRole="header" style={s.heading}>{title}</Text>
    <Text style={s.note}>この時点の在庫数別内訳はありません。</Text>
  </View>;
  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.heading}>{title}</Text>
    {note && <Text style={s.note}>{note}</Text>}
    <View style={[s.chartBody,wide && s.chartWide]}>
      <View style={[s.donut,wide && s.donutWide]}>
        <Svg width="100%" height="100%" viewBox="0 0 220 220">
          <Circle cx={110} cy={110} r={radius} fill="none" stroke="#e9eeeb" strokeWidth={24}/>
          {graphSegments(rows).map(segment=><Path key={segment.key} d={arcPath(segment.percent,segment.offset,radius)} stroke={segment.color} fill="none" strokeWidth={24} onPress={()=>open(segment)}
          />)}
          <SvgText x={110} y={102} textAnchor="middle" fill="#526359" fontSize={12}>{label}</SvgText>
          <SvgText x={110} y={126} textAnchor="middle" fill="#214d41" fontSize={21} fontWeight="700">{unknown?'—':formatMetric(total,metric)}</SvgText>
        </Svg>
      </View>
      <View style={s.grow}>
      {records === 0 ? <Text style={s.note}>対象データなし</Text> : unknown ? <Text style={s.note}>{target === 'sales' ? '売上金額' : '原価'}未登録のため金額割合を表示できません。</Text> : total===0 && <Text style={s.note}>構成比を表示できる{label}がありません。</Text>}
      {rows.map(row=><Pressable key={row.key} accessibilityRole="button"
        accessibilityState={row.categories ? {expanded:Boolean(other)} : undefined} onPress={()=>open(row)} style={s.legend}>
        <View style={[s.dot,{backgroundColor:row.color}]}/>
        <View style={s.grow}>
          <Text style={s.label}>{row.label}</Text>
          {row.quantity !== undefined && <Text style={s.note}>{formatMetric(row.quantity,'quantity')}</Text>}
          {row.recordCount !== undefined && <Text style={s.note}>{formatRecordCount(row.recordCount)}</Text>}
        </View>
        <Text style={s.value}>{row.unknownValue ? '—' : formatMetric(row.value,metric)}</Text>
        <Text style={[s.note,s.percent]}>{total>0 && !row.unknownValue ? row.percent.toFixed(1)+'%' : '—'}</Text>
      </Pressable>)}
      {other && !showAll && <View style={s.controls}>{other.map(row=><React.Fragment key={row.key}>{button(row.label,()=>select(row))}</React.Fragment>)}</View>}
      </View>
    </View>
    {denominator && <Text style={s.note}>{denominator}</Text>}
    {expandable && button(showAll?'上位カテゴリーに戻す':'すべて見る',()=>{setOther(null);setShowAll(value=>!value);})}
  </View>;
}

function NativeDetails({slice,drill,onOpen,groupId}:{slice:Slice; drill:AnalysisPorts['drill']|undefined; onOpen:(id:string)=>void; groupId?:string}) {
  const page = useDetail(drill,slice,groupId);
  return <View style={s.section}>
    {page.items.map(item=>item.type==='group'
      ? <NativeGroup key={'group:'+item.group.kindId} group={item.group} slice={slice} drill={drill} onOpen={onOpen}/>
      : <NativeProduct key={item.record.id} record={item.record} amount={item.record.amount} quantity={item.record.quantity}
          action={item.record.inventoryId ? button('商品詳細',()=>onOpen(item.record.inventoryId!)) : undefined} date={item.record.date} sales={slice.request.target==='sales'} dimension={slice.dimension}/>)}
    {page.pending && <ActivityIndicator accessibilityLabel="内訳を読み込み中"/>}
    {page.error && <View style={s.section}><Text accessibilityRole="alert" style={s.note}>
      {page.error==='expired' ? 'この集計版の内訳は参照期限を過ぎました。グラフに戻って最新の集計を確認してください。' : page.error==='missing' ? '集計データなし' : '内訳を取得できませんでした。'}
    </Text>{page.error==='error' && button('内訳を再試行',page.retry)}</View>}
    {!page.pending && !page.error && page.items.length===0 && <Text style={s.note}>対象データなし</Text>}
    {page.more && !page.pending && !page.error && button('さらに表示',page.more)}
  </View>;
}

function NativeGroup({slice,drill,onOpen,group}:{slice:Slice;drill:AnalysisPorts['drill']|undefined;onOpen:(id:string)=>void;group:import('../../../lib/inventory/analysisUi/model').ProductGroup}) {
  const [open,setOpen] = useState(false);
  return <View style={s.section}>
    <NativeProduct record={group.representative} amount={group.amount} quantity={group.quantity}
      action={button(open?'構成レコードを閉じる':'構成レコードを表示（'+group.count+'件）',()=>setOpen(value=>!value),open)}
      sales={slice.request.target==='sales'} dimension={slice.dimension}/>
    {open && <View style={{marginLeft:10}}><NativeDetails slice={slice} drill={drill} onOpen={onOpen} groupId={group.kindId}/></View>}
  </View>;
}

function NativeProduct({record,amount,quantity,action,date,sales,dimension}:{
  record:ProductFact; amount:number|null; quantity:number|null; action?:React.ReactNode; date?:string|null; sales:boolean; dimension:Dimension;
}) {
  const [failed,setFailed] = useState(false);
  const basis = dimension === 'holdingCount'
    ? holdingBasisLabel(record.holdingBasis)
    : dimension === 'category' ? categoryBasisLabel(record.categoryBasis) : undefined;
  return <View style={[s.card,s.product]}>
    {record.imageUrl && !failed
      ? <Image source={{uri:record.imageUrl}} style={s.image} onError={()=>setFailed(true)}/>
      : <View style={s.image}><Text style={s.imageText}>{record.imageRef ? '画像を表示できません' : '画像なし'}</Text></View>}
    <View style={s.grow}>
      <Text accessibilityRole="header" style={s.heading}>{record.title}</Text>
      <Text style={s.note}>{record.categoryLabel}{date ? ' · '+date.replace(/-/g,'/') : ''}</Text>
      <Text style={s.note}>{quantity===null?'数量未確認':formatMetric(quantity,'quantity')} · {amount===null ? sales?'売上未確認':'原価未登録' : formatMetric(amount,'amount')}</Text>
      {basis && <Text style={s.note}>{basis}</Text>}
      {action}
    </View>
  </View>;
}

const s=StyleSheet.create({
  section:{gap:10,minWidth:0},controls:{flexDirection:'row',flexWrap:'wrap',gap:5,alignItems:'flex-end'},
  card:{borderRadius:15,borderWidth:1,borderColor:'#e0e8e2',backgroundColor:'white',padding:12,gap:7,minWidth:0},
  summary:{backgroundColor:'#f1f6f2'},total:{color:'#214d41',fontSize:29,fontWeight:'700',fontVariant:['tabular-nums']},
  heading:{color:'#263c35',fontSize:16,fontWeight:'700'},note:{color:'#526359',fontSize:13,lineHeight:20},
  button:{minHeight:44,alignSelf:'flex-start',paddingHorizontal:9,paddingVertical:6,borderRadius:9,borderWidth:1,borderColor:'#dbe6de',justifyContent:'center',backgroundColor:'#f5f8f6'},
  buttonText:{fontSize:13,color:'#245647',fontWeight:'600'},active:{backgroundColor:'#264e47',borderColor:'#264e47'},activeText:{color:'white'},
  chartBody:{gap:12},chartWide:{flexDirection:'row',alignItems:'center',gap:28},
  donut:{width:'100%',maxWidth:245,aspectRatio:1,alignSelf:'center'},donutWide:{width:'37%'},
  percent:{minWidth:48,textAlign:'right',fontVariant:['tabular-nums']},
  legend:{flexDirection:'row',minHeight:44,alignItems:'center',gap:8,borderBottomWidth:1,borderColor:'#e8eeea',paddingVertical:6},
  dot:{height:10,width:10,borderRadius:5},grow:{flex:1,minWidth:0},label:{color:'#243b32',fontSize:14},
  value:{color:'#243b32',fontSize:15,fontWeight:'700',fontVariant:['tabular-nums']},
  product:{flexDirection:'row',alignItems:'flex-start'},image:{width:68,height:68,borderRadius:6,backgroundColor:'#eef2ef',alignItems:'center',justifyContent:'center'},
  imageText:{fontSize:10,textAlign:'center',color:'#526359'},
});
