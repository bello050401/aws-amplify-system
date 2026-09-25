import type { Stats } from "sharp";

/** Only place an automatic badge over a nearly white, visually quiet corner. */
export function hasClearLogoCorner(stats: Stats): boolean {
  const rgb = stats.channels.slice(0, 3);
  if (rgb.length !== 3) return false;
  const means = rgb.map((channel) => channel.mean);
  return means.every((mean) => mean >= 225)
    && Math.max(...means) - Math.min(...means) <= 18
    && rgb.every((channel) => channel.stdev <= 18);
}
