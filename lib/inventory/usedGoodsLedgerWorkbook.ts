import ExcelJS from 'exceljs';
import type {UsedGoodsLedger} from './usedGoodsLedger';
import {ledgerPresentation} from './usedGoodsLedgerPresentation';

const HEADER=5;
// OOXML paperSize 8 is A3; ExcelJS's TypeScript enum omits it although its writer supports it.
const A3=8 as ExcelJS.PageSetup['paperSize'];
function sheet(book:ExcelJS.Workbook,name:string,title:string,note:string,columns:{header:string;key:string;width:number;numFmt?:string}[]) {
  const s=book.addWorksheet(name,{views:[{state:'frozen',ySplit:HEADER,xSplit:2,showGridLines:false}],properties:{defaultRowHeight:23},pageSetup:{paperSize:A3,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:5',margins:{left:0.25,right:0.25,top:0.4,bottom:0.4,header:0.2,footer:0.2}}});
  s.columns=columns.map(({key,width,numFmt})=>({key,width,...(numFmt?{style:{numFmt}}:{})}));
  s.getCell('A2').value=title;s.getCell('A2').font={name:'Yu Gothic',size:15,bold:true,color:{argb:'FF183153'}};
  s.getCell('A3').value=note;s.getCell('A3').font={name:'Yu Gothic',size:10,color:{argb:'FF475569'}};
  s.mergeCells(1,1,1,columns.length);s.mergeCells(2,1,2,columns.length);s.mergeCells(3,1,3,columns.length);s.mergeCells(4,1,4,columns.length);
  for(const row of [1,3,4]){s.getRow(row).height=row===1?20:32;s.getCell(row,1).alignment={vertical:'middle',wrapText:true};s.getCell(row,1).font={name:'Yu Gothic',size:10,color:{argb:'FF475569'}};}
  s.getRow(HEADER).values=columns.map(c=>c.header);s.getRow(HEADER).height=42;
  s.getRow(HEADER).eachCell(c=>{c.font={name:'Yu Gothic',size:10,bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF183153'}};c.alignment={vertical:'middle',horizontal:'center',wrapText:true};});
  s.headerFooter.oddFooter='&L株式会社BELLO&R&P / &N';
  return s;
}
function addRow(s:ExcelJS.Worksheet,values:Record<string,unknown>) {
  // Assign strings as literal cell values (never formula/hyperlink objects).
  const r=s.addRow(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value===''?null:value]))); let lines=1;
  for(let col=1;col<=s.columnCount;col++){
    const cell=r.getCell(col);
    cell.font={name:'Yu Gothic',size:10,color:{argb:'FF1E293B'}};
    cell.alignment={vertical:'top',wrapText:true,horizontal:typeof cell.value==='number'?'right':'left'};
    cell.border={bottom:{style:'hair',color:{argb:'FFE2E8F0'}},right:{style:'hair',color:{argb:'FFE2E8F0'}}};
    if(r.number%2===0)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F5F9'}};
    if(s.getColumn(col).hidden)continue;
    const text=String(cell.value??'');
    const wrappedLines=text.split('\n').reduce((count,line)=>{
      const width=[...line].reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0);
      return count+Math.max(1,Math.ceil(width/Math.max(10,(s.getColumn(col).width??20)-2)));
    },0);
    lines=Math.max(lines,wrappedLines);
  }
  r.height=Math.min(409,Math.max(30,lines*14+10));
}
/** Excel row height is limited to 409pt. Continue long descriptions without losing text
 * or repeating numeric totals, so printed ledgers remain readable and summable. */
function add(s:ExcelJS.Worksheet,values:Record<string,unknown>) {
  const chunks=new Map<string,unknown[]>();let count=1;
  for(const column of s.columns){
    const key=String(column.key),value=values[key];
    if(column.hidden){chunks.set(key,[value]);continue;}
    if(typeof value!=='string'){chunks.set(key,[value]);continue;}
    const parts:string[]=[];let part='',width=0,lines=1;const limit=Math.max(10,(column.width??20)-2);
    for(const char of value){
      const size=char.codePointAt(0)!>255?2:1;
      if(char==='\n'){lines++;width=0;}else if(width+size>limit){lines++;width=size;}else width+=size;
      if(lines>24){parts.push(part);part='';lines=1;width=char==='\n'?0:size;}
      part+=char;
    }
    parts.push(part);chunks.set(key,parts);count=Math.max(count,parts.length);
  }
  for(let i=0;i<count;i++){
    const continuation=Object.fromEntries([...chunks].map(([key,parts])=>[key,parts[i]??null]));
    if(i>0){if(values.managementNumber)continuation.managementNumber=`${values.managementNumber}（続き）`;if(values.ledgerNo)continuation.ledgerNo=`${values.ledgerNo}（続き）`;if(values.date instanceof Date)continuation.date=values.date;}
    addRow(s,continuation);
  }
}
export async function usedGoodsLedgerWorkbook(ledger:UsedGoodsLedger):Promise<Buffer> {
  const book=new ExcelJS.Workbook();book.creator='株式会社BELLO';book.created=new Date(ledger.generatedAt);book.modified=book.created;
  const presentation=ledgerPresentation(ledger);
  const daily=sheet(book,'古物台帳',`${ledger.year}年 古物台帳（日付・仕入先別）`,'同日・同一仕入先を集計。明細番号で「商品別明細」の商品名・特徴を照合し、両方を保管してください。',[
    {header:'取引年月日',key:'date',width:14,numFmt:'yyyy/mm/dd'},{header:'相手方（氏名・名称／住所／職業）',key:'counterpartyName',width:44},
    {header:'取引区分',key:'transactionType',width:10},{header:'品目',key:'itemTypes',width:30},
    {header:'在庫数量\n（出力時点）',key:'quantity',width:12,numFmt:'#,##0'},
    {header:'購入金額（円）',key:'purchaseAmount',width:16,numFmt:'#,##0'},{header:'送料（円）',key:'shipping',width:13,numFmt:'#,##0'},
    {header:'合計金額（円）',key:'total',width:18,numFmt:'#,##0'},
    {header:'合計の根拠',key:'amountBasis',width:28},{header:'相手方住所',key:'counterpartyAddress',width:38},
    {header:'相手方職業',key:'counterpartyOccupation',width:18},
    {header:'真偽確認の措置・方法',key:'verification',width:32},{header:'商品別明細の管理番号',key:'references',width:25},
    {header:'確認事項',key:'issues',width:50},
    {header:'明細番号',key:'ledgerNo',width:14},{header:'記録状況',key:'recordStatus',width:24},
  ]);
  // Fold the counterparty fields into one readable cell for printing. Full columns
  // remain available in Excel, collapsed rather than removed from the workbook.
  daily.getColumn('counterpartyName').width=36;
  for(const key of ['amountBasis','counterpartyAddress','counterpartyOccupation','references','issues'])daily.getColumn(key).hidden=true;
  for(const r of presentation.groups){
    const firstRow=daily.rowCount+1;
    add(daily,{...r,counterpartyName:[r.counterpartyName||'仕入先未記録',r.counterpartyAddress||'住所未記録',r.counterpartyOccupation||'職業未記録'].join('\n'),date:new Date(r.date+'T00:00:00Z'),purchaseAmount:r.purchaseAmount??'未確定',shipping:r.shipping??'内訳未確定',total:r.total??'未確定',verification:r.verification||'未記録',issues:r.issues.join('\n'),references:r.references.replace(/\n/g,'、')});
    daily.getCell(firstRow,8).note=`${r.amountBasis}${r.issues.length?'\n'+r.issues.join('\n'):''}`;
    daily.getCell(firstRow,4).note=`商品別明細の管理番号：${r.references.replace(/\n/g,'、')}`;
  }
  const columns=[
    {header:'管理番号',key:'managementNumber',width:15},{header:'取引年月日',key:'date',width:14,numFmt:'yyyy/mm/dd'},
    {header:'受入れ・払出し',key:'direction',width:14},{header:'取引区分',key:'transactionType',width:12},
    {header:'商品名',key:'name',width:48},{header:'品目',key:'itemType',width:20},
    {header:'在庫数量\n（出力時点）',key:'quantity',width:12,numFmt:'#,##0'},{header:'古物の特徴',key:'feature',width:38},
    {header:'相手方氏名・名称',key:'counterpartyName',width:24},{header:'相手方住所',key:'counterpartyAddress',width:38},
    {header:'相手方職業',key:'counterpartyOccupation',width:18},
    {header:'真偽確認の措置・方法',key:'verification',width:40},{header:'登録購入価格\n（円）',key:'unitPrice',width:17,numFmt:'#,##0'},
    {header:'購入金額（円）',key:'purchaseAmount',width:16,numFmt:'#,##0'},
    {header:'送料（円）',key:'shipping',width:13,numFmt:'#,##0'},
    {header:'合計金額（円）',key:'total',width:18,numFmt:'#,##0'},
    {header:'計算の根拠',key:'amountBasis',width:40},
    {header:'仕入取引番号',key:'transactionKey',width:28},{header:'販売経路',key:'market',width:18},{header:'確認事項',key:'issues',width:44},
    {header:'明細番号',key:'ledgerNo',width:14},
  ];
  const main=sheet(book,'商品別明細',`${ledger.year}年 商品別明細（受入れ）`,'取引の年月日を基準に抽出。明細番号は「古物台帳」の同じ番号に対応します。',columns);
  const disposals=sheet(book,'払出記録',`${ledger.year}年 払出記録（売却）`,'販売終了日を基準に抽出。仕入先を売却相手として転記しません。',columns);
  main.getCell('A4').value='数量は出力時点の在庫数です（仕入当時の数量ではありません）。金額は同じ明細番号の「古物台帳」を参照。';
  daily.getCell('A4').value=`金額を算出できた ${presentation.knownAmountCount}組の小計 ${presentation.knownAmount.toLocaleString()}円 ／ 金額未確定 ${presentation.unknownAmountCount}組。未確定を含む年間総額ではありません。`;
  for(const s of [main,disposals])for(const key of ['direction','transactionType','itemType','counterpartyAddress','counterpartyOccupation','verification','purchaseAmount','shipping','total','amountBasis','transactionKey','market','issues'])s.getColumn(key).hidden=true;
  for(const r of ledger.rows){
    const s=r.direction==='受入れ'?main:disposals,firstRow=s.rowCount+1;
    const group=r.direction==='受入れ'?presentation.byInventoryId.get(r.inventoryId):undefined;
    add(s,{...r,date:new Date(r.date+'T00:00:00Z'),ledgerNo:group?.ledgerNo??'',unitPrice:r.direction==='払出し'?r.recordedTotal:r.unitPrice,feature:r.feature||'未記録',counterpartyName:r.counterpartyName||'未記録',issues:r.issues.join('\n')});
    s.getCell(firstRow,13).note=[r.amountBasis,...(r.evidence||[])].join('\n');
    if(r.direction==='受入れ')s.getCell(firstRow,7).note='指定に従い、在庫の「数量」を使用。空欄は在庫一覧と同じ0点。明示された分割先の数量は分割元へ合算し、仕入れの二重登録はしません。';
  }
  main.getColumn('transactionType').hidden=false;
  disposals.getCell(HEADER,7).value='払出数量';
  disposals.getCell(HEADER,13).value='登録販売価格\n（円）';
  disposals.getColumn('ledgerNo').hidden=true;
  disposals.getCell('A4').value='販売価格は在庫の登録値です。金額欄を空欄や0円で補完せず、未記録の相手方は「未記録」と表示します。';
  const groups=sheet(book,'仕入取引集計',`${ledger.year}年 仕入取引集計`,'識別できるリステージの開催日・ヤフオク注文ごとに集約。単価の再計算は行いません。',[
    {header:'仕入取引番号',key:'key',width:30},{header:'取引年月日',key:'date',width:14,numFmt:'yyyy/mm/dd'},
    {header:'相手方氏名・名称',key:'counterpartyName',width:26},{header:'品目（分類・カテゴリ・商品名）',key:'itemTypes',width:64},
    {header:'取引数量',key:'quantity',width:12,numFmt:'#,##0'},
    {header:'購入金額（円）',key:'purchaseAmount',width:16,numFmt:'#,##0'},{header:'送料（円）',key:'shipping',width:13,numFmt:'#,##0'},
    {header:'合計金額（円）',key:'total',width:18,numFmt:'#,##0'},{header:'確認事項',key:'issues',width:52},
  ]);
  for(const g of ledger.transactions)add(groups,{...g,itemTypes:[...new Set(g.itemTypes.split(/\n+/))].join('・'),date:new Date(g.date+'T00:00:00Z'),purchaseAmount:g.purchaseAmount??'未確定',shipping:g.shipping??'未確定',total:g.total??'未確定',issues:g.issues.join('\n')});
  const checks=sheet(book,'確認事項',`${ledger.year}年 在庫情報の照合結果`,'在庫・備考・同一仕入先の履歴を照合。元データに残る不足・不一致を記載しています。取引日不明は全期間。',[
    {header:'管理番号',key:'managementNumber',width:16},{header:'登録されている日付',key:'date',width:20},
    {header:'商品名',key:'name',width:60},{header:'確認内容',key:'message',width:80},{header:'明細番号',key:'ledgerNo',width:14},
  ]);
  for(const r of ledger.issues){
    const group=r.message.startsWith('払出し：')?undefined:presentation.byInventoryId.get(r.inventoryId);
    const dailyMatches=r.managementNumber==='日次集計'?presentation.groups.filter(g=>g.date===r.date&&g.counterpartyName===r.name):[];
    add(checks,{...r,ledgerNo:group?.ledgerNo??dailyMatches.map(g=>g.ledgerNo).join('\n')});
  }
  checks.getCell('A4').value='年齢欄は指定により省略しています。法令上記録が必要な取引では、原票等の記録と併せて保管してください。';
  groups.getCell('A4').value='数量は在庫欄の集計。金額は注文・開催日の記録を使用。空欄送料は0円として集計しています。';
  groups.getCell(HEADER,5).value='在庫数量\n（出力時点）';
  for(const s of [main,disposals,groups,daily]){s.pageSetup.fitToWidth=1;s.pageSetup.printTitlesColumn='A:B';}
  const stamp=new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',dateStyle:'short',timeStyle:'short'}).format(book.created);
  for(const s of [daily,main,disposals,groups,checks]){s.getCell('A1').value=`株式会社BELLO　出力日時：${stamp}（日本時間）`;s.autoFilter={from:{row:HEADER,column:1},to:{row:Math.max(HEADER,s.rowCount),column:s.columnCount}};s.pageSetup.printArea=`A1:${s.getColumn(s.columnCount).letter}${s.rowCount}`;}
  daily.getCell('A3').value+=' 数量は現在の在庫数・送料未入力は0円。';
  checks.getCell('A3').value+=` 分割先の仕入れ重複 ${ledger.omittedSplits}件、1万円未満・古物情報未記入の家具類 ${ledger.omittedLowValue??0}件は受入れ出力対象外。`;
  return Buffer.from(await book.xlsx.writeBuffer());
}
