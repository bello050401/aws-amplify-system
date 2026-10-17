import test from "node:test";
import assert from "node:assert/strict";
import { salesChart } from "../../lib/inventory/salesChart";
import { dateParts, dateValue, validDateParts } from "../src/domain/dateWheel";
test("date wheels clamp month-end and leap day, preserving canonical save values",()=>{
  assert.equal(dateValue({...dateParts("2026/01/31"),month:2}),"2026-02-28");
  assert.equal(dateValue({...dateParts("2024/01/31"),month:2}),"2024-02-29");
  assert.equal(dateValue({...dateParts("2024/02/29"),year:2025}),"2025-02-28");
  assert.deepEqual(validDateParts({year:2026,month:12,day:31}),{year:2026,month:12,day:31});
});
test("line chart distinguishes missing months, real zero, and negative profit",()=>{
  const points=[{year:2026,month:1,status:"ok" as const,totalSales:100,totalGrossProfit:50},{year:2026,month:2,status:"missing" as const,totalSales:0,totalGrossProfit:0},{year:2026,month:3,status:"ok" as const,totalSales:0,totalGrossProfit:0},{year:2026,month:4,status:"ok" as const,totalSales:20,totalGrossProfit:-40}];
  const chart=salesChart(points,320,180);
  assert.equal((chart.salesPath.match(/M /g)||[]).length,2);
  assert.equal((chart.salesPath.match(/L /g)||[]).length,1);
  assert.ok(chart.yFor(-40)>chart.yFor(0));
  assert.ok(chart.yFor(-40)<=180-chart.padding.bottom);
  assert.ok(chart.yFor(100)>=chart.padding.top);
  assert.ok(!chart.salesPath.includes("NaN"));
});
