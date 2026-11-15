import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../..");
const extensionOrigin = "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf";

function loadBackground(fetchImpl) {
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) {
          return extensionOrigin + "/" + file;
        },
        onMessage: {
          addListener(listener) {
            listeners.message = listener;
          },
        },
        onInstalled: { addListener() {} },
      },
      scripting: { executeScript() { return Promise.resolve(); } },
      storage: {
        local: {
          async get() { return {}; },
          async set() {},
          async remove() {},
        },
      },
      identity: {
        async getAuthToken() {
          return "ya29.extension-test-token";
        },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: fetchImpl,
    console,
    URL,
    Intl,
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
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, {
    filename: "background.js",
  });
  return { listeners, sandbox };
}

function contentSender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    tab: { id: 7 },
    url: "https://example.com/page",
  };
}

function listen(fetchImpl) {
  const loaded = loadBackground(fetchImpl);
  return loaded.listeners.message;
}

const sampleEvent = {
  quickcalApiVersion: 3,
  intent: "create",
  quickcalRelease: "test-revision",
  title: "Coffee with Alex",
  date: "2026-10-17",
  startTime: "10:00",
  endTime: "10:30",
  timeZone: "America/Los_Angeles",
  location: "Avila",
  reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
  needsClarification: false,
  clarificationQuestions: [],
};

describe("parser messages", () => {
  it("fetches only the fixed local endpoint once", async () => {
    const calls = [];
    const listener = listen(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, async json() { return sampleEvent; } };
    });
    let reply;
    const keep = listener(
      {
        type: "quickcal-parse",
        text: "  Coffee with Alex tomorrow at 10 AM  ",
        timeZone: "America/Los_Angeles",
        url: "https://evil.example/parse",
      },
      contentSender(),
      (result) => {
        reply = result;
      }
    );
    assert.equal(keep, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://quickcal-ai.onrender.com/parse-event");
    assert.equal(calls[0].options.headers.Authorization, "Bearer ya29.extension-test-token");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      text: "Coffee with Alex tomorrow at 10 AM",
      timeZone: "America/Los_Angeles",
    });
    assert.equal(calls[0].options.body.includes("ya29.extension-test-token"), false);
    assert.equal(reply.ok, true);
    assert.equal(reply.event.location, "Avila");
    assert.equal(reply.event.remindersText, "Popup 1 hour before");
    assert.equal(reply.token, undefined);
    assert.equal(JSON.stringify(reply).includes("ya29.extension-test-token"), false);
  });

  it("rejects a stale parser instead of treating missing notifications as off", async () => {
    const staleEvent = { ...sampleEvent };
    delete staleEvent.quickcalApiVersion;
    delete staleEvent.reminders;
    const listener = listen(async () => ({
      ok: true,
      async json() { return staleEvent; },
    }));
    const reply = await new Promise((resolve) => {
      listener(
        { type: "quickcal-parse", text: "Meeting tomorrow at 3 PM. Notify me 1 hour before it starts.", timeZone: "America/Los_Angeles" },
        contentSender(),
        resolve,
      );
    });
    assert.equal(reply.ok, false);
    assert.match(reply.error, /hosted parser is out of date/i);
    assert.doesNotMatch(reply.error, /notifications off/i);
  });

  it("sends clarification context without a saved event", async () => {
    const calls = [];
    const listener = listen(async (url, options) => {
      calls.push({ url, options });
      return { ok: true, async json() { return sampleEvent; } };
    });
    listener(
      {
        type: "quickcal-parse",
        text: "Tuesday at 8 PM",
        timeZone: "America/Los_Angeles",
        clarification: {
          originalText: "Coffee with Alex",
          draft: {
            title: "Coffee with Alex",
            date: null,
            startTime: null,
            endTime: null,
            timeZone: "America/Los_Angeles",
            location: null,
            recurrence: null,
          },
        },
      },
      contentSender(),
      () => {}
    );
    await new Promise((resolve) => setImmediate(resolve));
    const body = JSON.parse(calls[0].options.body);
    assert.equal(body.text, "Tuesday at 8 PM");
    assert.equal(body.clarification.originalText, "Coffee with Alex");
    assert.equal(body.clarification.draft.title, "Coffee with Alex");
    assert.equal(body.currentEvent, undefined);
  });

  it("reports a timeout and a parser error without retrying", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";
    const listener = listen(async () => {
      throw timeoutError;
    });
    let reply;
    listener(
      { type: "quickcal-parse", text: "Lunch", timeZone: "America/Los_Angeles" },
      contentSender(),
      (result) => {
        reply = result;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(reply.error, /timed out/i);

    let calls = 0;
    const errorListener = listen(async () => {
      calls += 1;
      return { ok: false, async json() { return { error: "The event text needs a clearer date." }; } };
    });
    errorListener(
      { type: "quickcal-parse", text: "Lunch", timeZone: "America/Los_Angeles" },
      contentSender(),
      (result) => {
        reply = result;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /clearer date/);
  });

  it("reports an unavailable backend without a second request", async () => {
    let calls = 0;
    const listener = listen(async () => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    let reply;
    listener(
      { type: "quickcal-parse", text: "Lunch", timeZone: "America/Los_Angeles" },
      contentSender(),
      (result) => {
        reply = result;
      }
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(reply.ok, false);
    assert.match(reply.error, /could not reach QuickCal/i);
  });

  it("rejects senders and payloads that are not a page parse", async () => {
    let calls = 0;
    const listener = listen(async () => {
      calls += 1;
      return { ok: true, async json() { return sampleEvent; } };
    });
    const rejectedSenders = [
      [{ type: "quickcal-parse", text: "Lunch", timeZone: "UTC" }, { id: "other", tab: { id: 1 }, url: "https://example.com/" }],
      [{ type: "quickcal-parse", text: "Lunch", timeZone: "UTC" }, { id: "mkihiedalmccmhoebiiikpdoafhdfglf", url: "https://example.com/" }],
      [{ type: "quickcal-parse", text: "Lunch", timeZone: "UTC" }, { id: "mkihiedalmccmhoebiiikpdoafhdfglf", tab: { id: 1 }, url: extensionOrigin + "/options/options.html" }],
      [{ type: "quickcal-auth", action: "connect" }, contentSender()],
    ];
    rejectedSenders.forEach(([message, sender]) => {
      assert.equal(listener(message, sender, () => {}), false);
    });
    const replies = [];
    [
      { type: "quickcal-parse", text: "   ", timeZone: "UTC" },
      { type: "quickcal-parse", text: "Lunch", timeZone: "PST" },
    ].forEach((message) => {
      assert.equal(listener(message, contentSender(), (result) => replies.push(result)), true);
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 0);
    assert.equal(replies.length, 2);
    assert.equal(replies.every((reply) => reply.ok === false), true);
  });
});

describe("preview text", () => {
  function loadPreview() {
    const sandbox = { Intl, Date, JSON, Math, String, Number };
    sandbox.globalThis = sandbox;
    const context = createContext(sandbox);
    runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context);
    runInContext(readFileSync(path.join(root, "shared/preview.js"), "utf8"), context);
    return sandbox.QuickCalPreview;
  }

  it("formats a compact date and time range", () => {
    const view = loadPreview().previewModel({
      title: "Coffee with Alex",
      date: "2026-10-17",
      endDate: "2026-10-17",
      startTime: "10:00",
      endTime: "10:30",
      timeZone: "America/Los_Angeles",
      location: "Avila",
      reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
      needsClarification: false,
      durationDefaulted: false,
      clarificationQuestions: [],
    });
    assert.equal(view.date, "Oct 17, 2026");
    assert.equal(view.time, "10:00\u201310:30 AM");
    assert.equal(view.location, "Avila");
    assert.equal(view.remindersText, "Popup 1 hour before");
    assert.equal(view.saveable, true);
    assert.equal(view.recurrenceText, "");
    assert.deepEqual(Array.from(view.questions), []);
  });

  it("shows the first date, weekly schedule, and series end", () => {
    const view = loadPreview().previewModel({
      title: "Date with John",
      date: "2026-10-23",
      endDate: "2026-10-23",
      startTime: "18:00",
      endTime: "19:00",
      timeZone: "America/Los_Angeles",
      location: null,
      needsClarification: false,
      durationDefaulted: true,
      clarificationQuestions: [],
      recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
    });
    assert.equal(view.date, "Oct 23, 2026");
    assert.equal(view.time, "6:00\u20137:00 PM");
    assert.equal(view.recurrenceText, "Every Friday");
    assert.equal(view.seriesEndText, "No end date");
    assert.equal(view.saveable, true);
  });

  it("lists each clarification once", () => {
    const view = loadPreview().previewModel({
      title: "Coffee with Alex",
      date: null,
      startTime: null,
      endTime: null,
      timeZone: "America/Los_Angeles",
      location: null,
      needsClarification: true,
      durationDefaulted: false,
      clarificationQuestions: [
        "What date should I use?",
        "What date should I use?",
        "What time does it start and end?",
      ],
    });
    assert.equal(view.date, "");
    assert.equal(view.saveable, false);
    assert.deepEqual(Array.from(view.questions), [
      "What date should I use?",
      "What time does it start and end?",
    ]);
  });
});
