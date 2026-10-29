import ExcelJS from 'exceljs';
import type {UsedGoodsLedger} from './usedGoodsLedger';

const HEADER=5;
function sheet(book:ExcelJS.Workbook,name:string,title:string,note:string,columns:{header:string;key:string;width:number;numFmt?:string}[]) {
  const s=book.addWorksheet(name,{views:[{state:'frozen',ySplit:HEADER,xSplit:2,showGridLines:false}],properties:{defaultRowHeight:23},pageSetup:{paperSize:9,orientation:'landscape',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:5',margins:{left:0.25,right:0.25,top:0.4,bottom:0.4,header:0.2,footer:0.2}}});
  s.columns=columns.map(({key,width,numFmt})=>({key,width,...(numFmt?{style:{numFmt}}:{})}));
  s.getCell('A2').value=title;s.getCell('A2').font={name:'Yu Gothic',size:15,bold:true,color:{argb:'FF183153'}};
  s.getCell('A3').value=note;s.getCell('A3').font={name:'Yu Gothic',size:10,color:{argb:'FF475569'}};
  s.getRow(HEADER).values=columns.map(c=>c.header);s.getRow(HEADER).height=42;
  s.getRow(HEADER).eachCell(c=>{c.font={name:'Yu Gothic',size:10,bold:true,color:{argb:'FFFFFFFF'}};c.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF183153'}};c.alignment={vertical:'middle',horizontal:'center',wrapText:true};});
  s.headerFooter.oddFooter='&L株式会社BELLO&R&P / &N';
  return s;
}
function add(s:ExcelJS.Worksheet,values:Record<string,unknown>) {
  // Assign strings as literal cell values (never formula/hyperlink objects).
  const r=s.addRow(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value===''?null:value]))); let lines=1;
  r.eachCell((cell,col)=>{
    cell.font={name:'Yu Gothic',size:10,color:{argb:'FF1E293B'}};
    cell.alignment={vertical:'top',wrapText:true,horizontal:typeof cell.value==='number'?'right':'left'};
    if(r.number%2===0)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F5F9'}};
    const text=String(cell.value??'');
    const wrappedLines=text.split('\n').reduce((count,line)=>{
      const width=[...line].reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0);
      return count+Math.max(1,Math.ceil(width/Math.max(10,(s.getColumn(col).width??20)-2)));
    },0);
    lines=Math.max(lines,wrappedLines);
  });
  r.height=Math.min(409,Math.max(30,lines*14+10));
}
export async function usedGoodsLedgerWorkbook(ledger:UsedGoodsLedger):Promise<Buffer> {
  const book=new ExcelJS.Workbook();book.creator='株式会社BELLO';book.created=new Date(ledger.generatedAt);book.modified=book.created;
  const daily=sheet(book,'古物台帳',`${ledger.year}年 古物台帳（日付・仕入先別）`,'同じ日・同じ仕入先を1行に集計。商品ごとの品目・特徴は「商品別明細」と併せて保管してください。',[
    {header:'取引年月日',key:'date',width:14,numFmt:'yyyy/mm/dd'},{header:'相手方氏名・名称',key:'counterpartyName',width:28},
    {header:'取引区分',key:'transactionType',width:12},{header:'品目（登録内容）',key:'itemTypes',width:36},
    {header:'取引数量',key:'quantity',width:12,numFmt:'#,##0'},{header:'仕入れ合計（円）',key:'total',width:18,numFmt:'#,##0'},
    {header:'合計の根拠',key:'amountBasis',width:28},{header:'相手方住所',key:'counterpartyAddress',width:38},
    {header:'相手方職業',key:'counterpartyOccupation',width:18},{header:'年齢・生年月日',key:'counterpartyAge',width:18},
    {header:'真偽確認の措置・方法',key:'verification',width:40},{header:'商品別明細の管理番号',key:'references',width:25},
    {header:'商品ページ数',key:'products',width:13,numFmt:'#,##0'},{header:'確認事項',key:'issues',width:50},
  ]);
  for(const r of ledger.supplierDays)add(daily,{...r,date:new Date(r.date+'T00:00:00Z'),issues:r.issues.join('\n')});
  const columns=[
    {header:'管理番号',key:'managementNumber',width:15},{header:'取引年月日',key:'date',width:14,numFmt:'yyyy/mm/dd'},
    {header:'受入れ・払出し',key:'direction',width:14},{header:'取引区分',key:'transactionType',width:12},
    {header:'商品名',key:'name',width:42},{header:'品目（登録内容）',key:'itemType',width:28},
    {header:'数量',key:'quantity',width:10,numFmt:'#,##0'},{header:'古物の特徴',key:'feature',width:40},
    {header:'相手方氏名・名称',key:'counterpartyName',width:24},{header:'相手方住所',key:'counterpartyAddress',width:38},
    {header:'相手方職業',key:'counterpartyOccupation',width:18},{header:'年齢・生年月日',key:'counterpartyAge',width:18},
    {header:'真偽確認の措置・方法',key:'verification',width:40},{header:'購入単価（円）',key:'unitPrice',width:15,numFmt:'#,##0'},
    {header:'登録済み合計（円）※',key:'recordedTotal',width:18,numFmt:'#,##0'},
    {header:'仕入取引番号',key:'transactionKey',width:28},{header:'販売経路',key:'market',width:18},{header:'確認事項',key:'issues',width:44},
  ];
  const main=sheet(book,'商品別明細',`${ledger.year}年 商品別明細（受入れ）`,'取引の年月日を基準に抽出。未記録の項目は空欄です。',columns);
  const disposals=sheet(book,'払出記録',`${ledger.year}年 払出記録（売却）`,'販売終了日を基準に抽出。仕入先を売却相手として転記しません。',columns);
  main.getCell('A4').value='※受入れは「その日の仕入れ合計金額」、払出しは「販売価格」。受入れの合計を行ごとに足し合わせないでください。';
  for(const r of ledger.rows)add(r.direction==='受入れ'?main:disposals,{...r,date:new Date(r.date+'T00:00:00Z'),issues:r.issues.join('\n')});
  const groups=sheet(book,'仕入取引集計',`${ledger.year}年 仕入取引集計`,'識別できるリステージの開催日・ヤフオク注文ごとに集約。単価の再計算は行いません。',[
    {header:'仕入取引番号',key:'key',width:30},{header:'取引年月日',key:'date',width:14,numFmt:'yyyy/mm/dd'},
    {header:'相手方氏名・名称',key:'counterpartyName',width:26},{header:'品目（登録内容）',key:'itemTypes',width:46},
    {header:'取引数量',key:'quantity',width:12,numFmt:'#,##0'},{header:'取引合計（円）',key:'total',width:18,numFmt:'#,##0'},
    {header:'商品ページ数',key:'products',width:15,numFmt:'#,##0'},{header:'確認事項',key:'issues',width:52},
  ]);
  for(const g of ledger.transactions)add(groups,{...g,date:new Date(g.date+'T00:00:00Z'),issues:g.issues.join('\n')});
  const checks=sheet(book,'確認事項',`${ledger.year}年 台帳の確認事項`,'取引日未登録は全期間から表示。空欄を推測で補完せず、元の商品情報で確認してください。',[
    {header:'管理番号',key:'managementNumber',width:16},{header:'登録されている日付',key:'date',width:20},
    {header:'商品名',key:'name',width:60},{header:'確認内容',key:'message',width:80},
  ]);
  for(const r of ledger.issues)add(checks,{...r});
  main.pageSetup.fitToWidth=3; main.pageSetup.printTitlesColumn='A:B'; disposals.pageSetup.fitToWidth=3; disposals.pageSetup.printTitlesColumn='A:B'; groups.pageSetup.fitToWidth=2;
  daily.pageSetup.fitToWidth=3;daily.pageSetup.printTitlesColumn='A:B';
  for(const s of [daily,main,disposals,groups,checks]){s.autoFilter={from:{row:HEADER,column:1},to:{row:Math.max(HEADER,s.rowCount),column:s.columnCount}};s.pageSetup.printArea=`A1:${s.getColumn(s.columnCount).letter}${s.rowCount}`;}
  return Buffer.from(await book.xlsx.writeBuffer());
}
