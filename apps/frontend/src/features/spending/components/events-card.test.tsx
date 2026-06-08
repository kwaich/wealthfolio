import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FOREST_THEME } from "../lib/theme";
import { useSpendingEvents } from "../hooks/use-spending-events";
import type { SpendingEvent } from "../types/event";
import { EventsCard } from "./events-card";

vi.mock("@tanstack/react-query", async () => {
  const actual =
    await vi.importActual<typeof import("@tanstack/react-query")>("@tanstack/react-query");
  return {
    ...actual,
    useQueries: vi.fn(() => []),
  };
});

vi.mock("../hooks/use-spending-events", () => ({
  useSpendingEvents: vi.fn(),
}));

vi.mock("./event-dialog-provider", () => ({
  useEventDialog: () => ({
    openEventDialog: vi.fn(),
    openEventTypeDialog: vi.fn(),
  }),
}));

const mockUseSpendingEvents = vi.mocked(useSpendingEvents);

function event(overrides: Partial<SpendingEvent> = {}): SpendingEvent {
  return {
    id: "event-1",
    name: "Sister Wedding",
    description: null,
    eventTypeId: "type-1",
    startDate: "2026-04-16",
    endDate: "2026-04-20",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderEventsCard(periodStartDate: string, periodEndDate: string) {
  return render(
    <MemoryRouter>
      <EventsCard
        activities={[]}
        categoriesMeta={new Map()}
        periodEndDate={periodEndDate}
        periodStartDate={periodStartDate}
        theme={FOREST_THEME}
      />
    </MemoryRouter>,
  );
}

describe("EventsCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-05T12:00:00.000Z"));
    mockUseSpendingEvents.mockReturnValue({
      data: [event()],
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useSpendingEvents>);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shows an event that overlaps the selected dashboard period", () => {
    renderEventsCard("2026-03-05T05:00:00.000Z", "2026-06-05T03:59:59.999Z");

    expect(screen.getByText("Sister Wedding")).toBeInTheDocument();
    expect(screen.getByText("PERIOD")).toBeInTheDocument();
    expect(screen.queryByText("No events in this period")).not.toBeInTheDocument();
  });

  it("keeps the empty state when events are outside the selected dashboard period", () => {
    renderEventsCard("2026-05-01T04:00:00.000Z", "2026-06-05T03:59:59.999Z");

    expect(screen.getByText("No events in this period")).toBeInTheDocument();
    expect(screen.queryByText("Sister Wedding")).not.toBeInTheDocument();
  });
});
