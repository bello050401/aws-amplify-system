import {baselineInput,changedInput,computeFeatureFixture,type Scope} from './model';
declare const __BELLO_FEATURE_SCOPE__:Scope;
const scope=__BELLO_FEATURE_SCOPE__;
const node=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
let scenario:'baseline'|'mutated'='baseline';
const input=node<HTMLInputElement>('scenario-input');input.value=baselineInput(scope);
const initial=computeFeatureFixture(scope);node('feature-title').textContent=initial.title;node('input-label').textContent=initial.inputLabel;
node('changed-value').textContent=changedInput(scope);
function render(){
 const value=computeFeatureFixture(scope,input.value);node('fixture-summary').textContent=value.summary;
 const table=node('fixture-table');table.replaceChildren();const header=document.createElement('tr');for(const label of value.columns){const cell=document.createElement('th');cell.textContent=label;header.append(cell);}table.append(header);
 for(const row of value.rows){const line=document.createElement('tr');for(const item of row){const cell=document.createElement('td');cell.textContent=String(item);line.append(cell);}table.append(line);}
 node('fixture-result').textContent=JSON.stringify(value.actual,null,2);
 const image=node('fixture-image');image.replaceChildren();if(value.image){const sample=document.createElement('div');sample.className='synthetic-image';sample.style.backgroundColor=value.image.color;sample.textContent=value.image.label;image.append(sample);}
 return value.actual;
}
async function report(action:'baseline'|'recalculate'|'reload',result:Record<string,unknown>){
 node('verification-status').textContent='結果を確認しています';
 try{const response=await fetch('/__feature-check',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,scenario,result})});if(!response.ok)throw Error('Host rejected result');node('verification-status').textContent='計算結果を記録しました';}
 catch{node('verification-status').textContent='結果の記録を確認できません';}
}
node('apply-scenario').addEventListener('click',()=>{try{scenario=input.value===changedInput(scope)?'mutated':'baseline';const result=render();void report('recalculate',result);}catch(error){node('fixture-summary').textContent=error instanceof Error?error.message:'入力を確認してください';node('verification-status').textContent='入力を確認してください';}});
node('reload-baseline').addEventListener('click',()=>{sessionStorage.setItem('bello-fixture-reload',scope);location.reload();});
const reloaded=sessionStorage.getItem('bello-fixture-reload')===scope;sessionStorage.removeItem('bello-fixture-reload');void report(reloaded?'reload':'baseline',render());
