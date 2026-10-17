import { NextResponse } from "next/server";
import { requireMobileFeature } from "@/lib/mobile/session";
import { loadSalesSummary, loadSalesItems } from "@/lib/inventory/salesView";
import { nowInJst, isCurrentJstYearMonth, forecastReferenceDay, calculateMonthEndForecast } from "@/lib/inventory/sales";
export const dynamic="force-dynamic";
export async function GET(request:Request) {
  const headers={"Cache-Control":"private, no-store",Vary:"Cookie"};
  const session=await requireMobileFeature("sales");
  if(!session.ok)return NextResponse.json({error:session.error},{status:session.status,headers});
  const params=new URL(request.url).searchParams; const now=new Date(); const current=nowInJst(now);
  const year=Number(params.get("y")||current.year), month=Number(params.get("m")||current.month);
  if(!Number.isInteger(year)||year<2000||year>current.year+1||!Number.isInteger(month)||month<1||month>12)
    return NextResponse.json({error:"INVALID_MONTH"},{status:422,headers});
  try {
    if(params.get("items")==="1") return NextResponse.json({owner:session.owner,items:await loadSalesItems(year,month)},{headers});
    const view=await loadSalesSummary(year,month);
    const reference=isCurrentJstYearMonth(year,month,now)&&view.status==="ok"&&view.aggregateRebuiltAt ? forecastReferenceDay(view.aggregateRebuiltAt,year,month,now):null;
    const forecast=reference?.ok?calculateMonthEndForecast(view.totals.totalSales,year,month,reference.day):null;
    return NextResponse.json({owner:session.owner,view,forecast,forecastUnavailable:reference!==null&&!reference.ok},{headers});
  } catch {return NextResponse.json({error:"SALES_UNAVAILABLE"},{status:503,headers});}
}
