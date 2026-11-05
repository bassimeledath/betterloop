import { describe, it, expect } from "vitest";
import { nextDelivery, advanceDelivery } from "../shared/schedule";
import { catchUpDelivery } from "../server/scheduler";
const rule = { day: 31, hour: 17, minute: 0, weekday: 7 };
describe("calendar recurrence", () => {
  it("keeps the fortnightly anchor when catching up after an outage", async () => {
    const g = {
      timezone: "America/Los_Angeles",
      cadence: "fortnightly" as const,
      recurrence_json: JSON.stringify({ ...rule, hour: 9 }),
    };
    const next = await catchUpDelivery(
      Date.parse("2027-03-07T17:00:00Z"),
      Date.parse("2027-04-05T18:00:00Z"),
      g,
    );
    expect(new Date(next).toISOString()).toBe("2027-04-18T16:00:00.000Z");
  });
  it("clamps monthly dates without drifting future months", () => {
    const feb = nextDelivery(
      Date.parse("2027-02-01T12:00:00Z"),
      "America/Los_Angeles",
      "monthly",
      rule,
    );
    expect(new Date(feb).toISOString()).toBe("2027-03-01T01:00:00.000Z");
    expect(
      new Date(
        advanceDelivery(feb, "America/Los_Angeles", "monthly", rule),
      ).toISOString(),
    ).toBe("2027-04-01T00:00:00.000Z");
  });
  it("moves forward through a nonexistent daylight-saving time", () => {
    const n = nextDelivery(
      Date.parse("2027-03-13T00:00:00Z"),
      "America/Los_Angeles",
      "weekly",
      { ...rule, hour: 2, minute: 30 },
    );
    expect(new Date(n).toISOString()).toBe("2027-03-14T10:30:00.000Z");
  });
  it("chooses the earlier occurrence of an ambiguous time", () => {
    const n = nextDelivery(
      Date.parse("2026-10-31T00:00:00Z"),
      "America/Los_Angeles",
      "weekly",
      { ...rule, hour: 1, minute: 30 },
    );
    expect(new Date(n).toISOString()).toBe("2026-11-01T08:30:00.000Z");
  });
  it("retains fourteen local days across daylight-saving changes", () => {
    expect(
      new Date(
        advanceDelivery(
          Date.parse("2027-03-07T17:00:00Z"),
          "America/Los_Angeles",
          "fortnightly",
          { ...rule, hour: 9 },
        ),
      ).toISOString(),
    ).toBe("2027-03-21T16:00:00.000Z");
  });
});
