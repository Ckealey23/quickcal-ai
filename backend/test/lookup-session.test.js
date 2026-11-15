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
    htmlLink: "https://calendar.google.com/calendar/event?eid=" + encodeURIComponent(id),
    start: { dateTime: start, timeZone: zone },
    end: { dateTime: end, timeZone: zone },
    attendees: [{ email: "steve@example.com", displayName: "Steve" }],
  }, extra || {});
}

const steveEarly = eventItem("series_20261029T000000Z", "Meeting with Steve", "2026-10-29T00:00:00.000Z", "2026-10-29T01:00:00.000Z", {
  recurringEventId: "series",
});
const steveLater = eventItem("other", "Meeting with Steve", "2026-10-29T02:00:00.000Z", "2026-10-29T03:00:00.000Z");

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
      if (target.includes("/parse-event")) {
        hooks.parses = hooks.parses || [];
        hooks.parses.push(requestBody);
        const interpreted = (hooks.interpret || defaultInterpret)(requestBody);
        return {
          ok: true,
          status: 200,
          async json() {
            return interpreted || {
              quickcalApiVersion: 3,
              intent: "clarify",
              timeZone: zone,
              needsClarification: true,
              clarificationQuestions: ["What should I change?"],
              operation: {
                target: null,
                searchDate: null,
                searchTime: null,
                destinationDate: null,
                destinationTime: null,
                destinationEndTime: null,
                scope: "occurrence",
                selection: [],
              },
            };
          },
        };
      }
      if (hooks.fail === "network" && method !== "GET" && method !== "PATCH") throw new TypeError("Failed to fetch");
      if (target.includes("singleEvents=true")) {
        return { ok: true, status: 200, async json() { return { items: hooks.items || [] }; } };
      }
      const id = decodeURIComponent(target.split("/events/")[1].split("?")[0]);
      const listed = (hooks.items || []).find((item) => item.id === id);
      if (method === "GET") {
        hooks.gets = (hooks.gets || 0) + 1;
        const found = hooks.gets > 1 && hooks.afterFailure && hooks.afterFailure.id === id
          ? hooks.afterFailure
          : (hooks.changed && hooks.changed.id === id ? hooks.changed : listed);
        if (!found || hooks.missing) return { ok: false, status: 404, async json() { return {}; } };
        return { ok: true, status: 200, async json() { return found; } };
      }
      if (method === "PATCH") {
        hooks.patches.push({ id: id, body: JSON.parse(options.body) });
        if (hooks.fail === "network") throw new TypeError("Failed to fetch");
        if (hooks.hold) await new Promise((resolve) => { hooks.release = resolve; });
        return {
          ok: true,
          status: 200,
          async json() {
            return Object.assign({}, listed || steveEarly, JSON.parse(options.body), { id: id, status: "confirmed" });
          },
        };
      }
      if (method === "DELETE") {
        hooks.deletes.push(id);
        if (hooks.failIds && hooks.failIds.indexOf(id) !== -1) {
          return { ok: false, status: 500, async json() { return {}; } };
        }
        if (hooks.hold) await new Promise((resolve) => { hooks.release = resolve; });
        return { ok: true, status: 204, async json() { return {}; } };
      }
      if (method === "POST") {
        hooks.posts.push(target);
        return { ok: true, status: 200, async json() { return {}; } };
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
  return {
    listener: listeners.message,
    sessionStore: sessionStore,
  };
}

function operationFields(fields) {
  return Object.assign({
    target: null,
    searchDate: null,
    searchTime: null,
    destinationDate: null,
    destinationTime: null,
    destinationEndTime: null,
    scope: "occurrence",
    selection: [],
  }, fields || {});
}

function interpreted(intent, fields) {
  return {
    quickcalApiVersion: 3,
    quickcalRelease: "test",
    intent: intent,
    timeZone: zone,
    needsClarification: intent === "clarify",
    clarificationQuestions: intent === "clarify" ? ["What should I change?"] : [],
    operation: operationFields(fields),
  };
}

function defaultInterpret(request) {
  const text = request && request.text || "";
  const pending = request && request.operation;
  if (pending && pending.candidates && pending.candidates.length && /^(both|all listed|the second one)$/i.test(text.trim())) {
    return interpreted(pending.intent || "move", {
      selection: /second/i.test(text) ? ["c2"] : ["all"],
    });
  }
  if (/remove|delete|cancel/i.test(text)) {
    return interpreted("delete", {
      target: "Steve",
      searchTime: /5\s*PM/i.test(text) ? "17:00" : null,
    });
  }
  return interpreted("move", {
    target: /steve/i.test(text) ? "Steve" : null,
    searchTime: /5\s*PM/i.test(text) ? "17:00" : null,
    destinationTime: /8\s*PM/i.test(text) ? "20:00" : /7\s*PM/i.test(text) ? "19:00" : null,
  });
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

describe("calendar lookup through the service worker", () => {
  it("moves one occurrence, confirms deletion once, and does not repeat a mutation", async () => {
    const hooks = { calls: [], patches: [], deletes: [], posts: [], items: [steveEarly, steveLater] };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const moved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my 5 PM meeting with Steve to 7 PM",
      timeZone: zone,
      operationId: "move-1",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(moved.session.mode, "saved");
    assert.equal(moved.session.savedRecord.changeText, "Moved from 5:00–6:00 PM to 7:00–8:00 PM");
    assert.equal(hooks.patches.length, 1);
    assert.equal(hooks.patches[0].id, "series_20261029T000000Z");
    assert.equal(hooks.patches[0].body.summary, undefined);
    assert.equal(hooks.posts.length, 0);
    assert.equal(hooks.patches[0].body.start.dateTime.includes("2026-10-29T02:00:00"), true);
    const before = hooks.calls.length;
    const snapshot = await send(background.listener, { type: "quickcal-widget", action: "snapshot" }, 9);
    assert.equal(snapshot.session.savedRecord.summary, "Meeting with Steve");
    assert.equal(hooks.calls.length, before);

    hooks.patches.length = 0;
    const ambiguous = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my meeting with Steve to 8 PM",
      timeZone: zone,
      operationId: "move-2",
      sessionId: snapshot.session.sessionId,
    });
    assert.equal(ambiguous.session.mode, "choosing");
    assert.equal(ambiguous.session.lookup.candidates.length, 2);
    assert.equal(hooks.patches.length, 0);
    const both = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "both",
      timeZone: zone,
      operationId: "move-3",
      sessionId: ambiguous.session.sessionId,
    }, 9);
    assert.equal(hooks.patches.length, 2);
    assert.equal([].join.call(hooks.patches.map((item) => item.id)), "series_20261029T000000Z,other");

    hooks.deletes.length = 0;
    const asked = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Remove my 5 PM meeting with Steve",
      timeZone: zone,
      operationId: "delete-1",
      sessionId: both.session.sessionId,
    });
    assert.equal(asked.session.mode, "confirming");
    assert.equal(hooks.deletes.length, 0);
    hooks.hold = true;
    const firstConfirm = send(background.listener, {
      type: "quickcal-widget",
      action: "confirm",
      operationId: "delete-confirm",
      sessionId: asked.session.sessionId,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await send(background.listener, {
      type: "quickcal-widget",
      action: "confirm",
      operationId: "delete-confirm-2",
      sessionId: asked.session.sessionId,
    }, 9);
    assert.equal(second.ignored, true);
    hooks.release();
    const deleted = await firstConfirm;
    assert.match(deleted.session.statusText, /Deleted Meeting with Steve/);
    assert.equal(hooks.deletes.length, 1);
    assert.equal(hooks.deletes[0], "series_20261029T000000Z");
  });

  it("does not patch an event whose details changed", async () => {
    const changed = eventItem("series_20261029T000000Z", "Meeting with Steve", "2026-10-29T02:00:00.000Z", "2026-10-29T03:00:00.000Z", {
      recurringEventId: "series",
    });
    const hooks = { calls: [], patches: [], deletes: [], posts: [], items: [steveEarly], changed: changed };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const result = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my 5 PM meeting with Steve to 7 PM",
      timeZone: zone,
      operationId: "stale-1",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(hooks.patches.length, 0);
    assert.equal(result.session.mode, "confirming");
    assert.match(result.session.lookup.prompt, /changed/);
  });

  it("asks for a date when today has no match and reconciles a lost patch response", async () => {
    const moved = eventItem("series_20261029T000000Z", "Meeting with Steve", "2026-10-29T02:00:00.000Z", "2026-10-29T03:00:00.000Z", {
      recurringEventId: "series",
    });
    const hooks = { calls: [], patches: [], deletes: [], posts: [], items: [moved] };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const none = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my 5 PM meeting with Steve to 7 PM",
      timeZone: zone,
      operationId: "none-1",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(hooks.patches.length, 0);
    assert.match(none.session.lookup.prompt, /today/);
    assert.match(none.session.lookup.prompt, /What date/);

    const cleared = await send(background.listener, {
      type: "quickcal-widget",
      action: "cancel-lookup",
      sessionId: none.session.sessionId,
    });
    hooks.items = [steveEarly];
    hooks.fail = "network";
    hooks.afterFailure = moved;
    hooks.gets = 0;
    const recovered = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my 5 PM meeting with Steve to 7 PM",
      timeZone: zone,
      operationId: "recover-1",
      sessionId: none.session.sessionId,
    });
    assert.equal(hooks.patches.length, 1);
    assert.equal(recovered.session.mode, "saved");
    assert.match(recovered.session.savedRecord.changeText, /Moved from/);
  });

  it("retries only the event a partial deletion did not remove", async () => {
    const hooks = { calls: [], patches: [], deletes: [], posts: [], items: [steveEarly, steveLater], failIds: ["other"] };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const asked = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Remove my meeting with Steve",
      timeZone: zone,
      operationId: "partial-ask",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(asked.session.mode, "choosing");
    const confirmed = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "both",
      timeZone: zone,
      operationId: "partial-both",
      sessionId: asked.session.sessionId,
    });
    assert.equal(confirmed.session.mode, "confirming");
    assert.equal(confirmed.session.lookup.candidates.length, 2);
    const done = await send(background.listener, {
      type: "quickcal-widget",
      action: "confirm",
      operationId: "partial-confirm",
      sessionId: confirmed.session.sessionId,
    });
    assert.match(done.session.statusText, /Deleted Meeting with Steve/);
    assert.match(done.session.statusText, /Could not delete/);
    assert.equal(done.session.lookup.candidates.length, 1);
    assert.equal(done.session.lookup.candidates[0].id, "other");
    hooks.failIds = [];
    hooks.deletes.length = 0;
    const retried = await send(background.listener, {
      type: "quickcal-widget",
      action: "confirm",
      operationId: "partial-retry",
      sessionId: done.session.sessionId,
    });
    assert.equal([].join.call(hooks.deletes), "other");
    assert.match(retried.session.statusText, /Deleted Meeting with Steve/);
    assert.equal(retried.session.lookup, null);
  });

  it("keeps a move and searches the date the model supplies", async () => {
    const tuesday = eventItem("tuesday-steve", "Catch-up with Steve", "2026-11-04T01:00:00.000Z", "2026-11-04T02:00:00.000Z");
    const past = eventItem("past-steve", "Catch-up with Steve", "2026-10-21T00:00:00.000Z", "2026-10-21T01:00:00.000Z");
    const hooks = { calls: [], patches: [], deletes: [], posts: [], items: [tuesday, past] };
    hooks.interpret = (request) => {
      const text = request.text;
      if (text === "Next Tuesday") {
        return interpreted("move", { searchDate: "2026-11-03" });
      }
      if (text === "Actually, I meant Wednesday.") {
        return interpreted("move", { searchDate: "2026-11-04" });
      }
      if (text === "the second one") return interpreted("move", { selection: ["c2"] });
      if (text === "Can you push Tuesday's catch-up with Steve back to seven?") {
        return interpreted("move", { target: "Steve", searchDate: "2026-11-03", destinationTime: "19:00" });
      }
      if (text === "Move Tuesday's 5 PM meeting to Wednesday at 7 PM") {
        return interpreted("move", {
          target: "Steve",
          searchDate: "2026-11-03",
          searchTime: "17:00",
          destinationDate: "2026-11-04",
          destinationTime: "19:00",
        });
      }
      if (text === "Cancel my dentist appointment this Friday") {
        return interpreted("delete", { target: "Dentist" });
      }
      if (text === "Next Friday") return interpreted("delete", { searchDate: "2026-10-30" });
      if (text === "last Tuesday") return interpreted("find", { target: "Steve", searchDate: "2026-10-20" });
      return interpreted("move", { target: "Steve", destinationTime: "19:00" });
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const asked = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my meeting with Steve to 7 PM.",
      timeZone: zone,
      operationId: "ask-date",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(hooks.patches.length, 0);
    assert.equal(asked.session.lookup.awaiting, "searchDate");
    assert.equal(asked.session.lookup.query.newStartTime, "19:00");
    assert.equal(hooks.parses[0].operation, undefined);
    const followed = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Next Tuesday",
      timeZone: zone,
      operationId: "next-tuesday",
      sessionId: asked.session.sessionId,
    });
    assert.equal(hooks.parses[1].operation.destinationTime, "19:00");
    assert.equal(hooks.parses[1].operation.target, "Steve");
    assert.equal(JSON.stringify(hooks.parses[1]).includes("tuesday-steve"), false);
    assert.equal(hooks.patches.length, 1);
    assert.equal(hooks.patches[0].id, "tuesday-steve");
    assert.equal(hooks.patches[0].body.start.dateTime.includes("2026-11-04T03:00:00"), true);
    assert.equal(hooks.posts.length, 0);
    const lists = hooks.calls.filter((call) => call.url.includes("singleEvents=true"));
    assert.equal(decodeURIComponent(lists[lists.length - 1].url).includes("timeMin=2026-11-03T08:00:00.000Z"), true);

    hooks.patches.length = 0;
    hooks.items = [tuesday];
    const varied = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Can you push Tuesday's catch-up with Steve back to seven?",
      timeZone: zone,
      operationId: "push",
      sessionId: followed.session.sessionId,
    });
    assert.equal(hooks.parses[hooks.parses.length - 1].text, "Can you push Tuesday's catch-up with Steve back to seven?");
    assert.equal(varied.session.mode, "saved");
    assert.equal(hooks.posts.length, 0);

    hooks.patches.length = 0;
    const shifted = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move Tuesday's 5 PM meeting to Wednesday at 7 PM",
      timeZone: zone,
      operationId: "shift",
      sessionId: varied.session.sessionId,
    });
    assert.equal(hooks.patches.length, 1);
    assert.equal(hooks.patches[0].body.start.dateTime.includes("2026-11-05T03:00:00"), true);
    assert.equal(shifted.session.savedRecord.date, "2026-11-04");

    hooks.patches.length = 0;
    hooks.items = [past];
    const older = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "last Tuesday",
      timeZone: zone,
      operationId: "past",
      sessionId: shifted.session.sessionId,
    });
    const pastList = hooks.calls.filter((call) => decodeURIComponent(call.url).includes("timeMin=2026-10-20T07:00:00.000Z"));
    assert.equal(pastList.length > 0, true);
    assert.equal(hooks.patches.length, 0);
    assert.match(older.session.lookup.lines[0], /Catch-up with Steve/);

    const before = hooks.calls.length;
    const otherTab = await send(background.listener, { type: "quickcal-widget", action: "snapshot" }, 9);
    assert.equal(otherTab.session.lookup.candidates[0].id, "past-steve");
    assert.equal(hooks.calls.length, before);
  });

  it("confirms deletion only after the date answer, and edits the saved event on a follow-up", async () => {
    const friday = eventItem("dentist", "Dentist", "2026-10-30T22:00:00.000Z", "2026-10-30T23:00:00.000Z");
    const hooks = { calls: [], patches: [], deletes: [], posts: [], items: [steveEarly] };
    hooks.interpret = (request) => {
      if (request.text === "make it 7 PM") {
        return {
          quickcalApiVersion: 3,
          intent: "edit",
          title: "Meeting with Steve",
          date: "2026-10-28",
          startTime: "19:00",
          endTime: "20:00",
          timeZone: zone,
          location: null,
          reminders: { useDefault: false, overrides: [] },
          needsClarification: false,
          clarificationQuestions: [],
          durationDefaulted: false,
        };
      }
      if (request.text === "Cancel my dentist appointment this Friday") {
        return interpreted("delete", { target: "Dentist", searchDate: "2026-10-30" });
      }
      if (request.text === "Next Friday") return interpreted("delete", { searchDate: "2026-10-30" });
      if (request.text === "the second one") return interpreted(request.operation.intent, { selection: ["c2"] });
      if (request.text === "both") return interpreted(request.operation.intent, { selection: ["all"] });
      return interpreted("move", { target: "Steve", searchTime: "17:00", destinationTime: "19:00" });
    };
    const background = loadBackground(hooks);
    await send(background.listener, { type: "quickcal-widget", action: "show" });
    const moved = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Move my 5 PM meeting with Steve to 7 PM",
      timeZone: zone,
      operationId: "edit-setup",
      sessionId: background.sessionStore.quickcalWidgetSession.sessionId,
    });
    assert.equal(moved.session.mode, "saved");
    const follow = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "make it 7 PM",
      timeZone: zone,
      operationId: "edit-follow",
      sessionId: moved.session.sessionId,
    });
    const editRequest = hooks.parses[hooks.parses.length - 1];
    assert.equal(editRequest.currentEvent.title, "Meeting with Steve");
    assert.equal(editRequest.operation, undefined);
    assert.equal(follow.session.lookup, null);

    hooks.items = [friday, steveLater];
    hooks.deletes.length = 0;
    const dated = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Cancel my dentist appointment this Friday",
      timeZone: zone,
      operationId: "delete-date",
      sessionId: follow.session.sessionId,
    });
    assert.equal(hooks.deletes.length, 0);
    assert.equal(dated.session.mode, "confirming");
    const typed = await send(background.listener, {
      type: "quickcal-widget",
      action: "submit",
      text: "Next Friday",
      timeZone: zone,
      operationId: "delete-typed",
      sessionId: dated.session.sessionId,
    });
    assert.equal(hooks.deletes.length, 0);
    assert.equal(typed.session.mode, "confirming");
    const removed = await send(background.listener, {
      type: "quickcal-widget",
      action: "confirm",
      operationId: "delete-enter",
      sessionId: typed.session.sessionId,
    });
    assert.equal(hooks.deletes.length, 1);
    assert.equal(hooks.deletes[0], "dentist");
    assert.match(removed.session.statusText, /Deleted Dentist/);
  });
});
