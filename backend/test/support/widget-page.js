import path from "node:path";
import { pathToFileURL } from "node:url";

const defaultRoot = path.resolve(import.meta.dirname, "../../..");

// A page that runs the real widget against a small in-page stand-in for the
// service worker's shared session. `script` runs once the widget is styled.
export function widgetPage(script, options) {
  const settings = options || {};
  const root = settings.root || defaultRoot;
  const url = (file) => pathToFileURL(path.join(root, file)).href;
  const scripts = [
    "shared/schedule.js",
    "shared/preview.js",
    "shared/startup.js",
    "shared/selection.js",
    "shared/layout.js",
    "shared/lookup.js",
    "shared/time-options.js",
    "shared/documents.js",
    "shared/session.js",
  ];
  return `<!DOCTYPE html>
<meta charset="utf-8">
<title>QuickCalAI feature checks</title>
<style>
  html, body { margin: 0; height: 100%; background: ${settings.background || "#ffffff"}; font-family: sans-serif; }
  main { padding: 24px; color: #333; }
</style>
<main><h1>Example page</h1><p>Some page content behind the panel.</p></main>
<pre id="result">pending</pre>
${scripts.map((file) => `<script src="${url(file)}"></script>`).join("\n")}
<script>
  const calls = [];
  const listeners = [];
  const changeListeners = [];
  let state = Object.assign(QuickCalSession.create(false), { visible: true, sessionId: "s1", claim: 1, ownerTabId: 1 });
  ${settings.layout ? `state.layout = ${JSON.stringify(settings.layout)};` : ""}
  const SYLLABUS_ITEMS = [
    { kind: "event", title: "Midterm Exam 1", date: "2026-10-12", startTime: "10:00", endTime: "11:50", allDay: false, description: "Room 204", category: "Exam", sourceQuote: "Midterm Exam 1: Monday, October 12, 2026, 10:00 AM - 11:50 AM", sourcePage: 2, issues: [] },
    { kind: "event", title: "Midterm Exam 2", date: "2026-11-09", startTime: "10:00", endTime: null, allDay: false, description: null, category: "Exam", sourceQuote: "Midterm Exam 2: November 9, 2026 at 10:00 AM", sourcePage: 3, issues: [] },
    { kind: "event", title: "Final Exam", date: "2026-12-14", startTime: null, endTime: null, allDay: false, description: null, category: "Exam", sourceQuote: "Final Exam: December 14, 2026", sourcePage: 4, issues: ["Time not stated in the document."] },
  ];
  function commit(next) {
    state = Object.assign({}, next, { revision: state.revision + 1 });
    return { ok: true, session: JSON.parse(JSON.stringify(state)) };
  }
  function doc(patch) {
    return commit(Object.assign({}, state, { doc: Object.assign({}, state.doc, patch) }));
  }
  function background(message) {
    if (message.type === "quickcal-backend") return { ok: true };
    if (message.type === "quickcal-calendar") return { ok: true, connected: true, quickcalReady: true, event: null };
    if (message.type !== "quickcal-widget") return { ok: true };
    const action = message.action;
    if (["snapshot", "show", "claim", "layout"].includes(action)) {
      if (action === "layout") state.layout = message.layout;
      return { ok: true, session: JSON.parse(JSON.stringify(state)) };
    }
    if (action === "patch") {
      state.input = message.input;
      state.inputSeq = message.seq;
      return Object.assign(commit(state), { accepted: true });
    }
    if (action === "dismiss") return commit(QuickCalSession.dismiss(state));
    if (action === "submit") {
      if (state.doc && state.doc.open) return { ok: false, ignored: true, session: state };
      const record = globalThis.nextTask ? {
        id: "task1", kind: "task", summary: "Submit report", title: "Submit report",
        date: "2026-11-17", endDate: "2026-11-17", startTime: null, endTime: null,
        dateText: "Nov 17, 2026", timeText: "", timeZone: "America/Los_Angeles",
        htmlLink: "https://tasks.google.com/task/task1", reminders: { useDefault: false, overrides: [] }, remindersText: "",
      } : {
        id: "evt123", kind: undefined, summary: "Coffee with Alex", title: "Coffee with Alex",
        date: "2026-11-17", endDate: "2026-11-17", startTime: "09:00", endTime: "10:00",
        dateText: "Nov 17, 2026", timeText: "9:00\\u201310:00 AM", timeZone: "America/Los_Angeles",
        htmlLink: "https://www.google.com/calendar/event?eid=abc", reminders: { useDefault: false, overrides: [] }, remindersText: "",
      };
      return commit(Object.assign({}, state, { mode: "saved", savedRecord: record, input: "", statusText: "", statusError: false }));
    }
    if (action === "retime") {
      const record = Object.assign({}, state.savedRecord, {
        startTime: message.startTime, endTime: message.endTime,
        timeText: QuickCalSchedule.formatTimeRange(message.startTime, message.endTime),
      });
      return commit(Object.assign({}, state, { savedRecord: record, statusText: "", statusError: false }));
    }
    if (action === "doc-open") {
      const base = state.mode === "input" ? state : QuickCalSession.openReset(state);
      return commit(Object.assign({}, base, { doc: state.doc ? Object.assign({}, state.doc, { open: true }) : {
        id: "d1", open: true, phase: "empty", file: null, instructions: "", history: [], seq: 0, message: "", messageError: false, warning: "", items: [],
      } }));
    }
    if (action === "doc-close") return doc({ open: false });
    if (action === "doc-attach") {
      return doc({ phase: "ready", file: { name: message.name, size: message.size, kind: QuickCalDocuments.fileKind(message.name), pages: 4, characters: 9000 }, message: "" });
    }
    if (action === "doc-remove") return doc({ phase: "empty", file: null, items: [], instructions: "" });
    if (action === "doc-analyze") {
      state.input = "";
      return doc({ phase: "review", instructions: message.instructions, items: QuickCalDocuments.sanitizeItems(SYLLABUS_ITEMS), message: "" });
    }
    if (action === "doc-decide" || action === "doc-edit") {
      let error = "";
      const items = state.doc.items.map((item) => {
        if (item.id !== message.itemId) return item;
        const changed = action === "doc-decide" ? QuickCalDocuments.decide(item, message.decision) : QuickCalDocuments.applyEdit(item, message.patch);
        if (!changed.ok) { error = changed.error; return item; }
        return changed.item;
      });
      return Object.assign(doc({ items: items }), { ok: !error, error: error || undefined });
    }
    if (action === "doc-create") {
      const items = state.doc.items.map((item) => item.decision === "approved"
        ? Object.assign({}, item, { result: { ok: true, kind: "event", id: item.eventId, link: "https://www.google.com/calendar/event?eid=" + item.eventId } })
        : item);
      return doc({ items: items, message: "Created 1 event." });
    }
    return { ok: false };
  }
  globalThis.chrome = {
    runtime: {
      getURL(file) { return ${JSON.stringify(pathToFileURL(root).href + "/")} + file; },
      sendMessage(message) {
        calls.push(JSON.parse(JSON.stringify(message)));
        return Promise.resolve(background(message));
      },
      onMessage: { addListener(fn) { listeners.push(fn); }, removeListener() {} },
    },
    storage: {
      session: {},
      onChanged: { addListener(fn) { changeListeners.push(fn); } },
    },
    extension: { inIncognitoContext: false },
  };
  globalThis.quickcalTest = { calls: calls, state: () => state };
</script>
<script src="${url("content/widget.js")}"></script>
<script>
  const failures = [];
  function check(name, ok, detail) {
    if (!ok) failures.push(name + (detail === undefined ? "" : " (" + detail + ")"));
  }
  function shadow() { return document.getElementById("quickcal-ai-host").shadowRoot; }
  function $(selector) { return shadow().querySelector(selector); }
  function $$(selector) { return Array.from(shadow().querySelectorAll(selector)); }
  function rect(selector) { const node = typeof selector === "string" ? $(selector) : selector; return node.getBoundingClientRect(); }
  function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms || 0)); }
  async function settle() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); await wait(0); }
  function finish() {
    document.getElementById("result").textContent = failures.length ? "QUICKCAL_FAIL " + failures.join("; ") : "QUICKCAL_PASS";
  }
  function enter(target) {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
  }
  function typeInto(target, text) {
    target.value = text;
    target.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function luminance(color) {
    const parts = color.match(/[\\d.]+/g).slice(0, 3).map(Number).map((value) => {
      const channel = value / 255;
      return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2];
  }
  function contrast(a, b) {
    const one = luminance(a);
    const two = luminance(b);
    return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05);
  }
  function ready(run) {
    const host = document.getElementById("quickcal-ai-host");
    const link = host.shadowRoot.querySelector("link");
    const go = () => setTimeout(() => run().catch((error) => { failures.push("threw " + error.message); finish(); }), 50);
    if (host.dataset.open === "true") go();
    else link.addEventListener("load", go);
  }
  ready(async () => {
    await settle();
    ${script}
  });
</script>
`;
}
