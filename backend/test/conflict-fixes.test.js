import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";
import { loadBackground, response } from "./support/background-harness.js";

const root = path.resolve(import.meta.dirname, "../..");
const ZONE = "America/Los_Angeles";
const ME = "me@example.com";

// Google lists the primary calendar under the account email, never "primary".
const CALENDARS = [{ id: ME, summary: ME, primary: true, accessRole: "owner" }];

function conflictsApi() {
  const sandbox = { Intl, Date, Math, JSON, String, Number };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context);
  runInContext(readFileSync(path.join(root, "shared/conflicts.js"), "utf8"), context);
  return sandbox.QuickCalConflicts;
}

// A calendar that stores inserted events and lists them, plus any extra
// events, from the conflict check's events query.
function calendar(extra) {
  const events = new Map();
  const route = async (url, init) => {
    const href = new URL(url);
    if (href.pathname.endsWith("/calendars/" + encodeURIComponent(ME) + "/events") || href.pathname.endsWith("/calendars/" + ME + "/events")) {
      const listed = Array.from(events.values()).map((event) => ({
        id: event.id,
        summary: event.summary,
        status: "confirmed",
        start: event.start,
        end: event.end,
      }));
      return response(200, { items: listed.concat(extra || []) });
    }
    if (!url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) return undefined;
    const id = decodeURIComponent(href.pathname.split("/events/")[1] || "");
    const body = init.body ? JSON.parse(init.body) : null;
    if (init.method === "POST") {
      const saved = Object.assign({}, body, { status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=" + body.id });
      events.set(body.id, saved);
      return response(200, saved);
    }
    if (init.method === "PATCH") {
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
  return { route, events };
}

function parsed(version) {
  return {
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
  };
}

async function createCoffee(extra) {
  const cal = calendar(extra);
  const timers = [];
  let version = 0;
  const loaded = loadBackground({
    calendars: CALENDARS,
    setTimeout(callback, ms) {
      if (ms === 5000) {
        timers.push(callback);
        return 0;
      }
      return setTimeout(callback, ms);
    },
    route: async (url, init) => {
      if (url.includes("/parse-event")) return response(200, parsed(version));
      return cal.route(url, init);
    },
  });
  version = loaded.sandbox.QuickCalLocalParse.API_VERSION;
  const shown = await loaded.ask({ type: "quickcal-widget", action: "show" });
  const created = await loaded.ask({
    type: "quickcal-widget",
    action: "submit",
    text: "Coffee with Alex tomorrow at 9 AM",
    sessionId: shown.session.sessionId,
    operationId: "op-1",
    timeZone: ZONE,
  });
  return { loaded, cal, timers, session: created.session };
}

const OTHER = {
  id: "standup1",
  summary: "Team standup",
  status: "confirmed",
  start: { dateTime: "2026-11-17T09:00:00-08:00" },
  end: { dateTime: "2026-11-17T10:00:00-08:00" },
};

describe("self-conflicts", () => {
  it("recognizes the saved event on the primary calendar listed by email", () => {
    const api = conflictsApi();
    const saved = { id: "abc123", calendarId: "primary" };
    assert.equal(api.isSavedEvent({ id: "abc123" }, saved, ME, true), true);
    assert.equal(api.isSavedEvent({ id: "abc123" }, saved, "work@example.com", false), false);
    assert.equal(api.isSavedEvent({ id: "other" }, saved, ME, true), false);
    assert.equal(api.isSavedEvent({ id: "abc123_20261124T170000Z", recurringEventId: "abc123" }, saved, ME, true), true);
  });

  it("does not warn when a new event has nothing else at its time", async () => {
    const { session, cal } = await createCoffee();
    assert.equal(cal.events.size, 1);
    assert.equal(session.mode, "saved", "the event was created automatically");
    assert.equal(session.conflictNotice.status, "clear");
    assert.equal(session.statusText, "");
  });

  it("still warns about a real overlap, and never counts the new event", async () => {
    const { session } = await createCoffee([OTHER]);
    assert.equal(session.conflictNotice.status, "conflicts");
    assert.equal(session.conflictNotice.lines.length, 1);
    assert.match(session.conflictNotice.lines[0], /Team standup/);
    assert.doesNotMatch(session.conflictNotice.lines.join(" "), /Coffee with Alex/);
  });

  it("does not report an edited event as overlapping itself", async () => {
    const { loaded, session } = await createCoffee();
    const moved = await loaded.ask({
      type: "quickcal-widget",
      action: "retime",
      sessionId: session.sessionId,
      operationId: "retime-1",
      eventId: session.savedRecord.id,
      startTime: "09:30",
      endTime: "10:30",
    });
    assert.equal(moved.ok, true);
    assert.equal(moved.session.conflictNotice.status, "clear");
    assert.equal(moved.session.statusText, "");
  });
});

describe("overlap notice lifetime", () => {
  it("clears the overlap warning after 5 seconds", async () => {
    const { loaded, session, timers } = await createCoffee([OTHER]);
    assert.match(session.statusText, /Team standup/);
    assert.equal(timers.length, 1);
    timers[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await loaded.ask({ type: "quickcal-widget", action: "snapshot" });
    assert.equal(after.session.conflictNotice, null);
    assert.equal(after.session.statusText, "");
    assert.equal(after.session.mode, "saved", "the saved event card stays");
  });

  it("schedules no timer when there is nothing to warn about", async () => {
    const { timers } = await createCoffee();
    assert.equal(timers.length, 0);
  });

  it("clears the top-level overlap warning after a highlighted batch is saved", async () => {
    const cal = calendar([OTHER]);
    const timers = [];
    let version = 0;
    const batchEvent = (ref, title, start, end) => ({
      ref: ref, title: title, date: "2026-11-17", endDate: "2026-11-17", startTime: start, endTime: end,
      timeZone: ZONE, location: null, recurrence: null, reminders: { useDefault: false, overrides: [] },
      remindersText: "", recurrenceText: "", seriesEndText: "", needsClarification: false,
      clarificationQuestions: [], durationDefaulted: false, intent: "create",
    });
    const loaded = loadBackground({
      calendars: CALENDARS,
      setTimeout(callback, ms) {
        if (ms === 5000) {
          timers.push(callback);
          return 0;
        }
        return setTimeout(callback, ms);
      },
      route: async (url, init) => {
        if (url.includes("/parse-event")) {
          return response(200, {
            kind: "batch", tooMany: false, message: null, quickcalApiVersion: version, quickcalRelease: "test",
            events: [batchEvent("e1", "Alpha", "09:00", "10:00"), batchEvent("e2", "Beta", "13:00", "14:00")],
          });
        }
        return cal.route(url, init);
      },
    });
    version = loaded.sandbox.QuickCalLocalParse.API_VERSION;
    const shown = await loaded.ask({ type: "quickcal-widget", action: "show" });
    const reviewed = await loaded.ask({
      type: "quickcal-widget", action: "submit", text: "Alpha at 9 and Beta at 1 tomorrow", fresh: true, batch: true,
      timeZone: ZONE, operationId: "batch-1", sessionId: shown.session.sessionId,
    });
    const saved = await loaded.ask({
      type: "quickcal-widget", action: "batch-confirm", sessionId: reviewed.session.sessionId, operationId: "batch-2",
    });
    assert.equal(saved.ok, true);
    assert.equal(cal.events.size, 2);
    let warned = null;
    for (let attempt = 0; attempt < 50 && !warned; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const current = await loaded.ask({ type: "quickcal-widget", action: "snapshot" });
      if (/Team standup/.test(current.session.statusText)) warned = current.session;
    }
    assert.ok(warned, "the batch conflict check reports the real overlap");
    assert.ok(timers.length >= 1);
    timers.forEach((fire) => fire());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await loaded.ask({ type: "quickcal-widget", action: "snapshot" });
    assert.equal(after.session.conflictNotice, null);
    assert.equal(after.session.statusText, "");
    assert.ok(after.session.batch, "the batch results stay listed");
  });

  it("does not let an old timer clear a newer request's state", async () => {
    const { loaded, session, timers } = await createCoffee([OTHER]);
    await loaded.ask({ type: "quickcal-widget", action: "reset", sessionId: session.sessionId });
    timers[0]();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await loaded.ask({ type: "quickcal-widget", action: "snapshot" });
    assert.equal(after.session.mode, "input");
    assert.equal(after.session.conflictNotice, null);
  });
});
