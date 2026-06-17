import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AddonUpdateCheckResult } from "@wealthfolio/addon-sdk";
import type { InstalledAddon } from "@/adapters";
import { QueryKeys } from "@/lib/query-keys";
import { useAddonUpdates } from "./use-addon-updates";

const mocks = vi.hoisted(() => ({
  checkAddonUpdate: vi.fn(),
  checkAllAddonUpdates: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  checkAddonUpdate: mocks.checkAddonUpdate,
  checkAllAddonUpdates: mocks.checkAllAddonUpdates,
}));

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

const installedAddon: InstalledAddon = {
  metadata: {
    id: "swingfolio",
    name: "Swingfolio",
    version: "3.1.0",
    enabled: true,
  },
  filePath: "/addons/swingfolio",
  isZipAddon: true,
};

const updateResult: AddonUpdateCheckResult = {
  addonId: "swingfolio",
  updateInfo: {
    currentVersion: "3.1.0",
    latestVersion: "3.5.1",
    updateAvailable: true,
  },
};

describe("useAddonUpdates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses cached auto-check results for card update state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    queryClient.setQueryData(
      [QueryKeys.ADDON_AUTO_UPDATE_CHECK, ["swingfolio@3.1.0"]],
      [updateResult],
    );

    const { result } = renderHook(
      () =>
        useAddonUpdates({
          installedAddons: [installedAddon],
          autoCheck: true,
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() => {
      expect(result.current.getUpdateResult("swingfolio")).toEqual(updateResult);
    });
    expect(result.current.hasUpdates()).toBe(true);
    expect(mocks.checkAllAddonUpdates).not.toHaveBeenCalled();
  });
});
