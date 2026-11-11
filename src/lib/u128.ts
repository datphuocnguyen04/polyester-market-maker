/**
 * Exact 18-decimal (e18) integer and ConnectRPC U128 ({ hi, lo }) utilities.
 *
 * Per Polyester documentation ("Scaled integers" & "Swap"):
 * - All Swap amounts use 18-decimal integers (amount_e18), regardless of the
 *   asset's native spot order scale.
 * - U128 is serialized in JSON as { hi: "<uint64 decimal>", lo: "<uint64 decimal>" }.
 * - Never use floating-point numbers when converting amounts.
 */

export interface U128Json {
  hi: string;
  lo: string;
}

const E18_DECIMALS = 18;
const E18_FACTOR = 10n ** 18n;
const MASK_64 = (1n << 64n) - 1n;
const MAX_U128 = (1n << 128n) - 1n;

/**
 * Parses a positive or zero decimal string (e.g. "10", "10.5", "0.000001")
 * into an exact 18-decimal bigint (`amount_e18`).
 */
export function toE18(decimalStr: string): bigint {
  const trimmed = decimalStr.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid non-negative decimal string: "${decimalStr}"`);
  }

  const [wholePart, fracPart = ""] = trimmed.split(".");
  if (fracPart.length > E18_DECIMALS) {
    throw new Error(
      `Decimal string "${decimalStr}" exceeds maximum precision of ${E18_DECIMALS} decimals`
    );
  }

  const paddedFrac = fracPart.padEnd(E18_DECIMALS, "0");
  const value = BigInt(wholePart) * E18_FACTOR + BigInt(paddedFrac);
  if (value > MAX_U128) {
    throw new Error(`Value ${decimalStr} overflows U128`);
  }
  return value;
}

/**
 * Formats an 18-decimal bigint (`amount_e18`) into a human-readable decimal string,
 * stripping unnecessary trailing fractional zeros (e.g. `10500000000000000000n` -> `"10.5"`).
 */
export function fromE18(value: bigint): string {
  if (value < 0n) {
    throw new Error(`Negative e18 value is not supported: ${value}`);
  }
  const whole = value / E18_FACTOR;
  const frac = value % E18_FACTOR;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracStr = frac.toString().padStart(E18_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/**
 * Converts a non-negative bigint into ConnectRPC's U128 JSON representation `{ hi, lo }`.
 */
export function toU128(value: bigint): U128Json {
  if (value < 0n || value > MAX_U128) {
    throw new Error(`Value out of U128 range: ${value}`);
  }
  const hi = value >> 64n;
  const lo = value & MASK_64;
  return {
    hi: hi.toString(),
    lo: lo.toString(),
  };
}

/**
 * Converts a ConnectRPC U128 JSON object `{ hi?, lo? }` (where fields may be
 * strings, numbers, or omitted when 0 in protobuf JSON) back into a bigint.
 */
export function fromU128(u128: { hi?: string | number; lo?: string | number } | null | undefined): bigint {
  if (!u128) {
    return 0n;
  }
  const hi = BigInt(u128.hi ?? 0);
  const lo = BigInt(u128.lo ?? 0);
  if (hi < 0n || lo < 0n || hi > MASK_64 || lo > MASK_64) {
    throw new Error(`Invalid U128 limbs: hi=${ String(u128.hi) }, lo=${ String(u128.lo) }`);
  }
  return (hi << 64n) | lo;
}
