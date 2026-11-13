export function monthEndBoundary(month:string):string {
  if(!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month))throw Error('Invalid inventory month');
  const [y,m]=month.split('-').map(Number);
  return new Date(Date.UTC(y,m,1,-9)).toISOString();
}
export function lastClosedInventoryMonth(now=new Date()):string {
  const jst=new Date(now.getTime()+9*3600_000);
  return new Date(Date.UTC(jst.getUTCFullYear(),jst.getUTCMonth()-1,1)).toISOString().slice(0,7);
}
export function inventoryMonthOptions(now=new Date()):string[] {
  const end=lastClosedInventoryMonth(now),out:string[]=[];
  for(let y=2026;y<=Number(end.slice(0,4));y++)for(let m=1;m<=12;m++){
    const month=`${y}-${String(m).padStart(2,'0')}`;
    if(month>='2026-10'&&month<=end)out.unshift(month);
  }
  return out;
}
