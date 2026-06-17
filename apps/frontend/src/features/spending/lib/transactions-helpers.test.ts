import { describe, expect, it } from "vitest";

import type { CashActivity } from "../types/cash-activity";
import { getTransferLinkStatus, isTransferCashActivity } from "./transactions-helpers";

function cashActivity(overrides: Partial<CashActivity>): CashActivity {
  return {
    id: "activity-1",
    activityType: "WITHDRAWAL",
    activityDate: "2026-01-01T00:00:00.000Z",
    accountId: "account-1",
    amount: "100",
    currency: "USD",
    cashFlowBucket: "neutral",
    assignments: [],
    isUserModified: false,
    needsReview: false,
    status: "POSTED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as CashActivity;
}

describe("spending transaction helpers", () => {
  it("treats activity type overrides as transfer rows", () => {
    const activity = cashActivity({
      activityTypeOverride: "TRANSFER_OUT",
      transferLinkStatus: "unlinked",
    });

    expect(isTransferCashActivity(activity)).toBe(true);
    expect(getTransferLinkStatus(activity)).toBe("unlinked");
  });

  it("does not expose transfer link status for non-transfer effective types", () => {
    expect(getTransferLinkStatus(cashActivity({ sourceGroupId: "group-1" }))).toBeNull();
  });
});
