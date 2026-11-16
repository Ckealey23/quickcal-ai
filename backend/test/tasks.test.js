import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createParser } from "../src/parse.js";
import { loadBackground, response } from "./support/background-harness.js";

const ZONE = "America/Los_Angeles";
const NOW = new Date("2026-11-16T18:00:00Z");

function modelOutput(fields) {
  return Object.assign({
    kind: "event",
    description: null,
    title: null,
    date: null,
    startTime: null,
    endTime: null,
    timeZone: ZONE,
    location: null,
    recurrence: null,
    notificationAction: "preserve",
    notificationOverrides: [],
    needsClarification: false,
    clarificationQuestions: [],
    intent: "create",
    operation: {
      target: null, searchDate: null, searchTime: null, destinationDate: null, destinationTime: null,
      destinationEndTime: null, scope: "occurrence", selection: [], durationMinutes: null, windowStart: null,
      windowEnd: null, preference: null, searchEndDate: null, readOnly: null,
    },
  }, fields);
}

function parserReturning(output) {
  const requests = [];
  const parse = createParser({
    apiKey: "sk-test",
    model: "test-model",
    now: () => NOW,
    client: {
      responses: {
        async create(request) {
          requests.push(request);
          return { status: "completed", output_text: JSON.stringify(output) };
        },
      },
    },
  });
  return { parse, requests };
}

describe("task classification", () => {
  it("returns a task with a due date and never invents a time", async () => {
    const { parse, requests } = parserReturning(modelOutput({
      kind: "task", title: "Submit report", date: "2026-11-17",
      needsClarification: true, clarificationQuestions: ["What time does this event start?"],
    }));
    const task = await parse({ text: "Remind me to submit my report tomorrow", timeZone: ZONE });
    assert.equal(task.kind, "task");
    assert.equal(task.intent, "create");
    assert.equal(task.title, "Submit report");
    assert.equal(task.date, "2026-11-17");
    assert.equal(task.startTime, null);
    assert.equal(task.endTime, null);
    assert.equal(task.durationDefaulted, false);
    assert.equal(task.needsClarification, false);
    assert.deepEqual(task.clarificationQuestions, []);
    assert.match(requests[0].instructions, /Set kind to task/);
    assert.ok(requests[0].text.format.schema.required.includes("kind"));
  });

  it("keeps a task without a due date and asks only for a missing title", async () => {
    const untitled = parserReturning(modelOutput({ kind: "task", title: null }));
    const asked = await untitled.parse({ text: "Add a task", timeZone: ZONE });
    assert.equal(asked.needsClarification, true);
    assert.deepEqual(asked.clarificationQuestions, ["What should the task be called?"]);

    const groceries = parserReturning(modelOutput({ kind: "task", title: "Buy groceries" }));
    const task = await groceries.parse({ text: "Add buy groceries to my tasks", timeZone: ZONE });
    assert.equal(task.kind, "task");
    assert.equal(task.date, null);
    assert.equal(task.needsClarification, false);
  });

  it("asks instead of creating a repeating Google Task", async () => {
    const { parse } = parserReturning(modelOutput({
      kind: "task", title: "Water plants",
      recurrence: { frequency: "weekly", weekdays: ["MO"], until: null, count: null },
    }));
    const task = await parse({ text: "Remind me to water the plants every Monday", timeZone: ZONE });
    assert.equal(task.needsClarification, true);
    assert.match(task.clarificationQuestions[0], /repeating Google Tasks/);
    assert.equal(task.recurrence, null);
  });

  it("keeps ordinary events unchanged", async () => {
    const { parse } = parserReturning(modelOutput({
      title: "Coffee with Alex", date: "2026-11-17", startTime: "09:00",
    }));
    const event = await parse({ text: "Coffee with Alex tomorrow at 9 AM", timeZone: ZONE });
    assert.equal(event.kind, undefined);
    assert.equal(event.description, undefined);
    assert.equal(event.intent, "create");
    assert.equal(event.endTime, "10:00");
    assert.equal(event.durationDefaulted, true);
  });
});

function tasksApi(options) {
  const settings = options || {};
  const tasks = new Map();
  const calls = { inserts: [], calendarInserts: 0 };
  let next = 1;
  const route = async (url, init) => {
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events") && init.method === "POST") {
      calls.calendarInserts += 1;
      return response(500, {});
    }
    if (!url.startsWith("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks")) return undefined;
    const parsed = new URL(url);
    const id = decodeURIComponent(parsed.pathname.split("/lists/@default/tasks/")[1] || "");
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      calls.inserts.push(body);
      if (settings.denied) {
        return response(403, { error: { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } });
      }
      if (settings.disabled) {
        return response(403, { error: { message: "Google Tasks API has not been used in project 1 before or it is disabled.", status: "PERMISSION_DENIED" } });
      }
      const saved = Object.assign({ id: "task-" + next, webViewLink: "https://tasks.google.com/task/task-" + next, status: "needsAction" }, body);
      next += 1;
      tasks.set(saved.id, saved);
      if (settings.dropResponse) {
        settings.dropResponse = false;
        throw new TypeError("Failed to fetch");
      }
      return response(200, saved);
    }
    if (init.method === "GET" && id) {
      const found = tasks.get(id);
      return found ? response(200, found) : response(404, {});
    }
    if (init.method === "GET") return response(200, { items: Array.from(tasks.values()) });
    return undefined;
  };
  return { route, tasks, calls };
}

function taskEvent(fields) {
  return Object.assign({
    kind: "task",
    title: "Submit report",
    description: null,
    date: "2026-11-17",
    startTime: null,
    endTime: null,
    endDate: "2026-11-17",
    timeZone: ZONE,
    location: null,
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    needsClarification: false,
    clarificationQuestions: [],
    durationDefaulted: false,
    intent: "create",
  }, fields);
}

describe("task requests in the shared panel", () => {
  it("saves a clear task automatically, without a confirmation step or a conflict check", async () => {
    const api = tasksApi();
    let version = 0;
    const loaded = loadBackground({
      route: async (url, init) => {
        if (url.includes("/parse-event")) {
          return response(200, Object.assign(taskEvent({ title: "Finish assignment", date: "2026-11-20", endDate: "2026-11-20" }), {
            quickcalApiVersion: version,
            quickcalRelease: "test",
          }));
        }
        return api.route(url, init);
      },
    });
    version = loaded.sandbox.QuickCalLocalParse.API_VERSION;
    const shown = await loaded.ask({ type: "quickcal-widget", action: "show" });
    const done = await loaded.ask({
      type: "quickcal-widget",
      action: "submit",
      text: "Create a task to finish my assignment by Friday",
      sessionId: shown.session.sessionId,
      operationId: "op-task",
      timeZone: ZONE,
    });
    assert.equal(done.session.mode, "saved");
    assert.equal(done.session.savedRecord.kind, "task");
    assert.equal(done.session.savedRecord.dateText, "Nov 20, 2026");
    assert.equal(done.session.conflictNotice, null);
    assert.equal(api.calls.inserts.length, 1);
    assert.equal(api.calls.calendarInserts, 0);
    assert.equal(loaded.fetches.some((call) => call.url.includes("/freeBusy") || call.url.includes("singleEvents=true")), false);
  });

  it("tells the options page when the Google token lacks Tasks access", async () => {
    const loaded = loadBackground({
      route: async (url) => (url.includes("/users/@me/lists")
        ? response(403, { error: { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } })
        : undefined),
    });
    const options = { id: loaded.sandbox.chrome.runtime.id, url: "chrome-extension://" + loaded.sandbox.chrome.runtime.id + "/options/options.html" };
    const status = await loaded.ask({ type: "quickcal-auth", action: "status" }, options);
    assert.equal(status.needsTasksScope, true);
    assert.match(status.message, /create Google Tasks/);

    const fine = loadBackground({ route: async (url) => (url.includes("/users/@me/lists") ? response(200, { items: [] }) : undefined) });
    const ready = await fine.ask({ type: "quickcal-auth", action: "status" }, options);
    assert.equal(ready.needsTasksScope, false);
    assert.equal(ready.state, "ready");
  });
});

describe("Google Tasks save", () => {
  it("creates a real Google Task with the due date and no Calendar event", async () => {
    const api = tasksApi();
    const loaded = loadBackground({ route: api.route });
    const saved = await loaded.ask({ type: "quickcal-calendar", action: "create", event: taskEvent() });
    assert.equal(saved.ok, true);
    assert.equal(saved.kind, "task");
    assert.equal(saved.htmlLink, "https://tasks.google.com/task/task-1");
    assert.equal(saved.dateText, "Nov 17, 2026");
    assert.equal(api.calls.calendarInserts, 0);
    assert.equal(api.calls.inserts.length, 1);
    assert.equal(api.calls.inserts[0].title, "Submit report");
    assert.equal(api.calls.inserts[0].due, "2026-11-17T00:00:00.000Z");
    assert.match(api.calls.inserts[0].notes, /Created by QuickCalAI/);
  });

  it("records a stated due time in the notes and leaves an undated task undated", async () => {
    const api = tasksApi();
    const loaded = loadBackground({ route: api.route });
    const timed = await loaded.ask({ type: "quickcal-calendar", action: "create", event: taskEvent({ startTime: "17:00", description: "Send to Dana" }) });
    assert.equal(timed.ok, true);
    assert.equal(timed.timeText, "Due 5:00 PM");
    assert.equal(api.calls.inserts[0].notes, "Send to Dana\n\nDue 5:00 PM.\n\nCreated by QuickCalAI.");
    const undated = await loaded.ask({ type: "quickcal-calendar", action: "create", event: taskEvent({ title: "Buy groceries", date: null, endDate: null }) });
    assert.equal(undated.ok, true);
    assert.equal(undated.dateText, "No due date");
    assert.equal(Object.hasOwn(api.calls.inserts[1], "due"), false);
  });

  it("does not duplicate a task on a repeated request or after a lost response", async () => {
    const api = tasksApi({ dropResponse: true });
    const loaded = loadBackground({ route: api.route });
    const first = await loaded.ask({ type: "quickcal-calendar", action: "create", event: taskEvent() });
    assert.equal(first.ok, true, "the lost response is recovered from Google Tasks");
    const again = await loaded.ask({ type: "quickcal-calendar", action: "create", event: taskEvent() });
    assert.equal(again.ok, true);
    assert.equal(again.id, first.id);
    assert.equal(api.tasks.size, 1);
  });

  it("explains a missing Tasks grant and a disabled Tasks API", async () => {
    const denied = loadBackground({ route: tasksApi({ denied: true }).route });
    const scope = await denied.ask({ type: "quickcal-calendar", action: "create", event: taskEvent() });
    assert.equal(scope.ok, false);
    assert.equal(scope.state, "needsTasksScope");
    assert.match(scope.error, /Reconnect Google so QuickCalAI can create Google Tasks/);

    const disabled = loadBackground({ route: tasksApi({ disabled: true }).route });
    const off = await disabled.ask({ type: "quickcal-calendar", action: "create", event: taskEvent() });
    assert.equal(off.ok, false);
    assert.match(off.error, /Enable the Google Tasks API/);

    const offline = loadBackground({ route: tasksApi().route, disconnected: true });
    const disconnected = await offline.ask({ type: "quickcal-calendar", action: "create", event: taskEvent() });
    assert.equal(disconnected.ok, false);
    assert.equal(disconnected.state, "disconnected");
  });
});
