import React,{useEffect,useRef,useState} from 'react';
import {Modal,Pressable,ScrollView,Text,View} from 'react-native';
import {splitCategoryNames} from '../../../lib/inventory/categories';
import type {InventoryEditor} from '../domain/editor';
import type {InventoryItem} from '../domain/inventory';
import {API_ORIGIN} from '../runtime/service';
import {colors} from './theme';
type Movement={id:string;name:string;categoryName:string};
export function QrMovementSheet({value,editor,onCancel,onRescan,onDone,onNext}:{value:string;editor:InventoryEditor;onCancel:()=>void;onRescan:()=>void;onDone:(item:InventoryItem)=>void;onNext?:(item:InventoryItem)=>void}){
 const [stage,setStage]=useState<'confirm'|'movement'|'done'>('confirm'),[choices,setChoices]=useState<Movement[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[saved,setSaved]=useState<InventoryItem|null>(null),[selectedName,setSelectedName]=useState('');const lock=useRef(false),pendingChoice=useRef<string|null>(null);
 const valid=!!value.trim()&&value.length<=256&&!/[\u0000-\u001f\u007f]/u.test(value);
 async function load(){setLoading(true);setError('');try{const r=await fetch(API_ORIGIN+'/api/inventory/outbound?movement=1',{credentials:'same-origin',cache:'no-store'});const data=await r.json();if(!r.ok)throw Error(data.error||'移動予定を読み込めませんでした。');setChoices(data.movements);}catch{setError(typeof navigator!=='undefined'&&navigator.onLine===false?'【圏外です】':'移動予定を読み込めませんでした。通信を確認して再試行してください。');}finally{setLoading(false);}}
 useEffect(()=>{void load();},[]);
 async function apply(name:string|null){if(lock.current)return;if(!editor.getSnapshot().outcomeUncertain)pendingChoice.current=name;lock.current=true;setBusy(true);setError('');try{const item=await editor.saveQrMovement(value,name,choices.map(c=>c.categoryName));if(!item){setError(editor.getSnapshot().warning||'保存できませんでした。');return;}setSaved(item);setSelectedName(pendingChoice.current??'');setStage('done');}finally{setBusy(false);lock.current=false;}}
 const state=editor.getSnapshot(),current=choices.filter(c=>splitCategoryNames(state.draft.category).includes(c.categoryName)).map(c=>c.categoryName).join('、');
 const button=(label:string,action:()=>void,primary=false,disabled=false)=><Pressable accessibilityRole="button" accessibilityLabel={label} disabled={busy||disabled} onPress={action} style={{minHeight:52,padding:15,borderRadius:14,backgroundColor:primary?colors.blue:'#f0f0ed',opacity:(busy||disabled)?0.5:1}}><Text style={{fontSize:17,color:primary?'white':colors.text,textAlign:'center'}}>{label}</Text></Pressable>;
 return <Modal transparent animationType="slide" onRequestClose={()=>{if(!busy&&!state.outcomeUncertain)onCancel();}}><View style={{flex:1,backgroundColor:'#0006',justifyContent:'flex-end'}}><View style={{backgroundColor:'white',borderTopLeftRadius:24,borderTopRightRadius:24,padding:24,paddingBottom:35,gap:13,maxHeight:'85%'}}><ScrollView><Text style={{fontSize:20,fontWeight:'600',marginBottom:8}}>{stage==='confirm'?'番号の確認':stage==='movement'?'移動予定を選択':'登録しました'}</Text><Text numberOfLines={2} style={{fontSize:14,color:colors.muted}}>{state.draft.name}</Text><Text style={{fontSize:21,marginVertical:12}}>{value}</Text>{error&&<Text accessibilityRole="alert" style={{color:colors.danger,marginBottom:10}}>{error}</Text>}</ScrollView>
 {stage==='confirm'&&<>{valid?<Text>この番号で間違いないですか？</Text>:<Text accessibilityRole="alert">読み取れませんでした。読み直すか、閉じて手入力してください。</Text>}{button('はい',()=>setStage('movement'),true,!valid)}{button('読み直す',onRescan)}</>}
 {stage==='movement'&&<>{current&&<Text>現在の移動予定：{current}</Text>}{loading?<Text>移動予定を読み込み中…</Text>:choices.length?choices.map(c=><React.Fragment key={c.id}>{button(c.categoryName,()=>apply(c.categoryName),true,state.outcomeUncertain)}</React.Fragment>):button('移動予定を読み直す',()=>void load())}{button('移動しない',()=>apply(null),false,loading||!choices.length||state.outcomeUncertain)}{state.outcomeUncertain&&button('保存状況を確認する',()=>apply(null),true)}</>}
 {stage==='done'&&saved&&<><Text>{selectedName?`${value}番に${selectedName}を追加しました。`:`${value}番を登録しました。`}</Text>{onNext&&button('次の商品を読み取る',()=>onNext(saved),true)}{button('商品詳細へ',()=>onDone(saved))}</>}
 {stage!=='done'&&!state.outcomeUncertain&&button('キャンセル',onCancel)}
 </View></View></Modal>;
}
