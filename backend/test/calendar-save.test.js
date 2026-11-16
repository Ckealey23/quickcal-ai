import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";
import { applySchedule, applyClarification } from "../src/schedule.js";

const root = path.resolve(import.meta.dirname, "../..");
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadBackground(hooks) {
  const store = hooks.store || {};
  const calendar = hooks.calendar || (hooks.calendar = new Map());
  const fetches = [];
  let releasePost = null;
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) {
          return "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/" + file;
        },
        onMessage: {
          addListener(listener) {
            listeners.message = listener;
          },
        },
        onInstalled: { addListener() {} },
        async openOptionsPage() {
          hooks.opened = true;
        },
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
        async getAuthToken(details) {
          hooks.tokenCalls = hooks.tokenCalls || [];
          hooks.tokenCalls.push(!!(details && details.interactive));
          if (hooks.disconnected) return "";
          return "test-token";
        },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: async (url, options) => {
      fetches.push({ url: String(url), options: options || {} });
      if (String(url).includes("127.0.0.1")) throw new Error("parser called");
      if (String(url).includes("/parse-event")) {
        const body = hooks.parseBody || {};
        return { ok: true, status: 200, async json() { return body; } };
      }
      if (String(url).includes("/access")) {
        const status = hooks.accessStatus == null ? 200 : hooks.accessStatus;
        const body = hooks.accessBody || { ok: true, approved: true };
        return { ok: status === 200, status: status, async json() { return body; } };
      }
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
        return { ok: true, status: 200, async json() { return { items: [] }; } };
      }
      if (String(url).includes("maxResults=1")) {
        if (hooks.calendarNetwork) throw new TypeError("Failed to fetch");
        if (hooks.calendarStatus) {
          return { ok: false, status: hooks.calendarStatus, async json() { return {}; } };
        }
        return { ok: true, status: 200, async json() { return { kind: "calendar#events" }; } };
      }
      if (String(url).includes("revoke")) {
        return { ok: true, status: 200, async json() { return {}; } };
      }
      if (String(url).includes("/events/") && (options || {}).method === "GET") {
        if (hooks.eventReadNetwork) throw new TypeError("Failed to fetch");
        const id = decodeURIComponent(new URL(url).pathname.split("/events/")[1]);
        const body = calendar.get(id);
        return { ok: !!body, status: body ? 200 : 404, async json() { return body || {}; } };
      }
      if ((options || {}).method === "PATCH") {
        hooks.patches = hooks.patches || [];
        hooks.patchBodies = hooks.patchBodies || [];
        hooks.patches.push(String(url));
        const body = JSON.parse(options.body);
        hooks.patchBodies.push(body);
        if (body.attendees) {
          if (hooks.inviteStatus) return { ok: false, status: hooks.inviteStatus, async json() { return {}; } };
          const id = decodeURIComponent(new URL(url).pathname.split("/events/")[1]);
          const current = calendar.get(id);
          const saved = { ...current, attendees: body.attendees };
          if (!hooks.inviteMismatch) calendar.set(id, saved);
          if (hooks.inviteNetwork) throw new TypeError("Failed to fetch");
          return { ok: true, status: 200, async json() { return hooks.inviteMismatch ? current : saved; } };
        }
        if (hooks.failPatch) {
          return { ok: false, status: 403, async json() { return {}; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: body.id,
              summary: body.summary,
              htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
              status: "confirmed",
              reminders: hooks.mismatchReminders ? { useDefault: false, overrides: [] } : body.reminders,
            };
          },
        };
      }
      if ((options || {}).method === "POST") {
        hooks.posts += 1;
        const body = JSON.parse(options.body);
        hooks.ids.push(body.id);
        hooks.bodies.push(body);
        if (hooks.holdPost) {
          await new Promise((resolve) => {
            releasePost = resolve;
          });
        }
        if (hooks.failPost) {
          return { ok: false, status: 403, async json() { return {}; } };
        }
        if (hooks.mismatch) {
          return {
            ok: true,
            status: 200,
            async json() {
              return { id: body.id, summary: "Different", htmlLink: "https://calendar.google.com/calendar/event?eid=abc", status: "confirmed" };
            },
          };
        }
        const saved = {
          id: body.id,
          summary: body.summary,
          htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
          status: "confirmed",
          reminders: hooks.mismatchReminders ? { useDefault: false, overrides: [] } : body.reminders,
        };
        calendar.set(body.id, saved);
        return {
          ok: true,
          status: 200,
          async json() {
            return saved;
          },
        };
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
  return {
    listener: listeners.message,
    fetches,
    store,
    release() {
      if (releasePost) releasePost();
    },
  };
}

function sender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    tab: { id: 4 },
    url: "https://example.com/events",
  };
}

function draft() {
  return {
    title: "Coffee with Alex",
    date: "2026-10-17",
    endDate: "2026-10-17",
    startTime: "10:00",
    endTime: "11:00",
    timeZone: "America/Los_Angeles",
    location: "Avila",
    needsClarification: false,
    durationDefaulted: true,
    clarificationQuestions: [],
  };
}

function createMessage() {
  return { type: "quickcal-calendar", action: "create", event: draft(), url: "https://evil.example/insert" };
}

function weeklyDraft() {
  return {
    title: "Date with John",
    date: "2026-03-06",
    endDate: "2026-03-06",
    startTime: "18:00",
    endTime: "19:00",
    timeZone: "America/Los_Angeles",
    location: null,
    needsClarification: false,
    durationDefaulted: true,
    clarificationQuestions: [],
    recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
  };
}

describe("weekly calendar series", () => {
  it("recreates a deleted finite schedule, but never duplicates one still present", async () => {
    for (const deletedState of ["not-found", "cancelled"]) {
      const hooks = { posts: 0, ids: [], bodies: [] };
      const loaded = loadBackground(hooks);
      const event = applySchedule({ ...draft(), title: "Guitar practice", startTime: "09:00", endTime: "10:00", durationDefaulted: false },
        "Guitar practice every Mon/Wed/Fri in November 2026 except the 4th and 6th", { localDate: "2026-11-15", localTime: "12:00:00" });
      const submit = () => new Promise(resolve => loaded.listener({ type: "quickcal-calendar", action: "create", event }, sender(), resolve));
      assert.equal((await submit()).ok, true);
      const firstId = hooks.ids[0];
      assert.equal((await submit()).ok, true);
      assert.equal(hooks.posts, 1);
      if (deletedState === "not-found") hooks.calendar.delete(firstId);
      else hooks.calendar.set(firstId, { id: firstId, status: "cancelled" });
      assert.equal((await submit()).ok, true);
      assert.equal(hooks.posts, 2, "a deleted schedule requires a fresh Google insert");
      assert.notEqual(hooks.ids[1], firstId);
      assert.deepEqual(hooks.bodies[1].recurrence, hooks.bodies[0].recurrence);
      assert.equal((await submit()).ok, true);
      assert.equal(hooks.posts, 2);
    }
  });

  it("does not report cached success or create a duplicate when Google cannot be checked", async () => {
    const hooks = { posts: 0, ids: [], bodies: [] };
    const loaded = loadBackground(hooks);
    const submit = () => new Promise(resolve => loaded.listener(createMessage(), sender(), resolve));
    assert.equal((await submit()).ok, true);
    hooks.eventReadNetwork = true;
    const retry = await submit();
    assert.equal(retry.ok, false);
    assert.equal(hooks.posts, 1);
    hooks.eventReadNetwork = false;
    assert.equal((await submit()).ok, true);
    assert.equal(hooks.posts, 1);
  });
  it("sends exactly the resolved finite dates and shared time window to Calendar", async () => {
    for (const [text, startTime, endTime, expected] of [
      ["Walk the dog tmr through Saturday 9am–3pm", "09:00", "15:00", [12, 13, 14]],
      ["CPR training every m/w/f in November except the 4th", null, null, [2, 6, 9, 11, 13, 16, 18, 20, 23, 25, 27, 30]],
      ["Walk the dog every Tuesday in November 2026", null, null, [3, 10, 17, 24]],
    ]) {
      const clock = { localDate: "2026-11-11", localTime: "12:00:00" };
      let event = applySchedule({ ...draft(), title: "Activity", date: null, startTime, endTime, clarificationQuestions: [] }, text, clock);
      if (!startTime) event = applyClarification({ startTime: "09:00", endTime: "10:00", timeZone: event.timeZone }, event, "9am–10am", text, clock);
      const hooks = { posts: 0, ids: [], bodies: [], patches: [] };
      const loaded = loadBackground(hooks);
      const result = await new Promise((resolve) => loaded.listener({ type: "quickcal-calendar", action: "create", event }, sender(), resolve));
      assert.equal(result.ok, true);
      assert.equal(hooks.posts, 1);
      const body = hooks.bodies[0];
      assert.deepEqual(plain(body.recurrence), ["RDATE:" + expected.map((day) => "202611" + String(day).padStart(2, "0") + "T170000Z").join(",")]);
      assert.match(body.start.dateTime, /T09:00:00-08:00$/);
      assert.ok(body.end.dateTime.endsWith("T" + (endTime || "10:00") + ":00-08:00"));
      const retry = await new Promise((resolve) => loaded.listener({ type: "quickcal-calendar", action: "create", event }, sender(), resolve));
      assert.equal(retry.ok, true);
      assert.equal(hooks.posts, 1);
    }
  });
  it("creates one series, keeps 6 PM local across daylight saving, and does not duplicate it on retry", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [], holdPost: true };
    const loaded = loadBackground(hooks);
    const message = { type: "quickcal-calendar", action: "create", event: weeklyDraft() };
    const replies = [];
    loaded.listener(message, sender(), (result) => replies.push(result));
    loaded.listener(message, sender(), (result) => replies.push(result));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hooks.posts, 1);
    assert.equal(hooks.bodies[0].summary, "Date with John");
    assert.equal(Object.hasOwn(hooks.bodies[0], "attendees"), false);
    assert.equal(Object.hasOwn(hooks.bodies[0], "location"), false);
    assert.deepEqual(hooks.bodies[0].recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR"]);
    assert.equal(hooks.bodies[0].start.timeZone, "America/Los_Angeles");
    assert.equal(hooks.bodies[0].start.dateTime, "2026-03-06T18:00:00-08:00");
    assert.equal(hooks.bodies[0].end.dateTime, "2026-03-06T19:00:00-08:00");
    assert.match(loaded.fetches.find((call) => call.options.method === "POST").url, /sendUpdates=none/);
    loaded.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replies[0].dateText, "Mar 6, 2026");
    assert.equal(replies[0].timeText, "6:00\u20137:00 PM");
    assert.equal(replies[0].recurrenceText, "Every Friday");
    assert.equal(replies[0].seriesEndText, "No end date");

    const again = [];
    loaded.listener(message, sender(), (result) => again.push(result));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hooks.posts, 1);
    assert.equal(again[0].htmlLink, replies[0].htmlLink);

    hooks.failPost = true;
    const failedHooks = { posts: 0, ids: [], bodies: [], patches: [], failPost: true };
    const failed = loadBackground(failedHooks);
    let first;
    failed.listener(message, sender(), (result) => {
      first = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(first.ok, false);
    failedHooks.failPost = false;
    let second;
    failed.listener(message, sender(), (result) => {
      second = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(second.ok, true);
    assert.equal(failedHooks.ids[0], failedHooks.ids[1]);
    assert.equal(failedHooks.bodies.length, 2);
    assert.deepEqual(failedHooks.bodies[0].recurrence, failedHooks.bodies[1].recurrence);
  });

  it("patches one series when the edit names the entire series", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [], patchBodies: [] };
    const loaded = loadBackground(hooks);
    let created;
    loaded.listener({ type: "quickcal-calendar", action: "create", event: weeklyDraft() }, sender(), (result) => {
      created = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created.ok, true);
    const moved = weeklyDraft();
    moved.startTime = "19:00";
    moved.endTime = "20:00";
    moved.durationDefaulted = false;
    let updated;
    loaded.listener({ type: "quickcal-calendar", action: "update", event: moved }, sender(), (result) => {
      updated = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hooks.posts, 1);
    assert.equal(hooks.patches.length, 1);
    assert.equal(updated.startTime, "19:00");
    assert.deepEqual(hooks.patchBodies[0].recurrence, ["RRULE:FREQ=WEEKLY;INTERVAL=1;BYDAY=FR"]);
    assert.equal(hooks.patchBodies[0].start.dateTime, "2026-03-06T19:00:00-08:00");
  });
});

describe("widget calendar save", () => {
  it("carries a parsed 60-minute popup through to the Calendar request", async () => {
    const hooks = {
      posts: 0,
      ids: [],
      bodies: [],
      parseBody: {
        quickcalApiVersion: 5,
        intent: "create",
        quickcalRelease: "test-revision",
        title: "Meeting",
        date: "2026-10-27",
        endDate: "2026-10-27",
        startTime: "15:00",
        endTime: "16:00",
        timeZone: "America/Los_Angeles",
        location: null,
        recurrence: null,
        reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
        needsClarification: false,
        clarificationQuestions: [],
        durationDefaulted: true,
      },
    };
    const loaded = loadBackground(hooks);
    const parsed = await ask(
      loaded.listener,
      {
        type: "quickcal-parse",
        text: "Meeting tomorrow at 3 PM. Notify me 1 hour before it starts.",
        timeZone: "America/Los_Angeles",
      },
      sender(),
    );
    assert.equal(parsed.ok, true);
    const saved = await ask(
      loaded.listener,
      { type: "quickcal-calendar", action: "create", event: parsed.event },
      sender(),
    );
    assert.equal(saved.ok, true);
    assert.equal(hooks.posts, 1);
    assert.deepEqual(plain(hooks.bodies[0].reminders), {
      useDefault: false,
      overrides: [{ method: "popup", minutes: 60 }],
    });
    assert.equal(saved.remindersText, "Popup 1 hour before");
  });

  it("does not show success when Google confirms different notification settings", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [], mismatchReminders: true };
    const loaded = loadBackground(hooks);
    const initial = draft();
    initial.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] };
    const result = await ask(
      loaded.listener,
      { type: "quickcal-calendar", action: "create", event: initial },
      sender(),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /did not confirm/);
  });

  it("writes and confirms replacement, addition, removal, and default notifications", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [], patchBodies: [] };
    const loaded = loadBackground(hooks);
    const initial = draft();
    initial.reminders = { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] };
    const created = await ask(
      loaded.listener,
      { type: "quickcal-calendar", action: "create", event: initial },
      sender(),
    );
    assert.equal(created.ok, true);
    assert.deepEqual(plain(hooks.bodies[0].reminders), initial.reminders);
    assert.deepEqual(plain(created.reminders), initial.reminders);
    assert.equal(created.remindersText, "Popup 1 hour before");

    const added = { ...draft(), reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 10 },
      ],
    } };
    const addedResult = await ask(
      loaded.listener,
      { type: "quickcal-calendar", action: "update", event: added },
      sender(),
    );
    assert.equal(addedResult.ok, true);
    assert.deepEqual(plain(hooks.patchBodies[0].reminders), added.reminders);
    assert.equal(hooks.patchBodies[0].summary, initial.title);
    assert.equal(hooks.patchBodies[0].location, initial.location);

    const removed = { ...draft(), reminders: { useDefault: false, overrides: [] } };
    const removedResult = await ask(
      loaded.listener,
      { type: "quickcal-calendar", action: "update", event: removed },
      sender(),
    );
    assert.equal(removedResult.remindersText, "Notifications off");
    assert.deepEqual(plain(hooks.patchBodies[1].reminders), removed.reminders);

    const defaults = { ...draft(), reminders: { useDefault: true, overrides: [] } };
    const defaultResult = await ask(
      loaded.listener,
      { type: "quickcal-calendar", action: "update", event: defaults },
      sender(),
    );
    assert.equal(defaultResult.remindersText, "Calendar default notifications");
    assert.deepEqual(plain(hooks.patchBodies[2].reminders), defaults.reminders);
  });

  it("saves the live draft once and shows success only from Google's confirmation", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [], holdPost: true };
    const loaded = loadBackground(hooks);
    const replies = [];
    loaded.listener(createMessage(), sender(), (result) => replies.push(result));
    loaded.listener(createMessage(), sender(), (result) => replies.push(result));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hooks.posts, 1);
    assert.equal(replies.length, 0);
    assert.equal(hooks.bodies[0].summary, "Coffee with Alex");
    assert.equal(hooks.bodies[0].location, "Avila");
    assert.match(hooks.bodies[0].start.dateTime, /^2026-10-17T10:00:00-07:00$/);
    assert.match(hooks.bodies[0].end.dateTime, /^2026-10-17T11:00:00-07:00$/);
    assert.equal(hooks.bodies[0].summary === "QuickCalAI — Test Event", false);
    assert.equal(loaded.fetches.some((call) => call.url.includes("127.0.0.1")), false);
    loaded.release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(replies.length, 2);
    assert.equal(replies[0].ok, true);
    assert.equal(replies[0].summary, "Coffee with Alex");
    assert.equal(replies[0].dateText, "Oct 17, 2026");
    assert.equal(replies[0].timeText, "10:00\u201311:00 AM");
    assert.match(replies[0].htmlLink, /^https:\/\/calendar\.google\.com\//);
    assert.equal(replies[0].token, undefined);

    const again = [];
    loaded.listener(createMessage(), sender(), (result) => again.push(result));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hooks.posts, 1);
    assert.equal(again[0].ok, true);
    assert.equal(again[0].htmlLink, replies[0].htmlLink);
  });

  it("keeps the same event id after an error and does not confirm a mismatched response", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], failPost: true };
    const loaded = loadBackground(hooks);
    let failed;
    loaded.listener(createMessage(), sender(), (result) => {
      failed = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(failed.ok, false);
    assert.match(failed.error, /did not allow/);
    hooks.failPost = false;
    hooks.mismatch = true;
    let mismatched;
    loaded.listener(createMessage(), sender(), (result) => {
      mismatched = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(hooks.ids[0], hooks.ids[1]);
    assert.equal(mismatched.ok, false);
  });

  it("does not create an event when Calendar is disconnected", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], disconnected: true };
    const loaded = loadBackground(hooks);
    let reply;
    const keep = loaded.listener(createMessage(), sender(), (result) => {
      reply = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(keep, true);
    assert.equal(reply.state, "disconnected");
    assert.equal(hooks.posts, 0);
    assert.equal(loaded.listener({ type: "quickcal-auth", action: "connect" }, sender(), () => {}), false);
  });

  it("updates the saved event id and keeps the previous details when Google rejects the change", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [] };
    const loaded = loadBackground(hooks);
    let created;
    loaded.listener(createMessage(), sender(), (result) => {
      created = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created.ok, true);
    assert.equal(hooks.posts, 1);
    const moved = draft();
    moved.startTime = "11:00";
    moved.endTime = "11:30";
    moved.durationDefaulted = false;
    let updated;
    loaded.listener({ type: "quickcal-calendar", action: "update", event: moved }, sender(), (result) => {
      updated = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(hooks.posts, 1);
    assert.equal(hooks.patches.length, 1);
    assert.match(hooks.patches[0], new RegExp("/" + hooks.ids[0] + "\\?"));
    assert.equal(updated.startTime, "11:00");
    assert.equal(updated.endTime, "11:30");
    assert.equal(updated.id, hooks.ids[0]);

    hooks.failPatch = true;
    const rejected = draft();
    rejected.startTime = "12:00";
    rejected.endTime = "12:30";
    rejected.durationDefaulted = false;
    let failed;
    loaded.listener({ type: "quickcal-calendar", action: "update", event: rejected }, sender(), (result) => {
      failed = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(failed.ok, false);
    assert.equal(hooks.posts, 1);
    let active;
    loaded.listener({ type: "quickcal-calendar", action: "active" }, sender(), (result) => {
      active = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(active.event.startTime, "11:00");
    assert.equal(active.event.endTime, "11:30");
    assert.equal(active.event.id, hooks.ids[0]);
  });

  it("clears the editable event when Calendar is disconnected", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], patches: [] };
    const loaded = loadBackground(hooks);
    let created;
    loaded.listener(createMessage(), sender(), (result) => {
      created = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(created.ok, true);
    let disconnected;
    loaded.listener(
      { type: "quickcal-auth", action: "disconnect" },
      {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        url: "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/options/options.html",
      },
      (result) => {
        disconnected = result;
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(disconnected.state, "disconnected");
    let active;
    loaded.listener({ type: "quickcal-calendar", action: "active" }, sender(), (result) => {
      active = result;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(active.event, null);
  });
});

function optionsSender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    url: "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/options/options.html",
  };
}

function ask(listener, message, from) {
  return new Promise((resolve) => {
    const keep = listener(message, from, resolve);
    if (keep !== true) resolve(undefined);
  });
}

describe("hosted calendar authorization", () => {
  it("saves from the widget after options connect when the account is approved", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], tokenCalls: [] };
    const loaded = loadBackground(hooks);
    const connected = await ask(loaded.listener, { type: "quickcal-auth", action: "connect" }, optionsSender());
    assert.equal(connected.state, "ready");
    assert.equal(connected.googleConnected, true);
    assert.equal(hooks.tokenCalls.includes(true), true);
    assert.equal(loaded.store.quickcalCalendarSuppressed, false);
    const interactive = hooks.tokenCalls.filter(Boolean).length;

    const saved = await ask(loaded.listener, createMessage(), sender());
    assert.equal(saved.ok, true);
    assert.equal(saved.summary, "Coffee with Alex");
    assert.equal(hooks.posts, 1);
    assert.equal(hooks.tokenCalls.filter(Boolean).length, interactive);
    assert.equal(loaded.fetches.some((call) => String(call.url).endsWith("/parse-event")), false);
    assert.equal(loaded.fetches.some((call) => String(call.url).endsWith("/access")), true);
  });

  it("saves the same draft after the service worker restarts", async () => {
    const store = {};
    const hooks = { posts: 0, ids: [], bodies: [], tokenCalls: [], store: store, failPost: true };
    const first = loadBackground(hooks);
    const connected = await ask(first.listener, { type: "quickcal-auth", action: "connect" }, optionsSender());
    assert.equal(connected.state, "ready");
    const failed = await ask(first.listener, createMessage(), sender());
    assert.equal(failed.ok, false);
    assert.match(failed.error, /did not allow/);
    assert.equal(failed.state, undefined);
    assert.equal(hooks.posts, 1);

    hooks.failPost = false;
    hooks.tokenCalls = [];
    const restarted = loadBackground(hooks);
    const saved = await ask(restarted.listener, createMessage(), sender());
    assert.equal(saved.ok, true);
    assert.equal(hooks.posts, 2);
    assert.equal(hooks.ids[0], hooks.ids[1]);
    assert.equal(hooks.tokenCalls.includes(true), false);
    assert.equal(restarted.fetches.some((call) => String(call.url).endsWith("/parse-event")), false);
    assert.equal(store.quickcalDraftEvent.id, hooks.ids[0]);
    assert.equal(store.quickcalDraftEvent.phase, "created");
  });

  it("keeps the widget disconnected after Disconnect", async () => {
    const hooks = { posts: 0, ids: [], bodies: [], tokenCalls: [] };
    const loaded = loadBackground(hooks);
    await ask(loaded.listener, { type: "quickcal-auth", action: "connect" }, optionsSender());
    const disconnected = await ask(loaded.listener, { type: "quickcal-auth", action: "disconnect" }, optionsSender());
    assert.equal(disconnected.state, "disconnected");
    assert.equal(loaded.store.quickcalCalendarSuppressed, true);
    const calls = hooks.tokenCalls.length;

    const status = await ask(loaded.listener, { type: "quickcal-calendar", action: "status" }, sender());
    const saved = await ask(loaded.listener, createMessage(), sender());
    assert.equal(status.connected, false);
    assert.equal(saved.ok, false);
    assert.equal(saved.state, "disconnected");
    assert.match(saved.error, /Connect Google Calendar before saving/);
    assert.equal(hooks.posts, 0);
    assert.equal(hooks.tokenCalls.length, calls);
  });

  it("does not describe a Calendar or backend failure as a missing connection", async () => {
    const denied = { posts: 0, ids: [], bodies: [], calendarStatus: 403 };
    const deniedLoad = loadBackground(denied);
    const permission = await ask(deniedLoad.listener, createMessage(), sender());
    assert.equal(permission.ok, false);
    assert.equal(permission.state, undefined);
    assert.match(permission.error, /did not allow QuickCalAI to access Calendar/);
    assert.equal(denied.posts, 0);

    const offline = { posts: 0, ids: [], bodies: [], calendarNetwork: true };
    const offlineLoad = loadBackground(offline);
    const network = await ask(offlineLoad.listener, createMessage(), sender());
    assert.equal(network.state, undefined);
    assert.match(network.error, /could not reach Google Calendar/);
    assert.equal(offline.posts, 0);

    const backend = { posts: 0, ids: [], bodies: [], accessStatus: 503 };
    const backendLoad = loadBackground(backend);
    const saved = await ask(backendLoad.listener, createMessage(), sender());
    assert.equal(saved.ok, true);
    assert.equal(backend.posts, 1);
  });
});


describe("saved event invitations", () => {
  async function setup() {
    const hooks = { posts: 0, ids: [], bodies: [] };
    const loaded = loadBackground(hooks);
    const request = (message, from = sender()) => new Promise(resolve => loaded.listener(message, from, resolve));
    const saved = await request(createMessage());
    assert.equal(saved.ok, true);
    const record = hooks.calendar.get(saved.id);
    record.etag = '"version-1"';
    record.attendees = [{ email: "existing@gmail.com", responseStatus: "accepted" }];
    const invite = (email, extra = {}) => request({ type: "quickcal-calendar", action: "invite", eventId: saved.id, email, ...extra });
    return { hooks, loaded, saved, invite };
  }

  it("sends an invitation for the saved event, preserves guests, and avoids duplicates", async () => {
    const { hooks, loaded, saved, invite } = await setup();
    const result = await invite(" New.Guest@gmail.com ");
    assert.equal(result.ok, true);
    assert.equal(result.email, "new.guest@gmail.com");
    assert.equal(hooks.posts, 1);
    assert.deepEqual(hooks.patchBodies[0], { attendees: [
      { email: "existing@gmail.com", responseStatus: "accepted" }, { email: "new.guest@gmail.com" },
    ] });
    const patch = loaded.fetches.find(call => call.options.method === "PATCH");
    assert.equal(new URL(patch.url).searchParams.get("sendUpdates"), "all");
    assert.equal(patch.options.headers["If-Match"], '"version-1"');
    assert.ok(patch.url.includes(saved.id));
    assert.equal((await invite("NEW.GUEST@gmail.com")).alreadyInvited, true);
    assert.equal(hooks.patches.length, 1);
    // A worker restart still checks Google instead of sending a second email.
    const restarted = loadBackground({ ...hooks, store: loaded.store });
    const again = await new Promise(resolve => restarted.listener({ type: "quickcal-calendar", action: "invite", eventId: saved.id, email: "new.guest@gmail.com" }, sender(), resolve));
    assert.equal(again.alreadyInvited, true);
  });

  it("serializes simultaneous sends without losing guests", async () => {
    const { hooks, invite } = await setup();
    const results = await Promise.all([invite("one@gmail.com"), invite("two@gmail.com"), invite("one@gmail.com")]);
    assert.ok(results.every(result => result.ok));
    assert.equal(hooks.patches.length, 2);
    assert.deepEqual(hooks.patchBodies[1].attendees.map(guest => guest.email), ["existing@gmail.com", "one@gmail.com", "two@gmail.com"]);
  });

  it("rejects invalid emails, stale event IDs, and arbitrary calendars without writing", async () => {
    const { hooks, loaded, invite } = await setup();
    for (const email of ["", "not-an-email", "one@gmail.com,two@gmail.com", "a@b.com\r\nBcc:evil@b.com"]) {
      assert.equal((await invite(email)).ok, false);
    }
    assert.equal((await invite("new@gmail.com", { eventId: "some-other-event" })).ok, false);
    assert.equal((await invite("new@gmail.com", { calendarId: "someone-else@gmail.com" })).ok, false);
    assert.equal(hooks.patches, undefined);
    assert.equal(loaded.listener({ type: "quickcal-calendar", action: "invite" }, { ...sender(), id: "other-extension" }, () => {}), false);
  });

  it("blocks deleted, disconnected, unapproved, and incomplete guest-list sends", async () => {
    for (const condition of ["deleted", "cancelled", "disconnected", "unapproved", "incomplete", "offline"]) {
      const { hooks, saved, invite } = await setup();
      if (condition === "deleted") hooks.calendar.delete(saved.id);
      if (condition === "cancelled") hooks.calendar.get(saved.id).status = "cancelled";
      if (condition === "disconnected") hooks.disconnected = true;
      if (condition === "unapproved") hooks.accessStatus = 403;
      if (condition === "incomplete") hooks.calendar.get(saved.id).attendeesOmitted = true;
      if (condition === "offline") hooks.eventReadNetwork = true;
      assert.equal((await invite("new@gmail.com")).ok, false, condition);
      assert.equal(hooks.patches, undefined, condition);
    }
  });

  it("reports failures and unconfirmed responses without claiming an invitation was sent", async () => {
    for (const status of [403, 412, 500, "mismatch"]) {
      const { hooks, invite } = await setup();
      if (status === "mismatch") hooks.inviteMismatch = true;
      else hooks.inviteStatus = status;
      const result = await invite("new@gmail.com");
      assert.equal(result.ok, false);
      assert.ok(result.error);
      assert.equal(hooks.patches.length, 1);
    }
  });

  it("does not send a duplicate after a lost successful response", async () => {
    const { hooks, invite } = await setup();
    hooks.inviteNetwork = true;
    assert.equal((await invite("new@gmail.com")).ok, false);
    hooks.inviteNetwork = false;
    assert.equal((await invite("new@gmail.com")).alreadyInvited, true);
    assert.equal(hooks.patches.length, 1);
  });
});
