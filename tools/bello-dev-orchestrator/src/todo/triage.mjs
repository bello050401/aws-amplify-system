import crypto from 'node:crypto';
const terminal=new Set(['completed','cancelled','failed']);
const active=new Set(['running','preflight','verifying','delivering','awaiting_ai_review','queued','retry_wait','revision_required']);
const normalize=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/task_[a-z0-9]+/g,'task').replace(/[\s、。，（）()「」:：・]/g,'');
export function requestOwner(todo){
  const title=String(todo.title||'');
  const text=[title,todo.action_required,todo.reason,todo.completion_condition].join(' ');
  // Categories alone are unreliable: legacy producers called ordinary Git work "approval".
  if(['auth','mfa','oauth','paid_action','destructive_action'].includes(todo.category))return 'human';
  if(/MFA|OAuth|ログイン|再認証|SSO|資格情報.*登録|固定IP.*登録|認証情報.*(?:入力|取得|設定)|課金|購入|支払/i.test(title))return 'human';
  if(/(?:production|本番|mainブランチ).*(?:deploy|デプロイ|反映|公開|削除|更新|マージ)|(?:deploy|デプロイ|削除|大量更新).*(?:production|本番)|破壊的|(?:IAM|S3|Cognito).*(?:権限|ポリシー|新設|作成|変更|削除)|(?:実EC出品|実出品|実注文)|ZAICO.*(?:本番|同期実行|書き込)|(?:権限|ポリシー).*(?:IAM|S3|Cognito)/i.test(text))return 'human';
  if(todo.kind==='manual_review')return 'later'; // An explicit manual-review selection is not an automatic acceptance.
  if(/git|commit|コミット|cherry.pick|merge|マージ|worktree|テスト|検証|typecheck|tsc|lint|build|playwright|ログ確認|再試行|retry|軽微|ブラウザ|staging|確認済み|自動修正|型検査|ファイル.*照合/i.test(title))return 'ai';
  return 'later';
}
export function planTodos(todos,tasks,{currentTaskId=null}={}){
  const taskMap=new Map(tasks.map(t=>[t.id,t]));const groups=new Map();
  const sorted=[...todos].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))||a.id.localeCompare(b.id));
  const result=[];
  for(const todo of sorted){
    const ids=todo.waitingTaskIds||JSON.parse(todo.waiting_task_ids||'[]');const linked=ids.map(id=>taskMap.get(id)).filter(Boolean);
    const owner=requestOwner(todo);let bucket='later',classification='later',reason='進行を止めていない確認事項';let canonical=null;
    const descriptiveTitle=normalize(todo.title).length>=18;
    const fingerprint=crypto.createHash('sha256').update([descriptiveTitle?ids.slice().sort().join(','):'',todo.category,todo.kind,normalize(todo.title),descriptiveTitle?'':normalize(todo.action_required),descriptiveTitle?'':normalize(todo.completion_condition),todo.target_url||'',todo.answer_format||'',JSON.stringify(todo.answerChoices||[]),String(todo.answerRequired||false),todo.kind==='manual_review'?ids.join(','):''].join('|')).digest('hex');
    if(todo.status!=='open'){bucket='archive';classification='expired';reason='完了・取消済みの履歴'}
    else if(groups.has(fingerprint)){bucket='archive';classification='duplicate';canonical=groups.get(fingerprint);reason='同一対象・件名の依頼をまとめました。詳細条件は統合先に保持'}
    else if(linked.length&&linked.every(t=>terminal.has(t.state))){bucket='archive';classification='past';reason='関連タスクはすべて終了済み'}
    else if(ids.length&&!linked.length){bucket='archive';classification='expired';reason='関連タスクが存在しない'}
    else if(groups.has(fingerprint)){bucket='archive';classification='duplicate';canonical=groups.get(fingerprint);reason='同じ対象・操作・完了条件の依頼を統合'}
    else {
      groups.set(fingerprint,todo.id);
      const blocking=linked.some(t=>t.state==='awaiting_user'||t.id===currentTaskId||active.has(t.state));
      if(owner==='human'&&linked.some(t=>!terminal.has(t.state)&&t.state!=='paused'&&(t.id===currentTaskId||active.has(t.state)))){bucket='now';classification='human';reason='未完了タスクを止めている本人操作・重要承認'}
      else if(owner==='ai'&&blocking){bucket='ai';classification='automatic';reason='通常作業はAI担当へ移管。対象タスクの実行時に処理'}
      else if(linked.length&&linked.every(t=>t.state==='paused')){bucket='archive';classification='past';reason='保留中の過去タスク。再開時に再分類'}
    }
    if(todo.status==='open'&&!canonical)groups.set(fingerprint,todo.id);
    result.push({...todo,triage:{bucket,classification,owner,reason,canonicalId:canonical,priority:ids.includes(currentTaskId)?0:todo.priority==='urgent'?1:2},waitingTaskIds:ids});
  }
  // The canonical card carries all affected task IDs; originals remain untouched.
  for(const item of result){if(item.triage.canonicalId){const parent=result.find(x=>x.id===item.triage.canonicalId);parent.waitingTaskIds=[...new Set([...parent.waitingTaskIds,...item.waitingTaskIds])];(parent.triage.related??=[]).push({id:item.id,action:item.action_required,condition:item.completion_condition});if(item.triage.owner==='human')parent.triage.owner='human';}}
  for(const parent of result.filter(x=>!x.triage.canonicalId&&x.status==='open')) {
    const linked=parent.waitingTaskIds.map(id=>taskMap.get(id)).filter(Boolean);
    if(parent.triage.owner==='human'&&parent.triage.bucket==='ai'){parent.triage.bucket='later';parent.triage.classification='later';parent.triage.reason='統合した依頼に重要承認・本人操作が含まれる';}
    if(parent.triage.owner==='human'&&linked.some(t=>!terminal.has(t.state)&&t.state!=='paused'&&(t.id===currentTaskId||active.has(t.state)))){parent.triage.bucket='now';parent.triage.classification='human';parent.triage.reason='現在の進行に関係する本人操作・重要承認';}
  }
  return result.sort((a,b)=>a.triage.priority-b.triage.priority||String(b.created_at).localeCompare(String(a.created_at)));
}
export class TodoTriage{
  constructor({repo}){this.repo=repo;}
  reconcile(options={}){
    const todos=planTodos(this.repo.listTodos(),this.repo.listTasks({limit:100000}),{currentTaskId:this.repo.store.getMeta('todoFocusTaskId')||null,...options});const now=new Date().toISOString();
    this.repo.store.transaction(()=>{for(const t of todos){const data=JSON.stringify(t.triage);const old=this.repo.store.get('SELECT data FROM todo_triage WHERE todo_id=?',[t.id]);if(old?.data!==data){this.repo.store.run('INSERT INTO todo_triage(todo_id,data,updated_at) VALUES(?,?,?) ON CONFLICT(todo_id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',[t.id,data,now]);this.repo.audit('system','todo.triage',t.id,t.triage.classification,t.triage.reason);}
      if(t.triage.bucket==='ai')this.repo.store.run("INSERT INTO todo_ai_queue(todo_id,state,updated_at) VALUES(?,'pending',?) ON CONFLICT(todo_id) DO NOTHING",[t.id,now]);
    }});
    const counts={now:0,later:0,ai:0,archive:0};for(const t of todos)counts[t.triage.bucket]++;
    return {todos,counts,aiRunning:todos.filter(t=>t.triage.bucket==='ai'&&t.waitingTaskIds.some(id=>this.repo.getTask(id)?.state==='running')&&this.repo.store.get('SELECT state FROM todo_ai_queue WHERE todo_id=?',[t.id])?.state==='running').length};
  }
  instructionsFor(taskId){
    return this.reconcile().todos.filter(t=>t.triage.bucket==='ai'&&t.waitingTaskIds.includes(taskId)).map(t=>`- ${t.title}\n  ${t.action_required}\n  完了条件: ${t.completion_condition}\n`+(t.triage.related||[]).map(r=>`  関連依頼: ${r.action}\n  完了条件: ${r.condition}`).join("\n")).join('\n');
  }
  markRunning(taskId){for(const t of this.reconcile().todos.filter(t=>t.triage.bucket==='ai'&&t.waitingTaskIds.includes(taskId)))this.repo.store.run("UPDATE todo_ai_queue SET state='running',updated_at=? WHERE todo_id=?",[new Date().toISOString(),t.id]);}
  completeVerified(taskId){
    // Only after the task has actually passed all completion gates. No task state is changed here.
    const task=this.repo.getTask(taskId);if(task?.state!=='completed')return;
    this.repo.store.transaction(()=>{for(const row of this.repo.store.all("SELECT todo_id FROM todo_ai_queue WHERE state='running'")){
      const todo=this.repo.getTodo(row.todo_id);if(!todo?.waitingTaskIds.includes(taskId))continue;
      if(!todo.waitingTaskIds.every(id=>this.repo.getTask(id)?.state==='completed'))continue;
      this.repo.store.run("UPDATE todo_ai_queue SET state='resolved',updated_at=? WHERE todo_id=?",[new Date().toISOString(),todo.id]);
      this.repo.store.run("UPDATE todos SET status='completed',completed_at=?,completed_answer=? WHERE id=? AND status='open'",[new Date().toISOString(),'関連タスクの独立検証・完了ゲート成功によりAI処理完了',todo.id]);this.repo.audit('system','todo.ai.completed',todo.id,'verified',taskId);
    }});
  }
}
