import { afterEach, describe, expect, it, vi } from "vitest";

import {
  addMonthsToMonthKey,
  currentMonthKey,
  monthReportsRange,
  parseMonthKey,
} from "./month-period";

describe("spending month periods", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses and shifts valid month keys", () => {
    expect(parseMonthKey("2026-05")).toEqual({ year: 2026, month: 5 });
    expect(parseMonthKey("2026-13")).toBeNull();
    expect(addMonthsToMonthKey("2026-01", -1)).toBe("2025-12");
  });

  it("resolves a month key to a full calendar month report range", () => {
    const range = monthReportsRange("2026-05", "UTC");

    expect(range?.start.toISOString()).toBe("2026-05-01T00:00:00.000Z");
    expect(range?.end.toISOString()).toBe("2026-05-31T23:59:59.999Z");
    expect(range?.days).toBe(31);
    expect(range?.months).toBe(1);
  });

  it("reads the current month in the requested timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T03:00:00.000Z"));

    expect(currentMonthKey("America/Toronto")).toBe("2026-05");
  });
});
