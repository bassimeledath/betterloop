import { Temporal } from "@js-temporal/polyfill";
export interface Recurrence {
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}
export { validTimezone } from "./timezone";
export function nextDelivery(
  after: number,
  zone: string,
  cadence: "weekly" | "fortnightly" | "monthly",
  rule: Recurrence,
): number {
  const current =
    Temporal.Instant.fromEpochMilliseconds(after).toZonedDateTimeISO(zone);
  if (cadence === "monthly") {
    for (let n = 0; n < 3; n++) {
      const date = current.toPlainDate().with({ day: 1 }).add({ months: n });
      const day = Math.min(rule.day, date.daysInMonth);
      const candidate = Temporal.ZonedDateTime.from(
        {
          timeZone: zone,
          year: date.year,
          month: date.month,
          day,
          hour: rule.hour,
          minute: rule.minute,
        },
        { disambiguation: "compatible" },
      );
      if (candidate.epochMilliseconds > after)
        return candidate.epochMilliseconds;
    }
  } else {
    let date = current.toPlainDate();
    const offset = (rule.weekday - date.dayOfWeek + 7) % 7;
    date = date.add({ days: offset });
    let candidate = Temporal.ZonedDateTime.from(
      {
        timeZone: zone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour: rule.hour,
        minute: rule.minute,
      },
      { disambiguation: "compatible" },
    );
    if (candidate.epochMilliseconds <= after)
      candidate = candidate.add({ days: cadence === "fortnightly" ? 14 : 7 });
    return candidate.epochMilliseconds;
  }
  throw new Error("Cannot calculate next delivery");
}
export function advanceDelivery(
  previous: number,
  zone: string,
  cadence: "weekly" | "fortnightly" | "monthly",
  rule: Recurrence,
): number {
  if (cadence === "fortnightly")
    return Temporal.Instant.fromEpochMilliseconds(previous)
      .toZonedDateTimeISO(zone)
      .add({ days: 14 }).epochMilliseconds;
  return nextDelivery(previous, zone, cadence, rule);
}
