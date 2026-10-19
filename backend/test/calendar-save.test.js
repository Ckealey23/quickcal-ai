import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadBackground(hooks) {
  const store = {};
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
        async getAuthToken() {
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
      if (String(url).includes("maxResults=1")) {
        return { ok: true, status: 200, async json() { return { kind: "calendar#events" }; } };
      }
      if (String(url).includes("revoke")) {
        return { ok: true, status: 200, async json() { return {}; } };
      }
      if ((options || {}).method === "PATCH") {
        hooks.patches = hooks.patches || [];
        hooks.patchBodies = hooks.patchBodies || [];
        hooks.patches.push(String(url));
        const body = JSON.parse(options.body);
        hooks.patchBodies.push(body);
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
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: body.id,
              summary: body.summary,
              htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
              status: "confirmed",
            };
          },
        };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
    console,
    URL,
    Intl,
    Date,
    JSON,
    Math,
    Number,
    String,
    crypto,
    AbortSignal,
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
    assert.equal(Object.hasOwn(updated, "id"), false);

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
    assert.equal(Object.hasOwn(active.event, "id"), false);
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
