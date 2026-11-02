export const WIDE_ASPECT_RATIO = 4 / 3;
// Whole-pixel units keep preview crops and saved images at the same ratio.
export function framingUnits(ratio) {
  return ratio === 1 ? [1, 1] : ratio === WIDE_ASPECT_RATIO ? [4, 3] : null;
}
