// Helpers shared inside the package. Not part of the public API.

/**
 * Exhaustiveness guard for `switch` statements. TypeScript rejects the call if a case is
 * missing; at runtime it catches values that bypassed the types (e.g. unvalidated JSON).
 */
export function assertNever(value: never, what: string): never {
  throw new Error(`unknown ${what}: ${JSON.stringify(value)}`);
}

/** Up to 6 significant digits, without trailing zeros: 142.1, 0.00002345, 33.3333. */
export function formatNumber(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/** Indicators whose values are percentages. */
export function isPercentIndicator(name: string): boolean {
  return name === "cumulativeReturn" || name === "stdDevReturn" || name === "maxDrawdown";
}
