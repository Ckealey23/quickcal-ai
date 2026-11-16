import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";

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

function eventItem(id, summary, start, end, extra) {
  return Object.assign({
    id: id,
    summary: summary,
    status: "confirmed",
    transparency: "opaque",
    htmlLink: "https://calendar.google.com/calendar/event?eid=" + encodeURIComponent(id),
    start: { dateTime: start, timeZone: zone },
    end: { dateTime: end, timeZone: zone },
  }, extra || {});
}

function availabilityBody(fields, title, readOnly) {
  return {
    quickcalApiVersion: 4,
    quickcalRelease: "test",
    intent: "availability",
    title: title === undefined ? "Meeting with Steve" : title,
    date: null,
    startTime: null,
    endTime: null,
    timeZone: zone,
    location: null,
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    needsClarification: false,
    clarificationQuestions: [],
    durationDefaulted: false,
    operation: blankOperation(Object.assign({
      target: "Steve",
      searchDate: "2026-11-17",
      durationMinutes: 60,
      readOnly: readOnly == null ? false : readOnly,
    }, fields || {})),
  };
}

function loadBackground(hooks) {
  const sessionStore = {};
  const localStore = {};
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) { return "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/" + file; },
        onMessage: { addListener(listener) { listeners.message = listener; } },
        onInstalled: { addListener() {} },
      },
      scripting: { executeScript() { return Promise.resolve(); } },
      storage: {
        local: {
          async get(key) { return { [key]: localStore[key] }; },
          async set(value) { Object.assign(localStore, value); },
          async remove(key) { delete localStore[key]; },
        },
        session: {
          async get(key) { return { [key]: sessionStore[key] }; },
          async set(value) { Object.assign(sessionStore, value); },
        },
      },
      identity: {
        async getAuthToken() { return "test-token"; },
        async removeCachedAuthToken() {},
      },
    },
    fetch: async (url, options) => {
      const method = (options && options.method) || "GET";
      const target = String(url);
      const requestBody = options && options.body ? JSON.parse(options.body) : null;
      hooks.calls.push({ url: target, method: method, body: requestBody });
      if (target.includes("/access")) {
        return { ok: true, status: 200, async json() { return { ok: true, approved: true }; } };
      }
      if (target.includes("maxResults=1") && target.includes("fields=kind")) {
        return { ok: true, status: 200, async json() { return { kind: "calendar#events" }; } };
      }
      if (target.includes("/parse-event")) {
        hooks.parses = hooks.parses || [];
        hooks.parses.push(requestBody);
        const body = typeof hooks.parseBody === "function" ? hooks.parseBody(requestBody) : hooks.parseBody;
        return {
          ok: true,
          status: 200,
          async json() {
            return body || availabilityBody();
          },
        };
      }
      if (target.includes("/users/me/calendarList")) {
        if (hooks.calendarListFail) {
          return { ok: false, status: 500, async json() { return { error: { message: "fail" } }; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              items: hooks.calendars || [
                { id: "primary", summary: "Primary", primary: true, accessRole: "owner" },
              ],
            };
          },
        };
      }
      if (target.includes("/freeBusy")) {
        return {
          ok: true,
          status: 200,
          async json() { return { calendars: hooks.freeBusy || {} }; },
        };
      }
      if (method === "POST" && target.includes("/calendars/primary/events") && !target.includes("freeBusy")) {
        hooks.posts = (hooks.posts || 0) + 1;
        const body = requestBody || {};
        hooks.created = hooks.created || [];
        hooks.created.push(body);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: body.id,
              summary: body.summary,
              htmlLink: "https://calendar.google.com/calendar/event?eid=" + encodeURIComponent(body.id),
              status: "confirmed",
              start: body.start,
              end: body.end,
              reminders: body.reminders,
            };
          },
        };
      }
      if (target.includes("singleEvents=true") && target.includes("transparency")) {
        const calendarId = /\/calendars\/([^/]+)\/events/.exec(target);
        const key = calendarId ? decodeURIComponent(calendarId[1]) : "primary";
        if (hooks.conflictEventFail === key || hooks.conflictEventFail === "primary" && key === "primary" && hooks.incompletePrimary) {
          return { ok: false, status: 403, async json() { return { error: { message: "insufficientPermissions" } }; } };
        }
        if (hooks.unavailableCalendar === key) {
          return { ok: false, status: 403, async json() { return { error: { message: "insufficientPermissions" } }; } };
        }
        const items = (hooks.conflictItemsByCalendar && hooks.conflictItemsByCalendar[key]) || hooks.conflictItems || [];
        return { ok: true, status: 200, async json() { return { items: items }; } };
      }
      if (target.includes("singleEvents=true")) {
        return { ok: true, status: 200, async json() { return { items: hooks.items || [] }; } };
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
    files.forEach((file) => runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file }));
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return { listener: listeners.message, sessionStore: sessionStore };
}

function sender(tabId) {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    tab: { id: tabId || 4, incognito: false },
    url: "https://example.com/day",
  };
}

function send(listener, message, tabId) {
  return new Promise((resolve) => listener(message, sender(tabId), resolve));
}

describe("availability session flow", () => {
  it("lists up to three free Tuesday slots without creating an event", async () => {
    const hooks = {
      calls: [],
      conflictItems: [
        eventItem("busy", "Standup", "2026-11-17T09:00:00-08:00", "2026-11-17T10:00:00-08:00"),
      ],
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Find a time on Tuesday for my meeting with Steve.",
      timeZone: zone,
      operationId: "avail-1",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(result.session.mode, "choosing");
    assert.equal(result.session.lookup.action, "availability");
    assert.equal(result.session.lookup.candidates.length, 3);
    assert.equal(result.session.lookup.candidates[0].startTime, "10:00");
    assert.match(result.session.lookup.prompt, /1-hour default|09:00/);
    assert.match(result.session.lookup.lines[0], /Meeting with Steve/);
  });

  it("creates exactly once when the second slot is selected", async () => {
    const hooks = {
      calls: [],
      conflictItems: [],
      parseBody(request) {
        if (request.operation && /second/i.test(request.text || "")) {
          return availabilityBody({ selection: ["c2"], searchDate: "2026-11-17", readOnly: false });
        }
        return availabilityBody({ searchDate: "2026-11-17", readOnly: false });
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const listed = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Find a time on Tuesday for my meeting with Steve.",
      timeZone: zone,
      operationId: "avail-2a",
      sessionId: sessionId,
    });
    assert.equal(listed.session.lookup.candidates.length, 3);
    const second = listed.session.lookup.candidates[1];
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "The second one.",
      timeZone: zone,
      operationId: "avail-2b",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts, 1);
    assert.equal(saved.session.mode, "saved");
    assert.equal(hooks.created[0].summary, "Meeting with Steve");
    assert.equal(hooks.created[0].start.dateTime.includes("T"), true);
    assert.equal(saved.session.savedRecord.startTime, second.startTime);
    assert.equal(saved.session.savedRecord.endTime, second.endTime);
    assert.ok(saved.session.conflictNotice);
  });

  it("does not create for a read-only free-time question", async () => {
    const hooks = {
      calls: [],
      conflictItems: [],
      parseBody: availabilityBody({ searchDate: "2026-11-17", target: null, readOnly: true }, null, true),
    };
    hooks.parseBody.title = null;
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "When am I free Tuesday?",
      timeZone: zone,
      operationId: "avail-3",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(result.session.lookup.action, "availability");
    assert.equal(result.session.lookup.query.readOnly, true);
    assert.match(result.session.lookup.prompt, /Open times/i);
    assert.equal(hooks.posts || 0, 0);
  });

  it("includes secondary-calendar busy times and labels incomplete coverage", async () => {
    const hooks = {
      calls: [],
      calendars: [
        { id: "primary", summary: "Primary", primary: true, accessRole: "owner" },
        { id: "shared@example.com", summary: "Team", accessRole: "reader" },
      ],
      conflictItemsByCalendar: {
        primary: [],
        "shared@example.com": [
          eventItem("shared-busy", "Team sync", "2026-11-17T09:00:00-08:00", "2026-11-17T12:00:00-08:00"),
        ],
      },
      unavailableCalendar: "broken@example.com",
    };
    hooks.calendars.push({ id: "broken@example.com", summary: "Private", accessRole: "reader" });
    hooks.freeBusy = {
      "broken@example.com": { errors: [{ domain: "global", reason: "notFound" }] },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Find a time Tuesday for Steve",
      timeZone: zone,
      operationId: "avail-4",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(result.session.lookup.candidates[0].startTime, "12:00");
    assert.equal(result.session.lookup.partial, true);
    assert.match(result.session.lookup.prompt, /Partial check/i);
  });

  it("rechecks a stale slot and offers schedule anyway", async () => {
    let busy = false;
    const hooks = {
      calls: [],
      get conflictItems() {
        return busy
          ? [eventItem("taken", "Taken", "2026-11-17T09:00:00-08:00", "2026-11-17T12:00:00-08:00")]
          : [];
      },
      parseBody(request) {
        if (request.operation && /second|first|1|c1/i.test(request.text || "")) {
          return availabilityBody({ selection: ["c1"], searchDate: "2026-11-17" });
        }
        return availabilityBody({ searchDate: "2026-11-17" });
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Find a time Tuesday for Steve",
      timeZone: zone,
      operationId: "avail-5a",
      sessionId: sessionId,
    });
    busy = true;
    const stale = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "The first one.",
      timeZone: zone,
      operationId: "avail-5b",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(stale.session.lookup.kind, "confirm");
    assert.equal(stale.session.lookup.forceSchedule, true);
    assert.match(stale.session.lookup.prompt, /no longer free/i);
    const forced = await send(background.listener, {
      type: "quickcal-widget",
      action: "confirm",
      sessionId: sessionId,
      operationId: "avail-5c",
    });
    assert.equal(hooks.posts, 1);
    assert.equal(forced.session.mode, "saved");
  });

  it("continues across tabs and ignores dismissal mid-search results after cancel", async () => {
    const hooks = {
      calls: [],
      conflictItems: [],
      parseBody: availabilityBody({ searchDate: "2026-11-17" }),
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" }, 4);
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const listed = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Find a time Tuesday for Steve",
      timeZone: zone,
      operationId: "avail-6a",
      sessionId: sessionId,
    }, 4);
    assert.equal(listed.session.lookup.candidates.length, 3);
    const other = await send(background.listener, { type: "quickcal-widget", action: "snapshot" }, 9);
    assert.equal(other.session.lookup.candidates.length, 3);
    await send(background.listener, {
      type: "quickcal-widget",
      action: "cancel-lookup",
      sessionId: sessionId,
    }, 9);
    const cleared = await send(background.listener, { type: "quickcal-widget", action: "snapshot" }, 4);
    assert.equal(cleared.session.lookup, null);
    assert.equal(hooks.posts || 0, 0);
  });

  it("asks for a title only after an untitled availability slot is selected", async () => {
    const hooks = {
      calls: [],
      conflictItems: [],
      parseBody(request) {
        if (/standup/i.test(request.text || "")) {
          return availabilityBody({
            selection: [],
            searchDate: "2026-11-17",
            target: null,
            readOnly: false,
          }, "Standup", false);
        }
        if (request.operation && /first|1|c1/i.test(request.text || "")) {
          return availabilityBody({ selection: ["c1"], searchDate: "2026-11-17", target: null, readOnly: true }, null, true);
        }
        return availabilityBody({ searchDate: "2026-11-17", target: null, readOnly: true }, null, true);
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const listed = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "any time Friday afternoon?",
      timeZone: zone,
      operationId: "avail-title-a",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(listed.session.lookup.action, "availability");
    assert.equal(listed.session.lookup.query.readOnly, true);
    assert.equal(listed.session.lookup.query.title, "");

    const picked = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "The first one.",
      timeZone: zone,
      operationId: "avail-title-b",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(picked.session.lookup.awaiting, "title");
    assert.match(picked.session.lookup.prompt, /call this event/i);

    const named = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Standup",
      timeZone: zone,
      operationId: "avail-title-c",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts, 1);
    assert.equal(named.session.mode, "saved");
    assert.equal(hooks.created[0].summary, "Standup");
  });

  it("searches evening openings from a stubbed availability parse without clarifying", async () => {
    const hooks = {
      calls: [],
      conflictItems: [
        eventItem("busy", "Dinner", "2026-11-18T17:00:00-08:00", "2026-11-18T18:00:00-08:00"),
      ],
      parseBody: availabilityBody({
        searchDate: "2026-11-18",
        durationMinutes: 30,
        preference: "evening",
        target: null,
        readOnly: true,
      }, null, true),
    };
    hooks.parseBody.title = null;
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "find 30 min wednesday evening",
      timeZone: zone,
      operationId: "avail-evening",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(result.session.mode, "choosing");
    assert.equal(result.session.lookup.action, "availability");
    assert.equal(result.session.lookup.query.durationMinutes, 30);
    assert.equal(result.session.lookup.query.preference, "evening");
    assert.equal(result.session.lookup.candidates[0].startTime, "18:00");
    assert.match(result.session.lookup.prompt, /evening 17:00/);
    assert.doesNotMatch(result.session.lookup.prompt || "", /free-time search|existing event/i);
  });

  it("refines to Wednesday and a shorter duration without creating early", async () => {
    const hooks = {
      calls: [],
      conflictItems: [],
      parseBody(request) {
        if (/wednesday/i.test(request.text || "")) {
          return availabilityBody({
            searchDate: "2026-11-18",
            durationMinutes: 30,
            preference: null,
            readOnly: false,
          });
        }
        return availabilityBody({ searchDate: "2026-11-17", durationMinutes: 60 });
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Find an hour Tuesday for Steve",
      timeZone: zone,
      operationId: "avail-7a",
      sessionId: sessionId,
    });
    const refined = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "What about Wednesday for 30 minutes instead?",
      timeZone: zone,
      operationId: "avail-7b",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(refined.session.lookup.query.date, "2026-11-18");
    assert.equal(refined.session.lookup.query.durationMinutes, 30);
    assert.equal(refined.session.lookup.candidates[0].endTime, "09:30");
  });
});
