import { describe, expect, it } from "vitest";

import { formatApproxCost } from "./formatCost";

describe("formatApproxCost", () => {
  it("renders sub-dollar amounts as cents with one decimal", () => {
    expect(formatApproxCost(0.05)).toBe("5.0¢");
    expect(formatApproxCost(0.134)).toBe("13.4¢");
    expect(formatApproxCost(0.0495)).toBe("5.0¢"); // rounds to one decimal
    expect(formatApproxCost(0.0672)).toBe("6.7¢");
  });

  it("renders a genuine zero as 0.0¢ (unavailable never reaches the formatter)", () => {
    expect(formatApproxCost(0)).toBe("0.0¢");
  });

  it("switches to two-decimal dollars at and above $1", () => {
    expect(formatApproxCost(1)).toBe("$1.00");
    expect(formatApproxCost(1.2)).toBe("$1.20");
    expect(formatApproxCost(12.345)).toBe("$12.35");
  });

  it("keeps just-below-a-dollar amounts in cents", () => {
    expect(formatApproxCost(0.999)).toBe("99.9¢");
  });
});
