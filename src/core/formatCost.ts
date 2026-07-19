// Shared approximate-cost display formatter (P8). One rule everywhere an estimate or a
// per-candidate cost is shown: under a dollar reads as cents with ONE decimal ("5.0¢",
// "13.4¢"); a dollar or more reads as dollars with two decimals ("$1.20").
//
// This formats KNOWN amounts only — the never-render-unavailable-as-$0 rule lives at the
// call sites (they must check cost.status BEFORE reaching for a number). The cross-session
// spend popover intentionally does NOT use this: its headline stays in dollars (formatSpend).
export function formatApproxCost(usd: number): string {
  if (usd < 1) return `${(usd * 100).toFixed(1)}¢`;
  return `$${usd.toFixed(2)}`;
}
