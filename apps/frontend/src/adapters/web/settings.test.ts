import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  logger: {
    error: vi.fn(),
  },
}));

vi.mock("./core", () => ({
  API_PREFIX: "/api/v1",
  invoke: mocks.invoke,
  logger: mocks.logger,
}));

import { getSettings } from "./settings";

describe("web getSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("propagates backend failures", async () => {
    const error = new Error("Backend unavailable");
    mocks.invoke.mockRejectedValue(error);

    await expect(getSettings()).rejects.toThrow("Backend unavailable");
    expect(mocks.logger.error).toHaveBeenCalledWith("Error fetching settings.");
  });
});
