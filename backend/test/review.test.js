import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";
const zone = "America/Los_Angeles";
const plain = value => JSON.parse(JSON.stringify(value));
const proposal = (extra = {}) => ({ kind: "event", title: "Team meeting", date: "2026-11-20", startTime: "10:03", endTime: "11:03", timeZone: zone, description: "Bring notes", sourceContext: "Team meeting November 20", uncertainty: "", allDay: false, ...extra });
function harness(hooks = {}) {
  const session = {}, local = {}, calls = [], events = new Map(), tasks = [];
  let listener, release, parseRelease;
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => plain(body) });
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: { id: "mkihiedalmccmhoebiiikpdoafhdfglf", getURL: file => "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/" + file, onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
      scripting: { executeScript: async () => {} },
      storage: { local: { get: async key => ({ [key]: local[key] }), set: async data => Object.assign(local, plain(data)), remove: async key => delete local[key] }, session: { get: async key => ({ [key]: session[key] }), set: async data => Object.assign(session, plain(data)) } },
      identity: { getAuthToken: async () => "test-token", removeCachedAuthToken: async () => {} },
    },
    fetch: async (url, options = {}) => {
      const method = options.method || "GET", body = options.body ? JSON.parse(options.body) : null;
      url = String(url); calls.push({ url, method, body });
      if (url.includes("/analyze-document")) {
        if (hooks.holdAnalysis) await new Promise(resolve => { release = resolve; });
        return reply({ items: hooks.items || [proposal(), proposal({ kind: "task", title: "Submit report", startTime: null, endTime: null })], warning: "" });
      }
      if (url.includes("/parse-event")) {
        if (hooks.holdParse) await new Promise(resolve => { parseRelease = resolve; });
        return reply({ ...proposal(), kind: "event", location: null, recurrence: null, reminders: { useDefault: false, overrides: [] }, intent: body.currentEvent ? "edit" : "create", needsClarification: false, clarificationQuestions: [], durationDefaulted: false, quickcalApiVersion: 4 });
      }
      if (url.includes("/access")) return reply({ ok: true, approved: true });
      if (url.includes("maxResults=1&")) return reply({ kind: "calendar#events" });
      if (url.includes("tasks.googleapis.com")) {
        if (method === "GET") return reply({ items: tasks });
        if (hooks.failTask) { hooks.failTask = false; return reply({}, 403); }
        const task = { ...body, id: "task-" + tasks.length }; tasks.push(task);
        if (hooks.loseTaskResponse) { hooks.loseTaskResponse = false; throw new Error("network"); }
        return reply(task);
      }
      if (url.includes("/calendar/v3/")) {
        if (method === "GET") { const id = decodeURIComponent(url.split("/events/")[1] || ""); return events.has(id) ? reply(events.get(id)) : reply({}, 404); }
        if (hooks.holdCreate) await new Promise(resolve => { release = resolve; });
        const saved = { ...body, status: "confirmed", htmlLink: "https://calendar.google.com/calendar/event?eid=" + body.id };
        events.set(body.id, saved);
        if (hooks.loseEventResponse) { hooks.loseEventResponse = false; throw new Error("network"); }
        return reply(saved);
      }
      throw new Error("Unexpected URL " + url);
    },
    Intl, Date, URL, URLSearchParams, AbortSignal, crypto, console, setTimeout, clearTimeout,
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => { for (const file of files) runInContext(readFileSync(new URL("../../" + file, import.meta.url), "utf8"), context); };
  runInContext(readFileSync(new URL("../../background.js", import.meta.url), "utf8"), context);
  async function send(action, data = {}) {
    const result = await new Promise(resolve => listener({ type: "quickcal-widget", action, sessionId: session.quickcalWidgetSession?.sessionId, ...data }, { id: sandbox.chrome.runtime.id, tab: { id: 1, incognito: false }, url: "https://example.com" }, resolve));
    return result;
  }
  async function analyze() {
    await send("show"); await send("attachment", { file: { name: "schedule.txt", data: Buffer.from("Team meeting November 20").toString("base64") } });
    return send("analyze-document", { text: "", timeZone: zone });
  }
  return { send, analyze, state: () => session.quickcalWidgetSession, calls, events, tasks, release: () => release(), context, local, releaseParse: () => parseRelease() };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
describe("individual review and service routing", () => {
  it("keeps an unconfirmed task attempt while rejecting document refinement", async () => {
    const h = harness({ items: [proposal({ kind: "task", startTime: null, endTime: null })], loseTaskResponse: true }); await h.analyze();
    const row = h.state().review.rows[0]; await h.send("review-item", { id: row.id, decision: "approved" }); await h.send("create-approved");
    const result = await h.send("analyze-document", { text: "Only deadlines", timeZone: zone });
    assert.equal(result.ok, false); assert.match(result.error, /Retry the unconfirmed/); assert.equal(h.state().review.rows[0].requestId, row.requestId);
    await h.send("create-approved"); assert.equal(h.tasks.length, 1); assert.equal(h.state().review.rows[0].status, "created");
  });
  it("recovers a suspended worker without reposting a potentially dispatched task", async () => {
    const h = harness({ items: [proposal({ kind: "task", startTime: null, endTime: null })] }); await h.analyze();
    const row = h.state().review.rows[0]; row.decision = "approved"; row.uncertain = true;
    h.state().operation = { id: "interrupted", sessionId: h.state().sessionId, kind: "review-create", workerId: "old-worker" };
    await h.send("create-approved");
    assert.equal(h.state().operation, null); assert.equal(h.tasks.length, 0);
    assert.match(h.state().review.rows[0].error, /did not confirm/);
    assert.equal(h.calls.filter(call => call.method === "POST" && call.url.includes("tasks.googleapis.com")).length, 0);
  });
  it("creates explicit all-day date ranges with an exclusive Calendar end date", async () => {
    const h = harness({ items: [proposal({ allDay: true, startTime: null, endTime: null, endDate: "2026-11-22" })] }); await h.analyze();
    await h.send("review-item", { id: h.state().review.rows[0].id, decision: "approved" }); await h.send("create-approved");
    const created = [...h.events.values()][0]; assert.deepEqual(created.start, { date: "2026-11-20" }); assert.deepEqual(created.end, { date: "2026-11-23" });
  });
  it("creates nothing on extraction and creates only approved items after explicit confirmation", async () => {
    const h = harness(); await h.analyze();
    assert.ok(h.state().review.rows.every(row => row.decision === "pending")); assert.equal(h.events.size, 0); assert.equal(h.tasks.length, 0);
    await h.send("create-approved"); assert.equal(h.events.size, 0);
    const [event, task] = h.state().review.rows;
    await h.send("review-item", { id: task.id, decision: "skipped" });
    await h.send("review-item", { id: event.id, decision: "approved" });
    await h.send("create-approved");
    assert.equal(h.events.size, 1); assert.equal(h.tasks.length, 0);
    assert.equal(h.state().review.rows[0].status, "created"); assert.equal(h.state().review.rows[1].decision, "skipped");
    await h.send("create-approved"); assert.equal(h.calls.filter(call => call.method === "POST" && call.url.includes("/calendar/")).length, 1);
  });
  it("saves corrected non-rounded times and resets approval on edits", async () => {
    const h = harness(); await h.analyze(); const row = h.state().review.rows[0];
    assert.equal(row.item.startTime, "10:03");
    await h.send("review-item", { id: row.id, decision: "approved" });
    await h.send("review-item", { id: row.id, item: { ...row.item, startTime: "10:05" } });
    assert.equal(h.state().review.rows[0].decision, "pending");
    await h.send("review-item", { id: row.id, decision: "approved" }); await h.send("create-approved");
    const created = [...h.events.values()][0]; assert.match(created.start.dateTime, /2026-11-20T10:05:00-08:00/); assert.match(created.description, /Bring notes/);
    const invalid = await h.send("review-item", { id: h.state().review.rows[1].id, item: { ...row.item, endTime: "09:00" } });
    assert.equal(invalid.ok, true);
    const rejected = await h.send("review-item", { id: h.state().review.rows[1].id, decision: "approved" });
    assert.equal(rejected.ok, false);
  });
  it("routes actual tasks to Tasks with a date-only due value and preserves explicit times as notes", async () => {
    const h = harness({ items: [proposal({ kind: "task", endTime: null })] }); await h.analyze();
    await h.send("review-item", { id: h.state().review.rows[0].id, decision: "approved" }); await h.send("create-approved");
    assert.equal(h.events.size, 0); assert.equal(h.tasks.length, 1); assert.equal(h.tasks[0].due, "2026-11-20T00:00:00.000Z"); assert.match(h.tasks[0].notes, /10:03.*America\/Los_Angeles/);
  });
  it("retries failed items without recreating successes and reports missing Tasks permission", async () => {
    const h = harness({ failTask: true }); await h.analyze();
    for (const row of h.state().review.rows) await h.send("review-item", { id: row.id, decision: "approved" });
    await h.send("create-approved"); assert.equal(h.events.size, 1); assert.equal(h.tasks.length, 0);
    assert.match(h.state().review.rows[1].error, /Allow Google Tasks access/);
    await h.send("create-approved"); assert.equal(h.events.size, 1); assert.equal(h.tasks.length, 1); assert.ok(h.state().review.rows.every(row => row.status === "created"));
  });
  it("reconciles lost task responses without sending another POST", async () => {
    const h = harness({ items: [proposal({ kind: "task", startTime: null, endTime: null })], loseTaskResponse: true }); await h.analyze();
    await h.send("review-item", { id: h.state().review.rows[0].id, decision: "approved" }); await h.send("create-approved");
    assert.equal(h.state().review.rows[0].uncertain, true); assert.equal(h.tasks.length, 1);
    await h.send("create-approved"); assert.equal(h.state().review.rows[0].status, "created");
    assert.equal(h.calls.filter(call => call.method === "POST" && call.url.includes("tasks.googleapis.com")).length, 1);
  });
  it("recovers a Calendar response and prevents simultaneous double submissions", async () => {
    const h = harness({ items: [proposal()], holdCreate: true, loseEventResponse: true }); await h.analyze();
    await h.send("review-item", { id: h.state().review.rows[0].id, decision: "approved" });
    const first = h.send("create-approved"); await tick();
    const second = await h.send("create-approved"); assert.equal(second.session.operation.kind, "review-create");
    h.release(); await first; assert.equal(h.events.size, 1); assert.equal(h.state().review.rows[0].status, "created");
  });
  it("keeps file and review on panel collapse and discards outdated analysis after replacement", async () => {
    const hooks = { holdAnalysis: true }; const h = harness(hooks);
    await h.send("show"); await h.send("attachment", { file: { name: "a.txt", data: "dGV4dA==" } });
    const first = h.send("analyze-document", { text: "Only exams", timeZone: zone }); await tick();
    await h.send("attachment", { file: { name: "b.txt", data: "bmV3" } }); h.release(); await first;
    assert.equal(h.state().attachment.name, "b.txt"); assert.equal(h.state().review, null);
    hooks.holdAnalysis = false; await h.send("analyze-document", { text: "Only meetings", timeZone: zone });
    await h.send("upload-panel", { open: false }); assert.equal(h.state().attachment.name, "b.txt"); assert.equal(h.state().review.rows.length, 2);
  });
  it("previews normal requests before creation and remembers the correct saved event for follow-ups", async () => {
    const h = harness(); await h.send("show"); await h.send("submit", { text: "Meet tomorrow at 10:03", timeZone: zone });
    assert.equal(h.state().mode, "review"); assert.equal(h.events.size, 0);
    const row = h.state().review.rows[0]; await h.send("review-item", { id: row.id, decision: "approved" }); await h.send("create-approved");
    const remembered = await runInContext("loadDraftEvent()", h.context);
    assert.equal(remembered.id, row.requestId); assert.match(remembered.userDescription, /Bring notes/);
    assert.equal(h.state().savedRecord.date, "2026-11-20");
  });
});
