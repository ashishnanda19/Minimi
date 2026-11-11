import { describe, expect, it } from "vitest";
import {
  buildCalendar, civilOf, daysAgo, formatStamp, isValidTimezone, isoDate, nowContext, relativeLabel,
} from "../src/agent/temporal.js";

// Tue 10 Nov 2026, 13:15 UTC = 18:45 IST
const NOW = new Date("2026-11-10T13:15:00Z");

describe("calendar", () => {
  it("labels today, yesterday and 'last <weekday>' (Tuesday -> 7 days ago)", () => {
    const cal = buildCalendar(NOW, "Asia/Kolkata");
    expect(cal).toContain("Tue 10 Nov 2026 (2026-11-10): today");
    expect(cal).toContain("Mon 9 Nov 2026 (2026-11-09): yesterday, last Monday");
    expect(cal).toContain("Tue 3 Nov 2026 (2026-11-03): 7 days ago, last Tuesday");
    expect(cal).toContain("Fri 6 Nov 2026 (2026-11-06): 4 days ago, last Friday");
  });

  it("on a Monday, 'last Monday' is 7 days ago, not today", () => {
    const monday = new Date("2026-11-09T09:00:00Z");
    const cal = buildCalendar(monday, "UTC");
    expect(cal).toContain("Mon 9 Nov 2026 (2026-11-09): today");
    expect(cal).toContain("Mon 2 Nov 2026 (2026-11-02): 7 days ago, last Monday");
  });

  it("crosses month and year boundaries", () => {
    const cal = buildCalendar(new Date("2027-01-02T12:00:00Z"), "UTC");
    expect(cal).toContain("Thu 31 Dec 2026 (2026-12-31): 2 days ago, last Thursday");
    expect(cal).toContain("Mon 4 Jan 2027 (2027-01-04): in 2 days, next Monday");
  });

  it("handles leap day", () => {
    const cal = buildCalendar(new Date("2028-03-01T12:00:00Z"), "UTC");
    expect(cal).toContain("Tue 29 Feb 2028 (2028-02-29): yesterday, last Tuesday");
  });

  it("is chronological, oldest first, and includes upcoming days", () => {
    const lines = buildCalendar(NOW, "UTC").split("\n");
    expect(lines[0]).toContain("2026-10-27"); // 14 days back, per the plan
    expect(lines.at(-1)).toContain("2026-11-17");
    expect(lines.at(-1)).toContain("next Tuesday");
  });
});

describe("timezones", () => {
  it("00:30 IST on the 10th is still the 9th in UTC", () => {
    const t = new Date("2026-11-09T19:00:00Z");
    expect(isoDate(civilOf(t, "Asia/Kolkata"))).toBe("2026-11-10");
    expect(isoDate(civilOf(t, "UTC"))).toBe("2026-11-09");
    expect(formatStamp(t, "Asia/Kolkata")).toBe("Tue 10 Nov 2026, 00:30");
  });

  it("daysAgo counts calendar days in the user's zone, not 24h blocks", () => {
    const sentLate = new Date("2026-11-09T18:40:00Z"); // 00:10 IST on the 10th
    expect(daysAgo(sentLate, NOW, "Asia/Kolkata")).toBe(0);
    expect(daysAgo(sentLate, NOW, "UTC")).toBe(1);
  });

  it("is DST-safe across a clock change", () => {
    // US clocks go back on 1 Nov 2026
    const before = new Date("2026-10-31T20:00:00Z");
    const now = new Date("2026-11-03T20:00:00Z");
    expect(daysAgo(before, now, "America/New_York")).toBe(3);
  });

  it("validates timezone names", () => {
    expect(isValidTimezone("Europe/London")).toBe(true);
    expect(isValidTimezone("Not/AZone")).toBe(false);
  });
});

describe("labels", () => {
  it("formats relative days", () => {
    expect(relativeLabel(0)).toBe("today");
    expect(relativeLabel(1)).toBe("yesterday");
    expect(relativeLabel(9)).toBe("9 days ago");
    expect(relativeLabel(-1)).toBe("tomorrow");
    expect(relativeLabel(-3)).toBe("in 3 days");
  });

  it("nowContext states zone and ISO date", () => {
    expect(nowContext(NOW, "Asia/Kolkata")).toBe(
      "Now: Tue 10 Nov 2026, 18:45 (Asia/Kolkata, GMT+5:30). ISO date today: 2026-11-10.",
    );
  });
});

import { resolveDateRefs } from "../src/agent/temporal.js";
const refs = (text: string, now = NOW, tz = "Asia/Kolkata") => resolveDateRefs(text, now, tz).map((r) => `${r.phrase} -> ${isoDate(r.date)}`);

describe("resolveDateRefs (today = Tue 10 Nov 2026)", () => {
  it("resolves the brief's phrases", () => {
    expect(refs("Last Tuesday I asked about Postgres")).toEqual(["Last Tuesday -> 2026-11-03"]);
    expect(refs("On Monday we shortlisted 5 CRMs")).toEqual(["On Monday -> 2026-11-09"]);
    expect(refs("What did I ask you on 3 November?")).toEqual(["3 November -> 2026-11-03"]);
    expect(refs("and yesterday, and 5 days ago")).toEqual(["yesterday -> 2026-11-09", "5 days ago -> 2026-11-05"]);
  });
  it("reads month-first and ordinal forms, and ISO", () => {
    expect(refs("Nov 3rd")).toEqual(["Nov 3rd -> 2026-11-03"]);
    expect(refs("the 20th of October")).toEqual(["20th of October -> 2026-10-20"]);
    expect(refs("on 2026-10-20")).toEqual(["2026-10-20 -> 2026-10-20"]);
  });
  it("a day-month with no year is the most recent occurrence not in the future", () => {
    expect(refs("25 December")).toEqual(["25 December -> 2025-12-25"]);
    expect(refs("10 November")).toEqual(["10 November -> 2026-11-10"]); // today counts
    expect(refs("29 Feb", new Date("2028-03-05T00:00:00Z"), "UTC")).toEqual(["29 Feb -> 2028-02-29"]);
    expect(refs("29 Feb")).toEqual(["29 Feb -> 2024-02-29"]); // falls back to the last leap year
  });
  it("a bare weekday that equals today means a week ago, like 'last <weekday>'", () => {
    expect(refs("last Tuesday")).toEqual(["last Tuesday -> 2026-11-03"]);
    expect(refs("Tuesday")).toEqual(["Tuesday -> 2026-11-03"]);
  });
  it("does not double-count 'last Monday' as both phrases, and ignores impossible dates", () => {
    expect(refs("last Monday")).toHaveLength(1);
    expect(refs("30 February")).toEqual([]);
    expect(refs("no dates in here, just 'may' as a verb? I may go")).toEqual([]);
  });
  it("uses the user's timezone for 'yesterday'", () => {
    const t = new Date("2026-11-09T19:30:00Z"); // 01:00 on 10 Nov in IST, still 9 Nov in UTC
    expect(refs("yesterday", t, "Asia/Kolkata")).toEqual(["yesterday -> 2026-11-09"]);
    expect(refs("yesterday", t, "UTC")).toEqual(["yesterday -> 2026-11-08"]);
  });
});

import { refBounds, zonedMidnight } from "../src/agent/temporal.js";
const span = (text: string, now = NOW, tz = "Asia/Kolkata") => resolveDateRefs(text, now, tz).map((r) => `${isoDate(r.date)}${r.end ? ".." + isoDate(r.end) : ""}${r.part ? " " + r.part : ""}`);

describe("resolveDateRefs: spans (today = Tue 10 Nov 2026)", () => {
  it("resolves calendar weeks and months", () => {
    expect(span("what did I ask last week?")).toEqual(["2026-11-02..2026-11-08"]);        // Mon-Sun before this week
    expect(span("anything this week")).toEqual(["2026-11-09..2026-11-10"]);               // Monday to today
    expect(span("last month")).toEqual(["2026-10-01..2026-10-31"]);
    expect(span("this month")).toEqual(["2026-11-01..2026-11-10"]);
    expect(span("last weekend")).toEqual(["2026-11-07..2026-11-08"]);
  });
  it("resolves 'N weeks/months ago' to the whole week or month", () => {
    expect(span("2 weeks ago")).toEqual(["2026-10-26..2026-11-01"]);
    expect(span("a week ago")).toEqual(["2026-11-02..2026-11-08"]);
    expect(span("3 months ago")).toEqual(["2026-08-01..2026-08-31"]);
  });
  it("resolves 'in <month>' to the most recent such month, up to today for the current one", () => {
    expect(span("what did we discuss in October?")).toEqual(["2026-10-01..2026-10-31"]);
    expect(span("in November")).toEqual(["2026-11-01..2026-11-10"]);
    expect(span("in December")).toEqual(["2025-12-01..2025-12-31"]);                       // not in the future yet: last year's
    expect(span("in March 2025")).toEqual(["2025-03-01..2025-03-31"]);
  });
  it("does not read 'October 3' as the month of October", () => {
    expect(span("on October 3")).toEqual(["2026-10-03"]);
  });
  it("understands parts of today", () => {
    expect(span("earlier today")).toEqual(["2026-11-10"]);
    expect(span("this morning")).toEqual(["2026-11-10 morning"]);
    expect(span("tonight")).toEqual(["2026-11-10 evening"]);
  });
  it("handles a week that crosses a year boundary", () => {
    expect(span("last week", new Date("2027-01-05T12:00:00Z"), "UTC")).toEqual(["2026-12-28..2027-01-03"]);
  });
});

describe("refBounds: exact instants in the user's timezone", () => {
  it("a day in IST starts at 18:30 UTC the evening before", () => {
    const [ref] = resolveDateRefs("3 November", NOW, "Asia/Kolkata");
    const { from, to } = refBounds(ref!, "Asia/Kolkata");
    expect(from.toISOString()).toBe("2026-11-02T18:30:00.000Z");
    expect(to.toISOString()).toBe("2026-11-03T18:30:00.000Z");
  });
  it("a span covers every day in it", () => {
    const [ref] = resolveDateRefs("last week", NOW, "UTC");
    const { from, to } = refBounds(ref!, "UTC");
    expect(from.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-11-09T00:00:00.000Z");
  });
  it("this morning ends at noon local time", () => {
    const [ref] = resolveDateRefs("this morning", NOW, "Asia/Kolkata");
    const { from, to } = refBounds(ref!, "Asia/Kolkata");
    expect(to.getTime() - from.getTime()).toBe(12 * 3_600_000);
  });
  it("midnight is correct across a daylight-saving change", () => {
    // Clocks go back in New York on 1 Nov 2026: that day is 25 hours long.
    const start = zonedMidnight({ y: 2026, m: 11, d: 1 }, "America/New_York");
    const next = zonedMidnight({ y: 2026, m: 11, d: 2 }, "America/New_York");
    expect(start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(next.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect((next.getTime() - start.getTime()) / 3_600_000).toBe(25);
  });
});
