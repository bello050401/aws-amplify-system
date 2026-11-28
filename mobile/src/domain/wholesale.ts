// Presentation state only. Eligibility, money and elapsed days come from BELLO.
import {sortWholesaleRows,type WholesaleRow,type WholesaleData as SharedWholesaleData,type WholesaleSaveRequest,type WholesaleSaveResult,type WholesaleSort} from '../../../lib/listing/wholesale';
export type {WholesaleRow};
export type WholesaleSortKey=WholesaleSort;
export type WholesaleData=SharedWholesaleData & {imageHeaders?:Record<string,string>;authenticatedImageOrigin?:string};
export interface WholesaleOutcome {id:string;success:boolean;message:string;unknown?:boolean;}
export interface WholesalePorts {
  load():Promise<WholesaleData>;
  save(request:WholesaleSaveRequest):Promise<WholesaleSaveResult>;
  newMutationId():string;
}
export class WholesaleRejectedError extends Error {}
export const MAX_WHOLESALE_SELECTION=100;
export const sortWholesale=sortWholesaleRows;export function wholesaleAmount(value:number|null):string{return value===null?'未登録':`¥${value.toLocaleString('ja-JP')}`;}
export interface WholesaleState { data:WholesaleData|null; selected:string[]; loading:boolean; saving:boolean; error:string; notice:string; outcomes:WholesaleOutcome[]; }
export class WholesaleController {
  state:WholesaleState={data:null,selected:[],loading:false,saving:false,error:'',notice:'',outcomes:[]};
  private listeners=new Set<(state:WholesaleState)=>void>();
  private pending:WholesaleSaveRequest|null=null;
  constructor(private ports:WholesalePorts){}
  subscribe(listener:(state:WholesaleState)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  private change(change:Partial<WholesaleState>){this.state={...this.state,...change};this.listeners.forEach(fn=>fn(this.state));}
  async load(){
    if(this.state.loading||this.state.saving||this.pending)return;
    this.change({loading:true,error:''});
    try{const data=await this.ports.load();const allowed=new Set(data.items.filter(i=>!i.alreadyWholesale).map(i=>i.id));this.change({data,selected:this.state.selected.filter(id=>allowed.has(id))});}
    catch{this.change({error:'一覧を取得できませんでした。通信を確認して再読み込みしてください。'});}
    finally{this.change({loading:false});}
  }
  toggle(id:string){if(this.state.loading||this.state.saving||this.pending||!this.state.data?.canEdit)return;const item=this.state.data.items.find(i=>i.id===id);if(!item||item.alreadyWholesale)return;if(!this.state.selected.includes(id)&&this.state.selected.length>=MAX_WHOLESALE_SELECTION){this.change({error:"1回に選択できるのは100件までです。"});return;}this.change({selected:this.state.selected.includes(id)?this.state.selected.filter(x=>x!==id):[...this.state.selected,id]});}
  selectAll(){if(this.state.loading||this.state.saving||this.pending||!this.state.data?.canEdit)return;this.change({selected:this.state.data.items.filter(i=>!i.alreadyWholesale).slice(0,MAX_WHOLESALE_SELECTION).map(i=>i.id)});}
  clear(){if(this.state.loading||this.state.saving||this.pending)return;this.change({selected:[]});}
  get unknown(){return !!this.pending;}
  async save(){
    if(this.state.saving||this.state.loading||!this.state.data?.canEdit||!this.state.data.snapshotVersion)return;
    const request=this.pending??{items:this.state.data.items.filter(i=>this.state.selected.includes(i.id)&&!i.alreadyWholesale).map(({id,updatedAt})=>({id,expectedUpdatedAt:updatedAt})),snapshotVersion:this.state.data.snapshotVersion,mutationId:this.ports.newMutationId()};
    if(!request.items.length)return;if(request.items.length>MAX_WHOLESALE_SELECTION){this.change({error:"1回に選択できるのは100件までです。"});return;}
    this.pending=request;this.change({saving:true,error:'',notice:'',outcomes:[]});
    try{
      const result=await this.ports.save(request);
      const outcomes:WholesaleOutcome[]=result.results.map(r=>({id:r.id,success:r.status==='saved'||r.status==='already',unknown:r.status==='unknown',message:r.message??(r.status==='saved'||r.status==='already'?'「業者間」を追加しました。':'追加できませんでした。')}));
      const ids=request.items.map(i=>i.id);
      if(outcomes.length!==ids.length||new Set(outcomes.map(i=>i.id)).size!==ids.length||outcomes.some(i=>!ids.includes(i.id)))throw Error('UNCONFIRMED_RESULT');
      const succeeded=new Set(outcomes.filter(i=>i.success).map(i=>i.id));
      this.pending=outcomes.some(i=>i.unknown)?request:null;
      this.change({data:{...this.state.data,items:this.state.data.items.map(i=>succeeded.has(i.id)?{...i,alreadyWholesale:true}:i)},selected:this.state.selected.filter(id=>!succeeded.has(id)),outcomes,notice:`${succeeded.size}件に「業者間」を追加しました。`,error:outcomes.some(i=>!i.success)?'追加できなかった商品があります。結果を確認し、最新情報を再読み込みしてください。':''});
    }catch(error){if(error instanceof WholesaleRejectedError){this.pending=null;this.change({error:error.message});}else this.change({error:'保存結果を確認できません。同じ操作の結果を再確認してください。再確認が終わるまで選択は保持されます。'});}
    finally{this.change({saving:false});}
  }
}
