import test from "node:test";
import assert from "node:assert/strict";
import { salesChart,salesTrendLabel } from "../../lib/inventory/salesChart";
import { dateParts, dateValue, validDateParts } from "../src/domain/dateWheel";
test("date wheels clamp month-end and leap day, preserving canonical save values",()=>{
  assert.equal(dateValue({...dateParts("2026/01/31"),month:2}),"2026-02-28");
  assert.equal(dateValue({...dateParts("2024/01/31"),month:2}),"2024-02-29");
  assert.equal(dateValue({...dateParts("2024/02/29"),year:2025}),"2025-02-28");
  assert.deepEqual(validDateParts({year:2026,month:12,day:31}),{year:2026,month:12,day:31});
});
test("bar chart keeps missing months distinct from zero and plots negative profit below the baseline",()=>{
  const points=[{year:2026,month:1,status:"ok" as const,totalSales:100,totalGrossProfit:50},{year:2026,month:2,status:"missing" as const,totalSales:0,totalGrossProfit:0},{year:2026,month:3,status:"ok" as const,totalSales:0,totalGrossProfit:0},{year:2026,month:4,status:"ok" as const,totalSales:20,totalGrossProfit:-40}];
  const chart=salesChart(points,320,180);
  const zero=chart.bar(2,0,"sales");
  const positive=chart.bar(0,100,"sales");
  const negative=chart.bar(3,-40,"profit");
  assert.equal(zero.height,2);
  assert.equal(positive.y+positive.height,chart.zero);
  assert.equal(negative.y,chart.zero);
  assert.ok(negative.y+negative.height<=180-chart.padding.bottom);
  assert.match(salesTrendLabel(points[1]),/未集計/);
  assert.match(salesTrendLabel(points[2]),/売上高 ¥0/);
});
