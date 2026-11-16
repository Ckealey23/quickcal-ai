import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadBackground, response } from "./support/background-harness.js";

const ZONE = "America/Los_Angeles";
const SYLLABUS = "BIO 101 Fall 2026\nMidterm Exam 1: October 12, 2026, 10:00 AM\nFinal Exam: December 14, 2026, 8:00 AM\nReading: Chapter 7 due October 15, 2026";

function exams() {
  return [
    { kind: "event", title: "Midterm Exam 1", date: "2026-10-12", endDate: null, startTime: "10:00", endTime: null, allDay: false, description: null, category: "Exam", sourceQuote: "Midterm Exam 1: October 12, 2026, 10:00 AM", sourcePage: null, issues: [] },
    { kind: "event", title: "Final Exam", date: "2026-12-14", endDate: null, startTime: "08:00", endTime: "10:00", allDay: false, description: null, category: "Exam", sourceQuote: "Final Exam: December 14, 2026, 8:00 AM", sourcePage: null, issues: [] },
    { kind: "event", title: "Study group", date: "2026-10-10", endDate: null, startTime: null, endTime: null, allDay: false, description: null, category: null, sourceQuote: null, sourcePage: null, issues: ["Time not stated in the document."] },
  ];
}

function world(options) {
  const settings = Object.assign({ analyses: [], extracts: [], events: new Map(), tasks: [], parses: 0, calendarPosts: [], taskPosts: [] }, options);
  settings.route = async (url, init) => {
    if (url.endsWith("/extract-document")) {
      settings.extracts.push({ type: init.headers["Content-Type"], size: init.body.length });
      return response(200, { ok: true, kind: "txt", text: SYLLABUS, pages: null, characters: SYLLABUS.length, quickcalApiVersion: 5 });
    }
    if (url.endsWith("/analyze-document")) {
      const body = JSON.parse(init.body);
      settings.analyses.push(body);
      if (settings.holdAnalysis) await settings.holdAnalysis;
      const items = settings.nextItems ? settings.nextItems(body) : exams();
      return response(200, { ok: true, items: items, warning: items.length ? null : "No presentations are listed.", quickcalApiVersion: 5 });
    }
    if (url.includes("/parse-event")) {
      settings.parses += 1;
      return response(500, {});
    }
    if (url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
      const id = decodeURIComponent(new URL(url).pathname.split("/events/")[1] || "");
      if (init.method === "GET" && id) {
        const found = settings.events.get(id);
        return found ? response(200, found) : response(404, {});
      }
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        settings.calendarPosts.push(body);
        if (settings.failCalendar && settings.failCalendar(body)) return response(500, {});
        const saved = { id: body.id, status: "confirmed", htmlLink: "https://www.google.com/calendar/event?eid=" + body.id, body: body };
        settings.events.set(body.id, saved);
        return response(200, saved);
      }
    }
    if (url.startsWith("https://tasks.googleapis.com/tasks/v1/lists/@default/tasks")) {
      if (init.method === "POST") {
        const body = JSON.parse(init.body);
        settings.taskPosts.push(body);
        const saved = Object.assign({ id: "t" + settings.tasks.length, webViewLink: "https://tasks.google.com/task/t" + settings.tasks.length }, body);
        settings.tasks.push(saved);
        return response(200, saved);
      }
      return response(200, { items: settings.tasks });
    }
    return undefined;
  };
  return settings;
}

async function openWithFile(loaded) {
  const shown = await loaded.ask({ type: "quickcal-widget", action: "show" });
  const opened = await loaded.ask({ type: "quickcal-widget", action: "doc-open", sessionId: shown.session.sessionId });
  assert.equal(opened.session.doc.open, true);
  assert.equal(opened.session.doc.phase, "empty");
  const data = Buffer.from(SYLLABUS).toString("base64");
  const attached = await loaded.ask({
    type: "quickcal-widget",
    action: "doc-attach",
    sessionId: opened.session.sessionId,
    name: "bio101-syllabus.txt",
    size: Buffer.byteLength(SYLLABUS),
    data: data,
  });
  return attached.session;
}

function analyze(loaded, session, instructions) {
  return loaded.ask({ type: "quickcal-widget", action: "doc-analyze", docId: session.doc.id, instructions: instructions, timeZone: ZONE });
}

describe("document upload and analysis", () => {
  it("reads the file once, keeps its text out of the shared state, and creates nothing while analyzing", async () => {
    const env = world();
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    assert.equal(session.doc.phase, "ready");
    assert.equal(session.doc.file.name, "bio101-syllabus.txt");
    assert.equal(session.doc.file.characters, SYLLABUS.length);
    assert.equal(env.extracts.length, 1);
    assert.equal(env.extracts[0].type, "text/plain");
    assert.equal(JSON.stringify(session).includes("Midterm Exam 1: October 12"), false, "no document text in the shared session");
    assert.ok(loaded.session["quickcalDocText:" + session.doc.id], "text cached for refinement");

    const analyzed = await analyze(loaded, session, "Only find midterms and final exams.");
    assert.equal(analyzed.session.doc.phase, "review");
    assert.equal(analyzed.session.doc.items.length, 3);
    assert.ok(analyzed.session.doc.items.every((item) => item.decision === "pending"), "nothing is approved automatically");
    assert.equal(env.analyses[0].instructions, "Only find midterms and final exams.");
    assert.equal(env.analyses[0].text, SYLLABUS);
    assert.equal(env.calendarPosts.length + env.taskPosts.length, 0);
  });

  it("refines without a new upload and keeps decisions for the same activity", async () => {
    const env = world();
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    const first = await analyze(loaded, session, "Find all exam dates.");
    const final = first.session.doc.items.find((item) => item.title === "Final Exam");
    await loaded.ask({ type: "quickcal-widget", action: "doc-decide", docId: session.doc.id, itemId: final.id, decision: "approved" });
    env.nextItems = () => exams().slice(1, 2);
    const refined = await analyze(loaded, session, "Actually, only show finals.");
    assert.equal(env.extracts.length, 1, "no second upload");
    assert.deepEqual(env.analyses[1].history, ["Find all exam dates."]);
    assert.equal(refined.session.doc.items.length, 1);
    assert.equal(refined.session.doc.items[0].decision, "approved");
    assert.equal(refined.session.doc.instructions, "Actually, only show finals.");
  });

  it("shows a clear empty result when nothing matches", async () => {
    const env = world({ nextItems: () => [] });
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    const result = await analyze(loaded, session, "Extract all presentations.");
    assert.equal(result.session.doc.items.length, 0);
    assert.equal(result.session.doc.message, "No presentations are listed.");
  });

  it("routes typed text to the document while the panel is open", async () => {
    const env = world();
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    const submitted = await loaded.ask({ type: "quickcal-widget", action: "submit", text: "Coffee tomorrow at 9", sessionId: session.sessionId, operationId: "x", timeZone: ZONE });
    assert.equal(submitted.ignored, true);
    assert.equal(env.parses, 0);
    assert.equal(env.calendarPosts.length, 0);
  });

  it("ignores a second analysis while one is running", async () => {
    let release;
    const env = world({ holdAnalysis: new Promise((resolve) => { release = resolve; }) });
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    const first = analyze(loaded, session, "exams");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await analyze(loaded, session, "quizzes");
    assert.equal(second.ignored, true);
    release();
    assert.equal((await first).session.doc.instructions, "exams");
    assert.equal(env.analyses.length, 1);
  });

  it("refuses files that are not PDF, DOCX, or TXT, or whose contents do not match", async () => {
    const env = world();
    const loaded = loadBackground(env);
    const shown = await loaded.ask({ type: "quickcal-widget", action: "show" });
    await loaded.ask({ type: "quickcal-widget", action: "doc-open", sessionId: shown.session.sessionId });
    const image = await loaded.ask({ type: "quickcal-widget", action: "doc-attach", sessionId: shown.session.sessionId, name: "scan.png", size: 3, data: "AAAA" });
    assert.equal(image.session.doc.phase, "unreadable");
    assert.match(image.session.doc.message, /PDF, DOCX, and TXT/);
    const fake = await loaded.ask({ type: "quickcal-widget", action: "doc-attach", sessionId: shown.session.sessionId, name: "syllabus.pdf", size: 5, data: Buffer.from("hello").toString("base64") });
    assert.match(fake.session.doc.message, /do not match/);
    assert.equal(env.extracts.length, 0);
  });

  it("forgets the document when the panel is closed", async () => {
    const env = world();
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    const key = "quickcalDocText:" + session.doc.id;
    const dismissed = await loaded.ask({ type: "quickcal-widget", action: "dismiss" });
    assert.equal(dismissed.session.doc, null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loaded.session[key], undefined);
  });
});

describe("document approval and creation", () => {
  async function reviewed(env) {
    const loaded = loadBackground(env);
    const session = await openWithFile(loaded);
    const result = await analyze(loaded, session, "Find exams.");
    const items = result.session.doc.items;
    const find = (title) => items.find((item) => item.title === title);
    const decide = (item, decision) => loaded.ask({ type: "quickcal-widget", action: "doc-decide", docId: session.doc.id, itemId: item.id, decision: decision });
    const edit = (item, patch) => loaded.ask({ type: "quickcal-widget", action: "doc-edit", docId: session.doc.id, itemId: item.id, patch: patch });
    const create = () => loaded.ask({ type: "quickcal-widget", action: "doc-create", docId: session.doc.id, timeZone: ZONE });
    return { loaded, session, find, decide, edit, create };
  }

  it("creates only approved items, once, with the reviewed details", async () => {
    const env = world();
    const flow = await reviewed(env);
    await flow.decide(flow.find("Midterm Exam 1"), "approved");
    await flow.decide(flow.find("Final Exam"), "skipped");
    const blocked = await flow.decide(flow.find("Study group"), "approved");
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /start time or mark it all day/);

    const created = await flow.create();
    assert.equal(env.calendarPosts.length, 1);
    const body = env.calendarPosts[0];
    assert.equal(body.summary, "Midterm Exam 1");
    assert.equal(body.start.dateTime, "2026-10-12T10:00:00-07:00");
    assert.equal(body.end.dateTime, "2026-10-12T11:00:00-07:00");
    assert.match(body.description, /From bio101-syllabus\.txt\./);
    const midterm = created.session.doc.items.find((item) => item.title === "Midterm Exam 1");
    assert.equal(midterm.result.ok, true);
    assert.equal(body.id, midterm.eventId);
    assert.equal(created.session.doc.message, "Created 1 event.");

    const again = await flow.create();
    assert.equal(again.session.doc.message, "Approve at least one item first.");
    assert.equal(env.calendarPosts.length, 1, "no duplicate on a repeated click");
  });

  it("applies edits from review, including a 5-minute time and a switch to a task", async () => {
    const env = world();
    const flow = await reviewed(env);
    const study = flow.find("Study group");
    const bad = await flow.edit(study, { startTime: "15:00", endTime: "14:00" });
    assert.equal(bad.ok, false);
    const fixed = await flow.edit(study, { title: "Study group (library)", startTime: "15:05", endTime: "16:35" });
    assert.equal(fixed.ok, true);
    await flow.decide(study, "approved");
    const final = flow.find("Final Exam");
    await flow.edit(final, { kind: "task" });
    await flow.decide(final, "approved");
    const created = await flow.create();
    assert.equal(env.calendarPosts.length, 1);
    assert.equal(env.calendarPosts[0].summary, "Study group (library)");
    assert.equal(env.calendarPosts[0].start.dateTime, "2026-10-10T15:05:00-07:00");
    assert.equal(env.calendarPosts[0].end.dateTime, "2026-10-10T16:35:00-07:00");
    assert.equal(env.taskPosts.length, 1);
    assert.equal(env.taskPosts[0].title, "Final Exam (8:00 AM)");
    assert.equal(env.taskPosts[0].due, "2026-12-14T00:00:00.000Z");
    assert.doesNotMatch(env.taskPosts[0].notes, /8:00 AM/);
    assert.equal(created.session.doc.message, "Created 1 event and 1 task.");
  });

  it("reports a partial failure and retries only the failed item without duplicating", async () => {
    let failing = true;
    const env = world({ failCalendar: (body) => failing && body.summary === "Final Exam" });
    const flow = await reviewed(env);
    await flow.decide(flow.find("Midterm Exam 1"), "approved");
    await flow.decide(flow.find("Final Exam"), "approved");
    const first = await flow.create();
    assert.match(first.session.doc.message, /^Created 1 event\. 1 could not be created\./);
    assert.equal(first.session.doc.messageError, true);
    const failedItem = first.session.doc.items.find((item) => item.title === "Final Exam");
    assert.equal(failedItem.result.ok, false);
    assert.equal(failedItem.decision, "approved");

    failing = false;
    const retried = await flow.create();
    const posts = env.calendarPosts.map((body) => body.summary);
    assert.deepEqual(posts, ["Midterm Exam 1", "Final Exam", "Final Exam"]);
    assert.equal(env.calendarPosts[1].id, env.calendarPosts[2].id, "the retry reuses the same event id");
    assert.equal(env.events.size, 2);
    assert.equal(retried.session.doc.message, "Created 2 events.");
  });

  it("starts one creation when the button is pressed twice", async () => {
    const env = world();
    const flow = await reviewed(env);
    await flow.decide(flow.find("Midterm Exam 1"), "approved");
    const [one, two] = await Promise.all([flow.create(), flow.create()]);
    assert.equal([one, two].filter((result) => result.ignored).length, 1);
    assert.equal(env.calendarPosts.length, 1);
  });
});
