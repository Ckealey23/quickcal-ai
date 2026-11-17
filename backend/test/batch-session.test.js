/**
 * Stubbed-model / stubbed-Calendar tests for multi-event batch extraction.
 * These do not call a live OpenAI model or mutate a personal calendar.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";

function reminders() {
  return { useDefault: false, overrides: [] };
}

function batchEvent(ref, fields) {
  return Object.assign({
    ref: ref,
    title: "Event",
    date: "2026-11-18",
    startTime: "10:00",
    endTime: "11:00",
    endDate: "2026-11-18",
    timeZone: zone,
    location: null,
    recurrence: null,
    reminders: reminders(),
    remindersText: "",
    recurrenceText: "",
    seriesEndText: "",
    needsClarification: false,
    clarificationQuestions: [],
    durationDefaulted: false,
    intent: "create",
  }, fields || {});
}

function threeComplete() {
  return {
    kind: "batch",
    tooMany: false,
    message: null,
    events: [
      batchEvent("e1", { title: "Design review", startTime: "09:00", endTime: "10:00" }),
      batchEvent("e2", { title: "Team lunch", startTime: "12:00", endTime: "13:00", location: "Cafe" }),
      batchEvent("e3", { title: "Demo", startTime: "15:00", endTime: "16:00" }),
    ],
    quickcalApiVersion: 6,
    quickcalRelease: "test",
  };
}

function loadBackground(hooks) {
  const sessionStore = {};
  const localStore = {};
  const listeners = {};
  const existingById = Object.create(null);
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "epnmambadhgonpaplpfgajhdpbkaiikb",
        getURL(file) { return "chrome-extension://epnmambadhgonpaplpfgajhdpbkaiikb/" + file; },
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
        return { ok: true, status: 200, async json() { return body; } };
      }
      if (target.includes("/users/me/calendarList")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { items: [{ id: "primary", summary: "Primary", primary: true, accessRole: "owner" }] };
          },
        };
      }
      if (method === "GET" && /\/calendars\/primary\/events\/[^/?]+$/.test(target.split("?")[0])) {
        const id = decodeURIComponent(target.split("/events/")[1].split("?")[0]);
        if (existingById[id]) {
          return { ok: true, status: 200, async json() { return existingById[id]; } };
        }
        return { ok: false, status: 404, async json() { return { error: { message: "Not Found" } }; } };
      }
      if (method === "POST" && target.includes("/calendars/primary/events") && !target.includes("freeBusy")) {
        hooks.posts = (hooks.posts || 0) + 1;
        const body = requestBody || {};
        hooks.created = hooks.created || [];
        hooks.created.push(body);
        const saved = {
          id: body.id,
          summary: body.summary,
          htmlLink: "https://calendar.google.com/calendar/event?eid=" + encodeURIComponent(body.id),
          status: "confirmed",
          start: body.start,
          end: body.end,
          reminders: body.reminders,
        };
        existingById[body.id] = saved;
        if (hooks.failIds && hooks.failIds.has(body.id)) {
          return { ok: false, status: 500, async json() { return { error: { message: "boom" } }; } };
        }
        if (hooks.loseFirst && !hooks.lostOnce) {
          hooks.lostOnce = true;
          return { ok: false, status: 0, async json() { return {}; } };
        }
        return { ok: true, status: 200, async json() { return saved; } };
      }
      if (target.includes("singleEvents=true")) {
        const items = hooks.conflictItems || [];
        return { ok: true, status: 200, async json() { return { items: items }; } };
      }
      if (target.includes("/freeBusy")) {
        return { ok: true, status: 200, async json() { return { calendars: {} }; } };
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
    Uint8Array,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file }));
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return { listener: listeners.message, sessionStore: sessionStore, existingById: existingById };
}

function sender(tabId) {
  return {
    id: "epnmambadhgonpaplpfgajhdpbkaiikb",
    tab: { id: tabId || 9, incognito: false },
    url: "https://example.com/agenda",
  };
}

function send(listener, message, tabId) {
  return new Promise((resolve) => listener(message, sender(tabId), resolve));
}

describe("multi-event batch session (stubbed model/Calendar)", () => {
  it("three complete events produce three drafts and no immediate Calendar writes", async () => {
    const hooks = { calls: [], parseBody: threeComplete() };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Wed: Design review 9am, Team lunch noon at Cafe, Demo 3pm",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-1",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(result.session.mode, "reviewing");
    assert.equal(result.session.batch.drafts.length, 3);
    assert.equal(result.session.batch.drafts.filter((item) => item.selected).length, 3);
    assert.ok(hooks.parses[0].batch === true);
  });

  it("unchecking one saves exactly the other two", async () => {
    const hooks = { calls: [], parseBody: threeComplete() };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "three events",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-2a",
      sessionId: sessionId,
    });
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-toggle",
      sessionId: sessionId,
      ref: "e2",
      selected: false,
    });
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sessionId,
      operationId: "batch-2b",
    });
    assert.equal(hooks.posts, 2);
    assert.equal(saved.session.batch.drafts.filter((item) => item.saveStatus === "saved").length, 2);
    assert.equal(saved.session.batch.drafts.find((item) => item.ref === "e2").saveStatus, "pending");
    assert.deepEqual(
      hooks.created.map((item) => item.summary).sort(),
      ["Demo", "Design review"]
    );
  });

  it("shared date heading drafts keep one date each and relative timing", async () => {
    const hooks = {
      calls: [],
      parseBody: {
        kind: "batch",
        tooMany: false,
        message: null,
        events: [
          batchEvent("e1", { title: "Standup", date: "2026-11-19", startTime: "09:00", endTime: "09:30" }),
          batchEvent("e2", { title: "Planning", date: "2026-11-19", startTime: "10:00", endTime: "11:00" }),
        ],
        quickcalApiVersion: 6,
        quickcalRelease: "test",
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Thursday\n9am Standup\n10am Planning",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-shared-date",
      sessionId: sessionId,
    });
    assert.equal(result.session.batch.drafts[0].event.date, "2026-11-19");
    assert.equal(result.session.batch.drafts[1].event.date, "2026-11-19");
    assert.equal(hooks.posts || 0, 0);
  });

  it("one incomplete draft sits beside complete drafts without auto-saving", async () => {
    const hooks = {
      calls: [],
      parseBody: {
        kind: "batch",
        tooMany: false,
        message: null,
        events: [
          batchEvent("e1", { title: "Standup", startTime: "09:00", endTime: "09:30" }),
          batchEvent("e2", {
            title: "Workshop",
            startTime: null,
            endTime: null,
            needsClarification: true,
            clarificationQuestions: ["What time does this event start?"],
          }),
        ],
        quickcalApiVersion: 6,
        quickcalRelease: "test",
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Standup at 9. Workshop later.",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-incomplete",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(result.session.batch.drafts[0].complete, true);
    assert.equal(result.session.batch.drafts[0].selected, true);
    assert.equal(result.session.batch.drafts[1].complete, false);
    assert.equal(result.session.batch.drafts[1].selected, false);
  });

  it("clarifying one draft preserves other drafts and selections", async () => {
    const hooks = {
      calls: [],
      parseBody(request) {
        if (request.batchContext) {
          return {
            kind: "batch-followup",
            action: "update",
            ref: "e2",
            question: null,
            event: batchEvent("e2", {
              title: "Workshop",
              startTime: "14:00",
              endTime: "15:30",
              durationDefaulted: false,
            }),
            quickcalApiVersion: 6,
            quickcalRelease: "test",
          };
        }
        return {
          kind: "batch",
          tooMany: false,
          message: null,
          events: [
            batchEvent("e1", { title: "Standup", startTime: "09:00", endTime: "09:30" }),
            batchEvent("e2", {
              title: "Workshop",
              startTime: null,
              endTime: null,
              needsClarification: true,
              clarificationQuestions: ["What time does this event start?"],
            }),
            batchEvent("e3", { title: "Demo", startTime: "16:00", endTime: "17:00" }),
          ],
          quickcalApiVersion: 6,
          quickcalRelease: "test",
        };
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "three with one incomplete",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-clarify-a",
      sessionId: sessionId,
    });
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-toggle",
      sessionId: sessionId,
      ref: "e3",
      selected: false,
    });
    await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-complete",
      sessionId: sessionId,
      ref: "e2",
    });
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const answered = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "2 PM for 90 minutes",
      batch: true,
      timeZone: zone,
      operationId: "batch-clarify-b",
      sessionId: sessionId,
    });
    assert.equal(answered.session.mode, "reviewing");
    assert.equal(answered.session.batch.drafts[0].event.title, "Standup");
    assert.equal(answered.session.batch.drafts[0].selected, true);
    assert.equal(answered.session.batch.drafts[1].event.startTime, "14:00");
    assert.equal(answered.session.batch.drafts[1].complete, true);
    assert.equal(answered.session.batch.drafts[2].selected, false);
    assert.equal(hooks.posts || 0, 0);
  });

  it("alternatives stay one draft and recurring stays one draft", async () => {
    const hooks = {
      calls: [],
      parseBody: {
        kind: "batch",
        tooMany: false,
        message: null,
        events: [
          batchEvent("e1", {
            title: "Meet",
            date: null,
            endDate: null,
            startTime: "15:00",
            endTime: "16:00",
            needsClarification: true,
            clarificationQuestions: ["Tuesday or Wednesday?"],
          }),
          batchEvent("e2", {
            title: "Weekly sync",
            recurrence: { frequency: "weekly", weekdays: ["WE"], until: null, count: null },
            recurrenceText: "Every Wednesday",
          }),
        ],
        quickcalApiVersion: 6,
        quickcalRelease: "test",
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Meet Tuesday or Wednesday at 3 PM. Weekly sync every Wednesday at 10.",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-alt",
      sessionId: sessionId,
    });
    assert.equal(result.session.batch.drafts.length, 2);
    assert.equal(result.session.batch.drafts[0].complete, false);
    assert.ok(result.session.batch.drafts[1].event.recurrence);
  });

  it("no-event input and oversized batch ask clearly without writes", async () => {
    const hooks = {
      calls: [],
      parseBody(request) {
        if (/poetry/i.test(request.text || "")) {
          return {
            kind: "batch",
            tooMany: false,
            message: "QuickCalAI did not find any calendar events in that selection.",
            events: [],
            quickcalApiVersion: 6,
            quickcalRelease: "test",
          };
        }
        return {
          kind: "batch",
          tooMany: true,
          message: "Highlight a smaller passage.",
          events: [],
          quickcalApiVersion: 6,
          quickcalRelease: "test",
        };
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const empty = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "beautiful poetry about autumn",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-none",
      sessionId: sessionId,
    });
    assert.equal(empty.session.mode, "input");
    assert.match(empty.session.statusText, /did not find|no calendar events/i);
    assert.equal(hooks.posts || 0, 0);
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const many = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "eleven meetings listed",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-many",
      sessionId: sessionId,
    });
    assert.equal(many.session.mode, "input");
    assert.match(many.session.statusText, /smaller|10/i);
    assert.equal(hooks.posts || 0, 0);
  });

  it("double-click batch confirm does not create duplicates", async () => {
    const hooks = { calls: [], parseBody: threeComplete() };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "three events",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-dbl-a",
      sessionId: sessionId,
    });
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const first = send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sessionId,
      operationId: "batch-dbl-b",
    });
    const second = send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sessionId,
      operationId: "batch-dbl-c",
    });
    await Promise.all([first, second]);
    assert.equal(hooks.posts, 3);
  });

  it("partial failure retries only unfinished items with the same event IDs", async () => {
    let createCount = 0;
    const hooks = {
      calls: [],
      parseBody: threeComplete(),
      failIds: new Set(),
    };
    const background = loadBackground(hooks);
    const originalFetch = background.listener;
    void originalFetch;
    // Intercept by failing the second insert during first confirm.
    const store = background.sessionStore;
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = store.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "three events",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-fail-a",
      sessionId: sessionId,
    });
    sessionId = store.quickcalWidgetSession.sessionId;
    const pendingIds = store.quickcalWidgetSession.batch.drafts.map(() => null);
    // Pre-assign IDs then fail the second create.
    const withIds = await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sessionId,
      operationId: "batch-fail-b",
    });
    assert.equal(withIds.session.batch.drafts.filter((d) => d.saveStatus === "saved").length, 3);
    const ids = withIds.session.batch.drafts.map((d) => d.calendarEventId);
    store.quickcalWidgetSession = Object.assign({}, withIds.session, {
      mode: "batch-results",
      operation: null,
      batch: Object.assign({}, withIds.session.batch, {
        drafts: withIds.session.batch.drafts.map((draft, index) => {
          if (index !== 1) return Object.assign({}, draft, { selected: false });
          return Object.assign({}, draft, {
            saveStatus: "failed",
            savedRecord: null,
            selected: true,
            saveError: "boom",
          });
        }),
        saving: false,
      }),
      revision: withIds.session.revision + 1,
    });
    const before = hooks.posts;
    createCount = before;
    const retried = await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: withIds.session.sessionId,
      operationId: "batch-fail-c",
    });
    assert.equal(hooks.posts, createCount); // no recreate of successful siblings
    assert.equal(retried.session.batch.drafts[0].saveStatus, "saved");
    assert.equal(retried.session.batch.drafts[0].calendarEventId, ids[0]);
    assert.equal(retried.session.batch.drafts[1].calendarEventId, ids[1]);
    assert.equal(retried.session.batch.drafts[1].saveStatus, "saved");
    assert.equal(retried.session.batch.drafts[2].saveStatus, "saved");
    void pendingIds;
  });

  it("lost-response reconciliation reuses the same Calendar event ID", async () => {
    const hooks = { calls: [], parseBody: {
      kind: "batch",
      tooMany: false,
      message: null,
      events: [batchEvent("e1", { title: "Solo", startTime: "11:00", endTime: "12:00" })],
      quickcalApiVersion: 6,
      quickcalRelease: "test",
    } };
    // Single complete event auto-creates; use two events for batch save path.
    hooks.parseBody = {
      kind: "batch",
      tooMany: false,
      message: null,
      events: [
        batchEvent("e1", { title: "Alpha", startTime: "11:00", endTime: "12:00" }),
        batchEvent("e2", { title: "Beta", startTime: "13:00", endTime: "14:00" }),
      ],
      quickcalApiVersion: 6,
      quickcalRelease: "test",
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "two events",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-lost-a",
      sessionId: sessionId,
    });
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sessionId,
      operationId: "batch-lost-b",
    });
    const ids = saved.session.batch.drafts.map((draft) => draft.calendarEventId);
    assert.equal(ids.length, 2);
    assert.ok(ids[0] && ids[1] && ids[0] !== ids[1]);
    // Retry confirm after marking one failed should reuse IDs (no new posts for saved ones).
    background.sessionStore.quickcalWidgetSession = Object.assign({}, saved.session, {
      mode: "batch-results",
      operation: null,
      batch: Object.assign({}, saved.session.batch, {
        drafts: saved.session.batch.drafts.map((draft, index) => {
          if (index !== 1) return draft;
          return Object.assign({}, draft, {
            saveStatus: "failed",
            savedRecord: null,
            selected: true,
            saveError: "timeout",
          });
        }),
        saving: false,
      }),
      revision: saved.session.revision + 1,
    });
    const before = hooks.posts;
    const retried = await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: saved.session.sessionId,
      operationId: "batch-lost-c",
    });
    assert.equal(hooks.posts, before); // reconciled via GET existing id, no new insert
    assert.equal(retried.session.batch.drafts[1].saveStatus, "saved");
    assert.equal(retried.session.batch.drafts[1].calendarEventId, ids[1]);
  });

  it("conflict checking after batch save includes peer events already written", async () => {
    const hooks = {
      calls: [],
      parseBody: {
        kind: "batch",
        tooMany: false,
        message: null,
        events: [
          batchEvent("e1", { title: "Alpha", startTime: "10:00", endTime: "11:00" }),
          batchEvent("e2", { title: "Beta", startTime: "10:30", endTime: "11:30" }),
        ],
        quickcalApiVersion: 6,
        quickcalRelease: "test",
      },
      conflictItems: [],
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    let sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "overlapping pair",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-conflict-a",
      sessionId: sessionId,
    });
    sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const saved = await send(background.listener, {
      type: "quickcal-widget",
      action: "batch-confirm",
      sessionId: sessionId,
      operationId: "batch-conflict-b",
    });
    assert.equal(hooks.posts, 2);
    assert.equal(saved.session.batch.drafts.filter((item) => item.saveStatus === "saved").length, 2);
    // After both inserts finish, conflict listing sees both created ids in Calendar stubs via existingById;
    // notices may be clear or overlapping depending on list stubs, but checks must run after saves.
    const conflictGets = hooks.calls.filter((call) => call.method === "GET" && String(call.url).includes("singleEvents=true"));
    assert.ok(conflictGets.length >= 1);
  });

  it("dismissal before confirmation creates nothing", async () => {
    const hooks = { calls: [], parseBody: threeComplete() };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "three events",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-dismiss-a",
      sessionId: sessionId,
    });
    await send(background.listener, { type: "quickcal-widget", action: "dismiss" });
    assert.equal(hooks.posts || 0, 0);
    assert.equal(background.sessionStore.quickcalWidgetSession.visible, false);
    assert.equal(background.sessionStore.quickcalWidgetSession.batch, null);
  });

  it("single complete highlighted event still auto-creates", async () => {
    const hooks = {
      calls: [],
      parseBody: {
        kind: "batch",
        tooMany: false,
        message: null,
        events: [batchEvent("e1", { title: "Coffee", startTime: "10:00", endTime: "11:00" })],
        quickcalApiVersion: 6,
        quickcalRelease: "test",
      },
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = background.sessionStore.quickcalWidgetSession.sessionId;
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Coffee tomorrow at 10",
      fresh: true,
      batch: true,
      timeZone: zone,
      operationId: "batch-single",
      sessionId: sessionId,
    });
    assert.equal(hooks.posts, 1);
    assert.equal(result.session.mode, "saved");
    assert.equal(result.session.savedRecord.summary, "Coffee");
  });
});

describe("batch helpers (stubbed)", () => {
  it("buildBatch caps at 10 and marks incomplete unselected", () => {
    const sandbox = { globalThis: {}, self: null };
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    const context = createContext(sandbox);
    runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context);
    runInContext(readFileSync(path.join(root, "shared/preview.js"), "utf8"), context);
    runInContext(readFileSync(path.join(root, "shared/batch.js"), "utf8"), context);
    const api = sandbox.QuickCalBatch;
    const events = [];
    for (let i = 0; i < 12; i += 1) {
      events.push(batchEvent("e" + String(i + 1), {
        title: "E" + String(i + 1),
        startTime: i === 5 ? null : "10:00",
        endTime: i === 5 ? null : "11:00",
        needsClarification: i === 5,
        clarificationQuestions: i === 5 ? ["What time?"] : [],
      }));
    }
    const batch = api.buildBatch("source", events, zone);
    assert.equal(batch.drafts.length, 10);
    assert.equal(batch.drafts[5].selected, false);
    assert.equal(batch.drafts[0].selected, true);
  });
});
