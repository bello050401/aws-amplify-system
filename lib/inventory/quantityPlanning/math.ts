export type Rational = Readonly<{ numerator: bigint; denominator: bigint }>;

export const ZERO: Rational = { numerator: 0n, denominator: 1n };

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    [left, right] = [right, left % right];
  }
  return left < 0n ? -left : left;
}

export function ratio(numerator: bigint, denominator = 1n): Rational {
  if (denominator <= 0n) throw new RangeError("Expected a positive denominator");
  const divisor = gcd(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
}

export function decimal(value: unknown): Rational | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (raw.length > 128) return null;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match || !Number.isFinite(Number(raw))) return null;
  const fraction = match[3] ?? match[4] ?? "";
  const exponent = Number(match[5] ?? 0) - fraction.length;
  if (Math.abs(exponent) > 500) return null;
  const numerator = BigInt(`${match[1]}${match[2] ?? "0"}${fraction}`);
  return exponent >= 0
    ? ratio(numerator * 10n ** BigInt(exponent))
    : ratio(numerator, 10n ** BigInt(-exponent));
}

export function add(left: Rational, right: Rational): Rational {
  return ratio(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

export function subtract(left: Rational, right: Rational): Rational {
  return add(left, { numerator: -right.numerator, denominator: right.denominator });
}

export function multiply(left: Rational, right: Rational): Rational {
  return ratio(left.numerator * right.numerator, left.denominator * right.denominator);
}

export function divide(left: Rational, right: Rational): Rational {
  return ratio(left.numerator * right.denominator, left.denominator * right.numerator);
}

export function scale(value: Rational, multiplier: bigint): Rational {
  return ratio(value.numerator * multiplier, value.denominator);
}

export function commonDenominator(values: readonly Rational[]): bigint {
  return values.reduce(
    (common, { denominator }) => common / gcd(common, denominator) * denominator,
    1n,
  );
}

export class CalculationOutOfRange extends Error {}

export function toNumber({ numerator, denominator }: Rational): number {
  if (numerator === 0n) return 0;
  const absolute = numerator < 0n ? -numerator : numerator;
  const shift = 18 - absolute.toString().length + denominator.toString().length;
  const significand = shift >= 0
    ? absolute * 10n ** BigInt(shift) / denominator
    : absolute / (denominator * 10n ** BigInt(-shift));
  const converted = Number(`${numerator < 0n ? "-" : ""}${significand}e${-shift}`);
  if (!Number.isFinite(converted) || converted === 0) throw new CalculationOutOfRange();
  return converted;
}

export function blockCount(quantity: bigint, unitsPerBlock: bigint): bigint {
  return (quantity + unitsPerBlock - 1n) / unitsPerBlock;
}

function blockCountPrefix(quantity: bigint, unitsPerBlock: bigint): bigint {
  const complete = quantity / unitsPerBlock;
  const remainder = quantity % unitsPerBlock;
  return unitsPerBlock * complete * (complete + 1n) / 2n + remainder * (complete + 1n);
}

/** Integral of occupied blocks over a sale schedule on one common time scale. */
export function storageBlockTicks(
  quantity: bigint,
  retailQuantity: bigint,
  unitsPerBlock: bigint,
  saleInterval: bigint,
  wholesaleTime: bigint,
): bigint {
  const retailBeforeWholesale = wholesaleTime / saleInterval;
  const soldByWholesale = retailQuantity < retailBeforeWholesale ? retailQuantity : retailBeforeWholesale;
  const remainingAtWholesale = quantity - soldByWholesale;
  const partialInterval = wholesaleTime - soldByWholesale * saleInterval;
  const beforeWholesale =
    saleInterval * (blockCountPrefix(quantity, unitsPerBlock) - blockCountPrefix(remainingAtWholesale, unitsPerBlock))
    + partialInterval * blockCount(remainingAtWholesale, unitsPerBlock);

  const retailAfterWholesale = retailQuantity - soldByWholesale;
  if (retailAfterWholesale === 0n) return beforeWholesale;
  return beforeWholesale
    + (saleInterval - partialInterval) * blockCount(retailAfterWholesale, unitsPerBlock)
    + saleInterval * blockCountPrefix(retailAfterWholesale - 1n, unitsPerBlock);
}
