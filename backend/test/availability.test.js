import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";
import { validateExtraction } from "../src/validate.js";
import { nextWeekdayDate, referenceClock } from "../src/clock.js";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";

function loadAvailability() {
  const sandbox = { Intl: Intl, Date: Date, Math: Math, Number: Number, String: String, Object: Object, Array: Array };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context, { filename: "shared/schedule.js" });
  runInContext(readFileSync(path.join(root, "shared/conflicts.js"), "utf8"), context, { filename: "shared/conflicts.js" });
  runInContext(readFileSync(path.join(root, "shared/availability.js"), "utf8"), context, { filename: "shared/availability.js" });
  return sandbox.QuickCalAvailability;
}

function blankOperation(fields) {
  return Object.assign({
    target: null,
    searchDate: null,
    searchTime: null,
    destinationDate: null,
    destinationTime: null,
    destinationEndTime: null,
    scope: "occurrence",
    selection: [],
    durationMinutes: null,
    windowStart: null,
    windowEnd: null,
    preference: null,
    searchEndDate: null,
    readOnly: null,
  }, fields || {});
}

function ms(date, time) {
  const api = loadAvailability();
  // reload schedule via availability's dependency already loaded in prior call — use fresh
  const sandbox = { Intl: Intl, Date: Date };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context, { filename: "shared/schedule.js" });
  return sandbox.QuickCalSchedule.resolveLocal(date, time, zone).epoch;
}

describe("availability search math", () => {
  it("defaults to one-hour slots inside 9 AM–6 PM on Tuesday", () => {
    const api = loadAvailability();
    const tuesday = "2026-11-17";
    const nowMs = ms(tuesday, "08:00");
    const result = api.searchRange({
      searchDate: tuesday,
      timeZone: zone,
      nowMs: nowMs,
      busyIntervals: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.durationMinutes, 60);
    assert.equal(result.windowStart, "09:00");
    assert.equal(result.windowEnd, "18:00");
    assert.equal(result.slots.length, 3);
    assert.equal(result.slots[0].startTime, "09:00");
    assert.equal(result.slots[0].endTime, "10:00");
    assert.ok(result.slots[1].startMs - result.slots[0].startMs >= 60 * 60000);
    assert.match(api.summarizeDefaults(result), /1-hour default/);
  });

  it("honors a 30-minute evening window", () => {
    const api = loadAvailability();
    const day = "2026-11-17";
    const result = api.searchRange({
      searchDate: day,
      durationMinutes: 30,
      preference: "evening",
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.durationMinutes, 30);
    assert.equal(result.windowStart, "17:00");
    assert.equal(result.windowEnd, "21:00");
    assert.equal(result.preferenceLabel, "evening");
    assert.equal(result.slots[0].startTime, "17:00");
    assert.equal(result.slots[0].endTime, "17:30");
    assert.match(api.summarizeDefaults(result), /evening 17:00/);
  });

  it("keeps today when the named window still has future slots and rolls forward after it ends", () => {
    const api = loadAvailability();
    const wednesday = "2026-11-18";
    assert.equal(nextWeekdayDate(referenceClock(new Date("2026-11-18T20:00:00.000Z"), zone), "Wednesday"), wednesday);
    const before = api.searchRange({
      searchDate: wednesday,
      durationMinutes: 30,
      preference: "evening",
      timeZone: zone,
      nowMs: ms(wednesday, "18:00"),
      busyIntervals: [],
    });
    assert.equal(before.searchDate, wednesday);
    assert.equal(before.slots[0].startTime, "18:00");
    const after = api.searchRange({
      searchDate: wednesday,
      durationMinutes: 30,
      preference: "evening",
      timeZone: zone,
      nowMs: ms(wednesday, "21:00"),
      busyIntervals: [],
    });
    assert.equal(after.searchDate, "2026-11-25");
    assert.equal(after.rolledFromPastWindow, true);
    assert.equal(after.slots[0].startTime, "17:00");
  });

  it("resolves Friday afternoon and tomorrow defaults without inventing a title requirement", () => {
    const api = loadAvailability();
    const friday = "2026-11-20";
    const afternoon = api.searchRange({
      searchDate: friday,
      durationMinutes: 60,
      preference: "afternoon",
      timeZone: zone,
      nowMs: ms(friday, "08:00"),
      busyIntervals: [],
    });
    assert.equal(afternoon.windowStart, "12:00");
    assert.equal(afternoon.windowEnd, "17:00");
    assert.match(api.summarizeDefaults(afternoon), /afternoon/);
    const tomorrow = api.searchRange({
      searchDate: "2026-11-17",
      durationMinutes: 60,
      timeZone: zone,
      nowMs: ms("2026-11-16", "10:00"),
      busyIntervals: [],
    });
    assert.equal(tomorrow.durationMinutes, 60);
    assert.equal(tomorrow.windowStart, "09:00");
    assert.equal(tomorrow.slots[0].startTime, "09:00");
    const untitled = validateExtraction({
      title: null,
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      needsClarification: false,
      clarificationQuestions: [],
      intent: "availability",
      operation: blankOperation({
        searchDate: friday,
        durationMinutes: 30,
        preference: "evening",
        readOnly: true,
      }),
    }, zone);
    assert.equal(untitled.ok, true);
    assert.equal(untitled.event.needsClarification, false);
    assert.equal(untitled.event.title, null);
  });

  it("merges overlapping busy intervals and keeps adjacent events free", () => {
    const api = loadAvailability();
    const day = "2026-11-17";
    const busy = api.mergeBusy([
      { startMs: ms(day, "09:00"), endMs: ms(day, "10:30") },
      { startMs: ms(day, "10:00"), endMs: ms(day, "11:00") },
      { startMs: ms(day, "13:00"), endMs: ms(day, "14:00") },
    ]);
    assert.equal(busy.length, 2);
    assert.equal(busy[0].endMs, ms(day, "11:00"));
    const result = api.searchRange({
      searchDate: day,
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [
        { startMs: ms(day, "09:00"), endMs: ms(day, "10:00") },
        { startMs: ms(day, "10:00"), endMs: ms(day, "11:00") },
      ],
    });
    assert.equal(result.slots[0].startTime, "11:00");
  });

  it("treats all-day busy coverage as blocking the day window", () => {
    const api = loadAvailability();
    const day = "2026-11-17";
    const result = api.searchRange({
      searchDate: day,
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [{ startMs: ms(day, "00:00"), endMs: ms(api.addDays(day, 1), "00:00") }],
    });
    assert.equal(result.slots.length, 0);
  });

  it("explains when no slot fits and bounds broad ranges", () => {
    const api = loadAvailability();
    const day = "2026-11-17";
    const packed = api.searchRange({
      searchDate: day,
      durationMinutes: 60,
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [{ startMs: ms(day, "09:00"), endMs: ms(day, "18:00") }],
    });
    assert.equal(packed.ok, true);
    assert.equal(packed.slots.length, 0);
    const broad = api.searchRange({
      searchDate: day,
      searchEndDate: api.addDays(day, 20),
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [],
    });
    assert.equal(broad.ok, false);
    assert.match(broad.error, /14 days/);
  });

  it("keeps open slots across a spring-forward DST morning", () => {
    const api = loadAvailability();
    // 2026-03-08 is the Pacific spring-forward Sunday.
    const day = "2026-03-08";
    const result = api.searchRange({
      searchDate: day,
      durationMinutes: 60,
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [{ startMs: ms(day, "09:00"), endMs: ms(day, "10:00") }],
    });
    assert.equal(result.ok, true);
    assert.ok(result.slots.length >= 1);
    assert.equal(result.slots[0].startTime, "10:00");
    assert.equal(result.slots[0].endTime, "11:00");
  });

  it("supports later refinements without losing duration", () => {
    const api = loadAvailability();
    const day = "2026-11-17";
    const first = api.searchRange({
      searchDate: day,
      durationMinutes: 30,
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [],
    });
    const later = api.searchRange({
      searchDate: day,
      durationMinutes: 30,
      timeZone: zone,
      nowMs: ms(day, "08:00"),
      busyIntervals: [],
      afterStartMs: first.slots[first.slots.length - 1].startMs,
    });
    assert.equal(later.durationMinutes, 30);
    assert.ok(later.slots[0].startMs > first.slots[first.slots.length - 1].startMs);
  });

  it("validates availability intent without inventing a create schedule", () => {
    const result = validateExtraction({
      title: "Meeting with Steve",
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      needsClarification: false,
      clarificationQuestions: [],
      intent: "availability",
      operation: blankOperation({
        target: "Steve",
        searchDate: "2026-11-17",
        durationMinutes: 60,
        readOnly: false,
      }),
    }, zone);
    assert.equal(result.ok, true);
    assert.equal(result.event.intent, "availability");
    assert.equal(result.event.date, null);
    assert.equal(result.event.startTime, null);
    assert.equal(result.event.operation.searchDate, "2026-11-17");
  });

  it("asks for a day when availability has no searchDate", () => {
    const result = validateExtraction({
      title: "Meeting with Steve",
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      needsClarification: false,
      clarificationQuestions: [],
      intent: "availability",
      operation: blankOperation({ target: "Steve", readOnly: false }),
    }, zone);
    assert.equal(result.ok, true);
    assert.equal(result.event.needsClarification, true);
    assert.match(result.event.clarificationQuestions[0], /day/i);
  });
});
