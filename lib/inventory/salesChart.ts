import type { SalesTrendPoint } from "./salesViewTypes";

/** Shared by the Web and staff app: missing months break the line, real zeroes do not. */
export function salesChart(points: SalesTrendPoint[], width = 640, height = 220) {
  const padding = { top: 16, right: 16, bottom: 24, left: 8 };
  const values = points.filter(point => point.status === "ok").flatMap(point => [point.totalSales, point.totalGrossProfit]);
  const max = Math.max(1, ...values);
  const min = Math.min(0, ...values);
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const xFor = (index: number) => padding.left + (points.length <= 1 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
  const yFor = (value: number) => padding.top + plotHeight - (value - min) / (max - min) * plotHeight;
  const path = (valueOf: (point: SalesTrendPoint) => number) => {
    let drawing = false;
    return points.flatMap((point, index) => {
      if (point.status !== "ok") { drawing = false; return []; }
      const command = `${drawing ? "L" : "M"} ${xFor(index)} ${yFor(valueOf(point))}`;
      drawing = true;
      return [command];
    }).join(" ");
  };
  return { padding, plotWidth, plotHeight, xFor, yFor, salesPath: path(point => point.totalSales), profitPath: path(point => point.totalGrossProfit) };
}
