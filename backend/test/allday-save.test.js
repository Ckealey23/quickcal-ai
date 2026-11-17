import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadBackground(hooks) {
  const store = hooks.store || {};
  const calendar = hooks.calendar || (hooks.calendar = new Map());
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "epnmambadhgonpaplpfgajhdpbkaiikb",
        getURL(file) {
          return "chrome-extension://epnmambadhgonpaplpfgajhdpbkaiikb/" + file;
        },
        onMessage: {
          addListener(listener) {
            listeners.message = listener;
          },
        },
        onInstalled: { addListener() {} },
        async openOptionsPage() {},
      },
      scripting: { executeScript() { return Promise.resolve(); } },
      storage: {
        local: {
          async get(key) {
            return { [key]: store[key] };
          },
          async set(value) {
            Object.assign(store, value);
          },
          async remove(key) {
            delete store[key];
          },
        },
      },
      identity: {
        async getAuthToken() {
          return "test-token";
        },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: async (url, options) => {
      if (String(url).includes("/users/me/calendarList")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { items: [{ id: "primary", summary: "Primary", primary: true, accessRole: "owner" }] };
          },
        };
      }
      if (String(url).includes("singleEvents=true") && String(url).includes("transparency")) {
        if (hooks.conflictFail) {
          return { ok: false, status: 500, async json() { return { error: { message: "boom" } }; } };
        }
        return { ok: true, status: 200, async json() { return { items: hooks.busyItems || [] }; } };
      }
      if (String(url).includes("maxResults=1")) {
        return { ok: true, status: 200, async json() { return { kind: "calendar#events" }; } };
      }
      if (String(url).includes("/events/") && (options || {}).method === "GET") {
        const id = decodeURIComponent(new URL(url).pathname.split("/events/")[1]);
        const body = calendar.get(id);
        return { ok: !!body, status: body ? 200 : 404, async json() { return body || {}; } };
      }
      if ((options || {}).method === "POST") {
        hooks.posts += 1;
        const body = JSON.parse(options.body);
        hooks.ids.push(body.id);
        hooks.bodies.push(body);
        if (hooks.failPost) {
          return { ok: false, status: 403, async json() { return {}; } };
        }
        if (hooks.uncertainPost) {
          return { ok: false, status: 503, async json() { return {}; } };
        }
        if (hooks.mismatchSchedule) {
          const bad = {
            id: body.id,
            summary: body.summary,
            htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
            status: "confirmed",
            reminders: body.reminders,
            start: { date: "2099-01-01" },
            end: { date: "2099-01-02" },
          };
          calendar.set(body.id, bad);
          return { ok: true, status: 200, async json() { return bad; } };
        }
        if (hooks.mismatchSummary) {
          return {
            ok: true,
            status: 200,
            async json() {
              return {
                id: body.id,
                summary: "Different",
                htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
                status: "confirmed",
                reminders: body.reminders,
                start: body.start,
                end: body.end,
              };
            },
          };
        }
        // Realistic Google Calendar all-day / timed insert echo.
        const reminders = hooks.materializeDefaults
          ? { useDefault: false, overrides: [{ method: "popup", minutes: 10 }] }
          : (body.reminders || { useDefault: true });
        const saved = {
          kind: "calendar#event",
          etag: "\"etag\"",
          id: body.id,
          status: "confirmed",
          htmlLink: "https://www.google.com/calendar/event?eid=YWJjMTIz",
          created: "2026-11-16T20:00:00.000Z",
          updated: "2026-11-16T20:00:00.000Z",
          summary: body.summary,
          description: body.description,
          creator: { email: "user@example.com", self: true },
          organizer: { email: "user@example.com", self: true },
          start: body.start,
          end: body.end,
          iCalUID: body.id + "@google.com",
          sequence: 0,
          reminders: reminders,
          eventType: "default",
        };
        if (body.location) saved.location = body.location;
        calendar.set(body.id, saved);
        return { ok: true, status: 200, async json() { return saved; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
    console,
    URL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Promise,
    crypto,
    AbortSignal,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => {
      runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
    });
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return { listener: listeners.message, store, calendar, hooks };
}

function sender() {
  return {
    id: "epnmambadhgonpaplpfgajhdpbkaiikb",
    tab: { id: 4 },
    url: "https://example.com/events",
  };
}

function ask(listener, message) {
  return new Promise((resolve) => listener(message, sender(), resolve));
}

function allDayEvent(overrides = {}) {
  return {
    title: "Bahamas trip",
    date: "2026-11-20",
    endDate: "2026-11-22",
    startTime: null,
    endTime: null,
    allDay: true,
    timeZone: "America/Los_Angeles",
    location: null,
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    durationDefaulted: false,
    needsClarification: false,
    clarificationQuestions: [],
    ...overrides,
  };
}

function timedEvent() {
  return {
    title: "Coffee with Alex",
    date: "2026-11-20",
    endDate: "2026-11-20",
    startTime: "10:00",
    endTime: "11:00",
    allDay: false,
    timeZone: "America/Los_Angeles",
    location: "Avila",
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    durationDefaulted: true,
    needsClarification: false,
    clarificationQuestions: [],
  };
}

describe("all-day calendar save confirmation", () => {
  it("confirms a single-day all-day create with date fields", async () => {
    const hooks = { posts: 0, ids: [], bodies: [] };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: allDayEvent({ endDate: "2026-11-20", title: "Team offsite" }),
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.equal(result.allDay, true);
    assert.equal(result.date, "2026-11-20");
    assert.equal(result.endDate, "2026-11-20");
    assert.equal(result.timeText, "All day");
    assert.match(result.htmlLink, /calendar/);
    assert.equal(hooks.bodies[0].start.date, "2026-11-20");
    assert.equal(hooks.bodies[0].end.date, "2026-11-21");
    assert.equal(hooks.bodies[0].start.dateTime, undefined);
  });

  it("confirms a multi-day all-day create and keeps inclusive UI vs exclusive API end", async () => {
    const hooks = { posts: 0, ids: [], bodies: [] };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: allDayEvent(),
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.equal(result.date, "2026-11-20");
    assert.equal(result.endDate, "2026-11-22");
    assert.match(result.dateText, /Nov 20/);
    assert.match(result.dateText, /Nov 22/);
    assert.equal(hooks.bodies[0].start.date, "2026-11-20");
    assert.equal(hooks.bodies[0].end.date, "2026-11-23");
    assert.equal(result.id, hooks.ids[0]);
  });

  it("reuses the original id after an uncertain response instead of inserting again", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], uncertainPost: true };
    const loaded = loadBackground(hooks);
    const event = allDayEvent();
    const first = await ask(loaded.listener, { type: "quickcal-calendar", action: "create", event });
    assert.equal(first.ok, false);
    assert.equal(first.uncertain, true);
    assert.ok(hooks.posts >= 1);
    const pendingId = hooks.ids[0];
    const draft = loaded.store.quickcalDraftEvent;
    assert.ok(draft, "pending all-day draft must remain loadable");
    assert.equal(draft.id, pendingId);
    assert.equal(draft.allDay, true);
    assert.equal(draft.phase, "pending");
    // Simulate Google actually creating it despite the uncertain HTTP response.
    loaded.calendar.set(pendingId, {
      id: pendingId,
      summary: "Bahamas trip",
      htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
      status: "confirmed",
      reminders: { useDefault: false, overrides: [] },
      start: { date: "2026-11-20" },
      end: { date: "2026-11-23" },
    });
    hooks.uncertainPost = false;
    const postsBeforeRetry = hooks.posts;
    const retry = await ask(loaded.listener, { type: "quickcal-calendar", action: "create", event });
    assert.equal(retry.ok, true, retry.error || JSON.stringify(retry));
    assert.equal(retry.id, pendingId);
    assert.equal(hooks.posts, postsBeforeRetry, "already-created all-day event must not insert again");
  });

  it("still confirms timed events with dateTime fields", async () => {
    const hooks = { posts: 0, ids: [], bodies: [] };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: timedEvent(),
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.equal(result.allDay, false);
    assert.match(hooks.bodies[0].start.dateTime, /2026-11-20T10:00:00/);
    assert.equal(hooks.bodies[0].start.date, undefined);
  });

  it("rejects mismatched schedule responses instead of claiming success", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], mismatchSchedule: true };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: allDayEvent(),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not confirm/);
  });

  it("rejects mismatched summary responses", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], mismatchSummary: true };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: allDayEvent(),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not confirm/);
  });

  it("keeps a successful all-day save even when a later conflict check fails", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], conflictFail: true };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: allDayEvent(),
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.match(result.htmlLink, /calendar/);
    assert.equal(result.date, "2026-11-20");
    assert.equal(result.endDate, "2026-11-22");
  });

  it("confirms all-day creates when Google materializes calendar defaults as overrides", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], materializeDefaults: true };
    const loaded = loadBackground(hooks);
    const result = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "create",
      event: allDayEvent({ reminders: { useDefault: true, overrides: [] } }),
    });
    assert.equal(result.ok, true, result.error || JSON.stringify(result));
    assert.deepEqual(hooks.bodies[0].reminders, { useDefault: true });
    assert.equal(result.id, hooks.ids[0]);
  });
});
