import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";
import { loadBackground, plain, response } from "./support/background-harness.js";

const root = path.resolve(import.meta.dirname, "../..");
const ZONE = "America/Los_Angeles";

function timesApi() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  runInContext(readFileSync(path.join(root, "shared/time-options.js"), "utf8"), createContext(sandbox));
  const api = sandbox.QuickCalTimes;
  return {
    options: (...args) => plain(api.options(...args)),
    applyPick: (...args) => plain(api.applyPick(...args)),
  };
}

describe("five-minute time options", () => {
  const times = timesApi();

  it("lists every five minutes in 12-hour labels and marks the current time", () => {
    const list = times.options("09:00", null);
    assert.equal(list.length, 288);
    assert.deepEqual(list.slice(108, 111).map((item) => item.label), ["9:00 AM", "9:05 AM", "9:10 AM"]);
    assert.equal(list.filter((item) => item.selected).length, 1);
    assert.equal(list.find((item) => item.selected).value, "09:00");
    assert.equal(list[0].label, "12:00 AM");
    assert.equal(list[287].label, "11:55 PM");
  });

  it("keeps an off-grid time exactly instead of rounding it", () => {
    const list = times.options("09:07", null);
    assert.equal(list.length, 289);
    const selected = list.find((item) => item.selected);
    assert.equal(selected.value, "09:07");
    assert.equal(selected.label, "9:07 AM");
    assert.deepEqual(list.slice(109, 112).map((item) => item.value), ["09:05", "09:07", "09:10"]);
  });

  it("offers only end times after the start on the same day", () => {
    const list = times.options("10:00", "09:30");
    assert.equal(list[0].value, "09:35");
    assert.ok(list.every((item) => item.value > "09:30"));
  });

  it("keeps the duration when the start moves and rejects an end before the start", () => {
    const schedule = { date: "2026-11-17", endDate: "2026-11-17", startTime: "09:00", endTime: "10:00" };
    assert.deepEqual(times.applyPick(schedule, "start", "09:15"), { ok: true, changed: true, startTime: "09:15", endTime: "10:15" });
    assert.deepEqual(times.applyPick(schedule, "end", "10:30"), { ok: true, changed: true, startTime: "09:00", endTime: "10:30" });
    assert.equal(times.applyPick(schedule, "end", "08:00").ok, false);
    assert.equal(times.applyPick(schedule, "start", "09:00").changed, false);
    const late = { date: "2026-11-17", endDate: "2026-11-17", startTime: "22:00", endTime: "23:30" };
    const moved = times.applyPick(late, "start", "23:00");
    assert.equal(moved.ok, true, "the old end still follows the new start");
    assert.equal(moved.endTime, "23:30");
    assert.equal(times.applyPick(late, "start", "23:45").ok, false);
  });
});

function calendarApi() {
  const events = new Map();
  const calls = { inserts: 0, patches: [] };
  const route = async (url, init) => {
    if (url.includes("/parse-event")) return undefined;
    if (!url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) return undefined;
    const id = decodeURIComponent(new URL(url).pathname.split("/events/")[1] || "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "POST") {
      calls.inserts += 1;
      const saved = Object.assign({}, body, { status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=" + body.id });
      events.set(body.id, saved);
      return response(200, saved);
    }
    if (init.method === "PATCH") {
      calls.patches.push({ id: id, body: body });
      if (calls.failPatch) return response(500, {});
      const saved = Object.assign({}, events.get(id), body, { id: id, status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=" + id });
      events.set(id, saved);
      return response(200, saved);
    }
    if (init.method === "GET" && id) {
      const found = events.get(id);
      return found ? response(200, found) : response(404, {});
    }
    return undefined;
  };
  return { route, events, calls };
}

function parsed(version, fields) {
  return Object.assign({
    quickcalApiVersion: version,
    quickcalRelease: "test",
    intent: "create",
    title: "Coffee with Alex",
    date: "2026-11-17",
    endDate: "2026-11-17",
    startTime: "09:00",
    endTime: "10:00",
    timeZone: ZONE,
    location: null,
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    needsClarification: false,
    clarificationQuestions: [],
    durationDefaulted: true,
  }, fields);
}

async function savedSession(api, parseFields) {
  let version = 0;
  const loaded = loadBackground({
    route: async (url, init) => {
      if (url.includes("/parse-event")) return response(200, parsed(version, parseFields));
      return api.route(url, init);
    },
  });
  version = loaded.sandbox.QuickCalLocalParse.API_VERSION;
  const shown = await loaded.ask({ type: "quickcal-widget", action: "show" });
  const submitted = await loaded.ask({
    type: "quickcal-widget",
    action: "submit",
    text: "Coffee with Alex tomorrow at 9 AM",
    sessionId: shown.session.sessionId,
    operationId: "op-1",
    timeZone: ZONE,
  });
  return { loaded, session: submitted.session };
}

describe("editing a saved event's time", () => {
  it("creates an ordinary event immediately with no confirmation step", async () => {
    const api = calendarApi();
    const { session } = await savedSession(api);
    assert.equal(session.mode, "saved");
    assert.equal(api.calls.inserts, 1);
    assert.equal(session.savedRecord.startTime, "09:00");
    assert.equal(session.doc == null || session.doc.open !== true, true);
  });

  it("patches the same Calendar event with the picked times and creates nothing new", async () => {
    const api = calendarApi();
    const { loaded, session } = await savedSession(api);
    const eventId = session.savedRecord.id;
    const changed = await loaded.ask({
      type: "quickcal-widget",
      action: "retime",
      sessionId: session.sessionId,
      operationId: "retime-1",
      eventId: eventId,
      startTime: "09:15",
      endTime: "10:15",
    });
    assert.equal(changed.ok, true);
    assert.equal(api.calls.inserts, 1, "no second event");
    assert.equal(api.calls.patches.length, 1);
    assert.equal(api.calls.patches[0].id, eventId);
    assert.equal(api.calls.patches[0].body.start.dateTime, "2026-11-17T09:15:00-08:00");
    assert.equal(api.calls.patches[0].body.end.dateTime, "2026-11-17T10:15:00-08:00");
    assert.equal(api.calls.patches[0].body.start.timeZone, ZONE);
    assert.equal(api.calls.patches[0].body.summary, "Coffee with Alex");
    assert.equal(changed.session.savedRecord.id, eventId);
    assert.equal(changed.session.savedRecord.startTime, "09:15");
    assert.equal(changed.session.savedRecord.timeText, "9:15–10:15 AM");
  });

  it("refuses to change a different event and keeps the old time when Google fails", async () => {
    const api = calendarApi();
    const { loaded, session } = await savedSession(api);
    const wrong = await loaded.ask({
      type: "quickcal-widget",
      action: "retime",
      sessionId: session.sessionId,
      eventId: "someoneelse",
      startTime: "11:00",
      endTime: "12:00",
    });
    assert.equal(wrong.ok, false);
    assert.equal(api.calls.patches.length, 0);

    api.calls.failPatch = true;
    const failed = await loaded.ask({
      type: "quickcal-widget",
      action: "retime",
      sessionId: session.sessionId,
      eventId: session.savedRecord.id,
      startTime: "11:00",
      endTime: "12:00",
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.session.statusError, true);
    assert.equal(failed.session.savedRecord.startTime, "09:00");
    assert.equal(api.calls.inserts, 1);
  });

  it("keeps a weekly series on the new time", async () => {
    const api = calendarApi();
    const { loaded, session } = await savedSession(api, {
      date: "2026-11-17",
      recurrence: { frequency: "weekly", weekdays: ["TU"], until: null, count: null },
      recurrenceText: "Weekly on Tuesday",
    });
    const changed = await loaded.ask({
      type: "quickcal-widget",
      action: "retime",
      sessionId: session.sessionId,
      eventId: session.savedRecord.id,
      startTime: "09:30",
      endTime: "10:30",
    });
    assert.equal(changed.ok, true);
    assert.equal(api.calls.patches[0].body.recurrence.length, 1);
    assert.match(api.calls.patches[0].body.recurrence[0], /^RRULE:FREQ=WEEKLY;.*BYDAY=TU/);
  });
});
