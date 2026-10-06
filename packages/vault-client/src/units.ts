// Conversions between whole-token amounts ("1000.5") and base units (bigint).

/** Parses a decimal string of whole tokens into base units. Rejects excess precision. */
export function parseUnits(value: string, decimals: number): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a non-negative decimal amount: "${value}"`);
  const [, whole = "0", fraction = ""] = match;
  if (fraction.length > decimals) {
    throw new Error(`"${value}" has more than ${decimals} decimal places`);
  }
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

/** Formats base units as whole tokens, without trailing zeros: 1_000_500_000n, 6 -> "1000.5". */
export function formatUnits(amount: bigint, decimals: number): string {
  const negative = amount < 0n;
  const digits = (negative ? -amount : amount).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
