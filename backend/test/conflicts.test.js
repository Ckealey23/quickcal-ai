import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";

function loadConflicts() {
  const sandbox = { Intl, Date, Math, Number, String, Array, Object, JSON };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context, {
    filename: "shared/schedule.js",
  });
  runInContext(readFileSync(path.join(root, "shared/conflicts.js"), "utf8"), context, {
    filename: "shared/conflicts.js",
  });
  return sandbox.QuickCalConflicts;
}

function saved(overrides) {
  return Object.assign({
    id: "saved-1",
    calendarId: "primary",
    summary: "Coffee with Alex",
    date: "2026-11-17",
    endDate: "2026-11-17",
    startTime: "14:00",
    endTime: "15:00",
    timeZone: zone,
    startDateTime: "2026-11-17T14:00:00-08:00",
    endDateTime: "2026-11-17T15:00:00-08:00",
    htmlLink: "https://calendar.google.com/calendar/event?eid=saved",
  }, overrides || {});
}

function timed(summary, start, end, extra) {
  return Object.assign({
    id: summary.replace(/\W+/g, "-").toLowerCase(),
    summary: summary,
    status: "confirmed",
    transparency: "opaque",
    start: { dateTime: start, timeZone: zone },
    end: { dateTime: end, timeZone: zone },
  }, extra || {});
}

describe("conflict interval helpers", () => {
  it("treats adjacent events as non-overlapping and excludes the saved event", () => {
    const api = loadConflicts();
    assert.equal(api.intervalsOverlap(0, 60, 60, 120), false);
    assert.equal(api.intervalsOverlap(0, 60, 59, 120), true);
    assert.equal(api.RECURRING_HORIZON_DAYS, 90);

    const mine = saved();
    const window = api.checkWindow(mine);
    assert.equal(window.recurring, false);
    assert.match(window.timeMin, /2026-11-17T22:00:00.000Z/);
    assert.match(window.timeMax, /2026-11-17T23:00:00.000Z/);

    const other = timed("Team meeting", "2026-11-17T14:30:00-08:00", "2026-11-17T15:30:00-08:00");
    const adjacent = timed("Next", "2026-11-17T15:00:00-08:00", "2026-11-17T16:00:00-08:00");
    const self = timed("Coffee with Alex", "2026-11-17T14:00:00-08:00", "2026-11-17T15:00:00-08:00", {
      id: "saved-1",
    });
    assert.equal(api.isSavedEvent(self, mine, "primary"), true);
    assert.equal(api.isBusyCandidate(self), true);
    assert.equal(api.isBusyCandidate(Object.assign({}, other, { transparency: "transparent" })), false);
    assert.equal(api.isBusyCandidate(Object.assign({}, other, { status: "cancelled" })), false);
    assert.equal(
      api.isDeclined({
        attendees: [{ self: true, responseStatus: "declined" }],
      }),
      true
    );

    const primary = { id: "primary", summary: "Primary", primary: true };
    const entries = [
      api.entryFromEvent(other, primary),
      api.entryFromEvent(adjacent, primary),
    ].filter(Boolean);
    const collected = api.collectConflicts({
      saved: mine,
      timeZone: zone,
      ourIntervals: [api.intervalFromSaved(mine)],
      entries: entries,
      calendarCount: 1,
    });
    assert.equal(collected.conflicts.length, 1);
    assert.match(collected.lines[0], /Overlaps with 'Team meeting', Tuesday, 2:30–3:30 PM\./);
  });

  it("keeps calendar names for other calendars and labels busy-only blocks", () => {
    const api = loadConflicts();
    const mine = saved();
    const shared = { id: "shared@example.com", summary: "Team calendar" };
    const entry = api.entryFromEvent(
      timed("Standup", "2026-11-17T14:15:00-08:00", "2026-11-17T14:45:00-08:00"),
      shared
    );
    const busy = api.entryFromBusy(
      { start: "2026-11-17T14:10:00-08:00", end: "2026-11-17T14:40:00-08:00" },
      shared
    );
    const collected = api.collectConflicts({
      saved: mine,
      timeZone: zone,
      ourIntervals: [api.intervalFromSaved(mine)],
      entries: [entry, busy],
      calendarCount: 2,
    });
    assert.equal(collected.conflicts.length, 2);
    assert.match(collected.lines[0], /Team calendar/);
    assert.match(collected.lines.join("\n"), /Busy event/);
  });

  it("handles all-day events and DST-safe recurring horizons", () => {
    const api = loadConflicts();
    const allDay = api.intervalFromGoogleTimes(
      { date: "2026-11-17" },
      { date: "2026-11-18" }
    );
    assert.equal(allDay.allDay, true);
    assert.equal(api.intervalsOverlap(allDay.startMs, allDay.endMs, Date.parse("2026-11-17T20:00:00Z"), Date.parse("2026-11-17T21:00:00Z")), true);

    const series = saved({
      recurrence: { frequency: "weekly", weekdays: ["TU"], until: null, count: null },
      recurrenceText: "Every Tuesday",
      startDateTime: "2026-03-08T14:00:00-08:00",
      endDateTime: "2026-03-08T15:00:00-08:00",
      date: "2026-03-08",
      endDate: "2026-03-08",
    });
    const window = api.checkWindow(series);
    assert.equal(window.recurring, true);
    assert.equal(window.horizonDate, "2026-06-06");
    assert.match(window.horizonText, /Checked through Jun 6, 2026/);
  });

  it("builds incomplete and needsScopes notices without implying save failure", () => {
    const api = loadConflicts();
    const mine = saved();
    const incomplete = api.buildNotice({
      checkId: "c1",
      saved: mine,
      incompleteReasons: ["Google does not allow conflict checks on Holidays."],
    });
    assert.equal(incomplete.status, "incomplete");
    assert.match(incomplete.statusText, /Event saved/);
    assert.equal(/could not save/i.test(incomplete.statusText), false);

    const scopes = api.buildNotice({ checkId: "c2", saved: mine, needsScopes: true });
    assert.equal(scopes.status, "needsScopes");
    assert.equal(scopes.needsScopes, true);
    assert.match(scopes.statusText, /Reconnect/);

    const session = {
      visible: true,
      mode: "saved",
      savedRecord: mine,
      conflictNotice: api.checkingNotice("c3", mine),
    };
    assert.equal(api.noticeStillCurrent(session, api.checkingNotice("c3", mine)), true);
    assert.equal(
      api.noticeStillCurrent(
        Object.assign({}, session, { mode: "input", savedRecord: null }),
        api.checkingNotice("c3", mine)
      ),
      false
    );
    assert.equal(
      api.noticeStillCurrent(
        Object.assign({}, session, { conflictNotice: api.checkingNotice("other", mine) }),
        api.clearNotice("c3", mine)
      ),
      false
    );
  });
});
