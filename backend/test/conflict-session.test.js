import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";

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

function blankOperation() {
  return {
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
        return {
          ok: true,
          status: 200,
          async json() {
            return hooks.parseBody || {
              quickcalApiVersion: 4,
              intent: "create",
              quickcalRelease: "test",
              title: "Coffee with Alex",
              date: "2026-11-17",
              endDate: "2026-11-17",
              startTime: "14:00",
              endTime: "15:00",
              timeZone: zone,
              location: null,
              recurrence: null,
              reminders: { useDefault: false, overrides: [] },
              needsClarification: false,
              clarificationQuestions: [],
              durationDefaulted: false,
              operation: blankOperation(),
            };
          },
        };
      }
      if (target.includes("/users/me/calendarList")) {
        if (hooks.conflictScopesDenied) {
          return {
            ok: false,
            status: 403,
            async json() {
              return { error: { message: "Request had insufficient authentication scopes." } };
            },
          };
        }
        if (hooks.calendarListNetwork) throw new TypeError("Failed to fetch");
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
        hooks.freeBusyCalls = (hooks.freeBusyCalls || 0) + 1;
        return {
          ok: true,
          status: 200,
          async json() {
            return { calendars: hooks.freeBusy || {} };
          },
        };
      }
      if (method === "POST" && target.includes("/calendars/primary/events") && !target.includes("freeBusy")) {
        hooks.posts = (hooks.posts || 0) + 1;
        const body = requestBody || {};
        hooks.createdId = body.id;
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
      if (method === "PATCH") {
        hooks.patches = hooks.patches || [];
        hooks.patches.push({ url: target, body: requestBody });
        return {
          ok: true,
          status: 200,
          async json() {
            return Object.assign({
              id: decodeURIComponent(target.split("/events/")[1].split("?")[0]),
              summary: "Meeting with Steve",
              htmlLink: "https://calendar.google.com/calendar/event?eid=moved",
              status: "confirmed",
            }, requestBody);
          },
        };
      }
      if (target.includes("singleEvents=true") && target.includes("transparency")) {
        hooks.conflictLists = (hooks.conflictLists || 0) + 1;
        if (hooks.conflictEventFail === "primary" && target.includes("/calendars/primary/")) {
          return { ok: false, status: 403, async json() { return { error: { message: "insufficientPermissions" } }; } };
        }
        if (hooks.conflictEventFail === "shared" && target.includes("shared")) {
          return { ok: false, status: 403, async json() { return { error: { message: "insufficientPermissions" } }; } };
        }
        const calendarId = /\/calendars\/([^/]+)\/events/.exec(target);
        const key = calendarId ? decodeURIComponent(calendarId[1]) : "primary";
        const items = (hooks.conflictItemsByCalendar && hooks.conflictItemsByCalendar[key]) || hooks.conflictItems || [];
        return { ok: true, status: 200, async json() { return { items: items }; } };
      }
      if (target.includes("singleEvents=true")) {
        return { ok: true, status: 200, async json() { return { items: hooks.items || [] }; } };
      }
      if (method === "GET" && target.includes("/events/")) {
        const id = decodeURIComponent(target.split("/events/")[1].split("?")[0]);
        const found = (hooks.items || []).find((item) => item.id === id);
        if (!found) return { ok: false, status: 404, async json() { return {}; } };
        return { ok: true, status: 200, async json() { return found; } };
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
  return { listener: listeners.message, sessionStore: sessionStore, localStore: localStore };
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

describe("post-save conflict notices", () => {
  it("reports an overlap on the primary calendar after create", async () => {
    const hooks = {
      calls: [],
      conflictItems: [
        eventItem("team", "Team meeting", "2026-11-17T14:30:00-08:00", "2026-11-17T15:30:00-08:00"),
      ],
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex on November 17 at 2 PM for one hour",
      timeZone: zone,
      operationId: "create-1",
      sessionId: sessionId,
    });
    assert.equal(saved.session.mode, "saved");
    assert.equal(hooks.posts, 1);
    assert.equal(saved.session.conflictNotice.status, "conflicts");
    assert.match(saved.session.conflictNotice.lines[0], /Team meeting/);
    assert.match(saved.session.statusText, /Overlaps with/);
    assert.equal(saved.session.statusError, false);
  });

  it("reports an overlap from another calendar and ignores free, cancelled, and declined events", async () => {
    const hooks = {
      calls: [],
      calendars: [
        { id: "primary", summary: "Primary", primary: true, accessRole: "owner" },
        { id: "shared@example.com", summary: "Team calendar", accessRole: "reader" },
      ],
      conflictItemsByCalendar: {
        primary: [
          eventItem("free", "Focus", "2026-11-17T14:00:00-08:00", "2026-11-17T15:00:00-08:00", {
            transparency: "transparent",
          }),
          eventItem("gone", "Old", "2026-11-17T14:00:00-08:00", "2026-11-17T15:00:00-08:00", {
            status: "cancelled",
          }),
          eventItem("no", "Declined invite", "2026-11-17T14:00:00-08:00", "2026-11-17T15:00:00-08:00", {
            attendees: [{ self: true, responseStatus: "declined" }],
          }),
        ],
        "shared@example.com": [
          eventItem("standup", "Standup", "2026-11-17T14:15:00-08:00", "2026-11-17T14:45:00-08:00"),
        ],
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex on November 17 at 2 PM for one hour",
      timeZone: zone,
      operationId: "create-2",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(saved.session.conflictNotice.status, "conflicts");
    assert.equal(saved.session.conflictNotice.lines.length, 1);
    assert.match(saved.session.conflictNotice.lines[0], /Standup/);
    assert.match(saved.session.conflictNotice.lines[0], /Team calendar/);
  });

  it("does not treat adjacent events as conflicts and excludes the saved event", async () => {
    const hooks = {
      calls: [],
      conflictItems: [
        eventItem("next", "Next meeting", "2026-11-17T15:00:00-08:00", "2026-11-17T16:00:00-08:00"),
      ],
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex on November 17 at 2 PM for one hour",
      timeZone: zone,
      operationId: "create-3",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    const selfItem = eventItem(
      hooks.createdId,
      "Coffee with Alex",
      "2026-11-17T14:00:00-08:00",
      "2026-11-17T15:00:00-08:00"
    );
    hooks.conflictItems = [selfItem, hooks.conflictItems[0]];
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    assert.equal(saved.session.conflictNotice.status, "clear");
    assert.equal(saved.session.conflictNotice.lines.length, 0);
    assert.equal(saved.session.statusText, "");
  });

  it("keeps the success card when conflict checking is incomplete or scopes are missing", async () => {
    const denied = loadBackground({ calls: [], conflictScopesDenied: true });
    await send(denied.listener, { type: "quickcal-widget", action: "show" });
    const scoped = await send(denied.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex on November 17 at 2 PM for one hour",
      timeZone: zone,
      operationId: "create-scopes",
      sessionId: denied.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(scoped.session.mode, "saved");
    assert.equal(scoped.session.savedRecord.htmlLink.includes("calendar.google.com"), true);
    assert.equal(scoped.session.conflictNotice.status, "needsScopes");
    assert.match(scoped.session.statusText, /Event saved/);
    assert.equal(scoped.session.statusError, false);

    const partial = loadBackground({
      calls: [],
      calendars: [
        { id: "primary", summary: "Primary", primary: true, accessRole: "owner" },
        { id: "shared@example.com", summary: "Busy only", accessRole: "freeBusyReader" },
      ],
      conflictEventFail: "shared",
      freeBusy: {
        "shared@example.com": {
          errors: [{ domain: "global", reason: "notFound" }],
        },
      },
    });
    await send(partial.listener, { type: "quickcal-widget", action: "show" });
    const incomplete = await send(partial.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex on November 17 at 2 PM for one hour",
      timeZone: zone,
      operationId: "create-partial",
      sessionId: partial.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(incomplete.session.mode, "saved");
    assert.equal(incomplete.session.conflictNotice.status, "incomplete");
    assert.match(incomplete.session.statusText, /incomplete/i);
    assert.equal(incomplete.session.statusError, false);
  });

  it("checks conflicts after a move and shares the notice across tabs", async () => {
    const steve = eventItem(
      "steve-1",
      "Meeting with Steve",
      "2026-11-17T17:00:00-08:00",
      "2026-11-17T18:00:00-08:00",
      { attendees: [{ email: "steve@example.com", displayName: "Steve" }] }
    );
    const hooks = {
      calls: [],
      items: [steve],
      conflictItems: [
        eventItem("other", "Team meeting", "2026-11-17T19:00:00-08:00", "2026-11-17T20:00:00-08:00"),
      ],
      parseBody: null,
    };
    hooks.parseBody = {
      quickcalApiVersion: 4,
      intent: "move",
      quickcalRelease: "test",
      timeZone: zone,
      needsClarification: false,
      clarificationQuestions: [],
      operation: Object.assign(blankOperation(), {
        target: "Steve",
        searchDate: "2026-11-17",
        searchTime: "17:00",
        destinationTime: "19:00",
      }),
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const moved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my 5 PM meeting with Steve to 7 PM",
      timeZone: zone,
      operationId: "move-conflict",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(moved.session.mode, "saved");
    assert.equal(hooks.patches.length, 1);
    assert.equal(hooks.posts || 0, 0);
    assert.equal(moved.session.conflictNotice.status, "conflicts");
    assert.match(moved.session.conflictNotice.lines[0], /Team meeting/);

    const otherTab = await send(background.listener, { type: "quickcal-widget", action: "snapshot" }, 9);
    assert.equal(otherTab.session.conflictNotice.status, "conflicts");
    assert.equal(otherTab.session.conflictNotice.lines[0], moved.session.conflictNotice.lines[0]);
  });

  it("drops a late conflict result after dismissal and never writes during the check", async () => {
    const hooks = {
      calls: [],
      conflictItems: [
        eventItem("team", "Team meeting", "2026-11-17T14:30:00-08:00", "2026-11-17T15:30:00-08:00"),
      ],
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const creating = send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee with Alex on November 17 at 2 PM for one hour",
      timeZone: zone,
      operationId: "create-late",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await send(background.listener, { type: "quickcal-widget", action: "dismiss" });
    await creating;
    const snap = await send(background.listener, { type: "quickcal-widget", action: "snapshot" });
    assert.equal(snap.session.visible, false);
    assert.equal(snap.session.mode, "input");
    assert.equal(snap.session.conflictNotice, null);
    assert.equal(hooks.posts, 1);
    const eventWrites = hooks.calls.filter((call) => {
      return (call.method === "POST" || call.method === "PATCH" || call.method === "DELETE") &&
        call.url.includes("/calendars/") &&
        call.url.includes("/events");
    });
    assert.equal(eventWrites.length, 1);
  });
});
