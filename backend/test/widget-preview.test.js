import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const chrome = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
].find((candidate) => candidate && existsSync(candidate));

function fileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

const page = `<!DOCTYPE html>
<meta charset="utf-8">
<title>QuickCalAI preview checks</title>
<pre id="result">pending</pre>
<script src="${fileUrl(path.join(root, "shared/schedule.js"))}"></script>
<script src="${fileUrl(path.join(root, "shared/preview.js"))}"></script>
<script src="${fileUrl(path.join(root, "shared/startup.js"))}"></script>
<script>
  const calls = [];
  let release = null;
  let nextResult = null;
  globalThis.chrome = {
    runtime: {
      getURL(file) {
        return ${JSON.stringify(fileUrl(root) + "/")} + file;
      },
      sendMessage(message) {
        calls.push(message);
        if (message && message.type === "quickcal-backend") return Promise.resolve({ ok: true });
        if (message && message.type === "quickcal-voice") {
          return Promise.resolve({ ok: false, phase: "idle", error: "QuickCalAI could not find a microphone." });
        }
        if (message.action === "status" || message.action === "active" || message.action === "new" || message.action === "open-settings") {
          return Promise.resolve({ ok: true, connected: true, quickcalReady: true, event: null });
        }
        return new Promise((resolve) => {
          release = () => resolve(nextResult);
        });
      },
      onMessage: { addListener() {}, removeListener() {} },
    },
  };
</script>
<script src="${fileUrl(path.join(root, "content/widget.js"))}"></script>
<script>
  const failures = [];
  function check(name, ok) {
    if (!ok) failures.push(name);
  }
  function rootNode() {
    return document.getElementById("quickcal-ai-host").shadowRoot;
  }
  function input() {
    return rootNode().querySelector("#quickcal-input");
  }
  function enter(target, extra) {
    target.dispatchEvent(new KeyboardEvent("keydown", Object.assign({
      key: "Enter",
      bubbles: true,
      cancelable: true,
    }, extra || {})));
  }
  function finish() {
    const result = document.getElementById("result");
    result.textContent = failures.length ? "QUICKCAL_FAIL " + failures.join("; ") : "QUICKCAL_PASS " + window.innerWidth;
  }
  function ready(run) {
    const host = document.getElementById("quickcal-ai-host");
    if (!host) {
      failures.push("host");
      finish();
      return;
    }
    const link = host.shadowRoot.querySelector("link");
    if (host.dataset.open === "true") run();
    else link.addEventListener("load", run);
    link.addEventListener("error", () => {
      failures.push("css");
      finish();
    });
  }

  async function settle() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  ready(async () => {
    await settle();
    const field = input();
    const shadow = rootNode();
    const parses = () => calls.filter((message) => message.type === "quickcal-parse");
    const creates = () => calls.filter((message) => message.action === "create");
    const updates = () => calls.filter((message) => message.action === "update");
    const bar = shadow.querySelector(".bar");
    const rect = bar.getBoundingClientRect();
    field.focus({ focusVisible: true });
    const glow = getComputedStyle(bar).boxShadow;
    const shellStyle = getComputedStyle(shadow.querySelector(".shell"));
    check("mic ready", shadow.querySelector(".mic").disabled === false && shadow.querySelector(".mic").getAttribute("aria-label") === "Start voice input");
    field.value = "typed draft";
    shadow.querySelector(".mic").click();
    await settle();
    check("voice failure keeps draft", field.value === "typed draft" && parses().length === 0);
    check("voice error is simulated", shadow.querySelector(".status").textContent.includes("could not find a microphone"));
    field.value = "";
    check("icons", !!shadow.querySelector("img[src*='calendar.svg']") && !!shadow.querySelector("img[src*='clock.svg']") && !!shadow.querySelector("img[src*='check.svg']"));
    check("chevron", shadow.querySelector(".dismiss").getAttribute("aria-label") === "Hide QuickCalAI" && !!shadow.querySelector(".dismiss img[src*='chevron.svg']"));
    check("no external close", shadow.querySelector(".close") === null);
    check("no panel", shellStyle.backgroundColor === "rgba(0, 0, 0, 0)" && (shellStyle.borderTopWidth === "0px" || shellStyle.borderTopStyle === "none"));
    check("focus glow", glow.indexOf("138, 164, 214") !== -1);
    check("pill inset", rect.left >= 8 && rect.right <= window.innerWidth - 8 && rect.bottom <= window.innerHeight - 8 && rect.top >= 8);
    check("narrow window " + window.innerWidth, window.innerWidth <= 520 && window.innerWidth >= 320);
    check("no horizontal overflow", document.documentElement.scrollWidth <= window.innerWidth + 1);
    field.value = "Coffee with Alex tomorrow at 10 AM";
    enter(field, { isComposing: true });
    check("composition ignored", parses().length === 0);

    const preview = {
      ok: true,
      event: {
        title: "Coffee with Alex <script>",
        date: "2026-10-17",
        endDate: "2026-10-17",
        startTime: "10:00",
        endTime: "11:00",
        timeZone: "America/Los_Angeles",
        location: "Avila",
        needsClarification: false,
        durationDefaulted: true,
        clarificationQuestions: [],
      },
    };
    const saved = {
      ok: true,
      summary: "Coffee with Alex <script>",
      title: "Coffee with Alex <script>",
      date: "2026-10-17",
      endDate: "2026-10-17",
      startTime: "10:00",
      endTime: "11:00",
      dateText: "Oct 17, 2026",
      timeText: "10:00–11:00 AM",
      timeZone: "America/Los_Angeles",
      location: "Avila",
      htmlLink: "https://calendar.google.com/calendar/event?eid=abc",
    };
    nextResult = preview;
    enter(field);
    enter(field);
    check("one request", parses().length === 1);
    check("message", parses()[0].text === "Coffee with Alex tomorrow at 10 AM" && typeof parses()[0].timeZone === "string" && !parses()[0].currentEvent);
    release();
    await settle();
    function visibleAction(text) {
      return Array.from(shadow.querySelectorAll("button.action, a.action")).find((node) => !node.hidden && node.textContent === text) || null;
    }
    check("creating", shadow.querySelector(".creating").hidden === false && shadow.querySelector(".success").hidden === true);
    check("one create", creates().length === 1);
    check("uses draft", creates()[0].event.title === "Coffee with Alex <script>" && creates()[0].event.endTime === "11:00");
    enter(field);
    check("second enter waits", creates().length === 1 && parses().length === 1);
    nextResult = { ok: false, error: "Google Calendar could not save this event." };
    release();
    await settle();
    check("error keeps draft", field.value === "Coffee with Alex tomorrow at 10 AM");
    check("error is not success", shadow.querySelector(".success").hidden === true);
    check("error text", shadow.querySelector(".save-error").textContent.includes("could not save"));
    check("retry", visibleAction("Try again") !== null);
    nextResult = saved;
    visibleAction("Try again").click();
    check("retry same draft", creates().length === 2 && creates()[1].event.title === creates()[0].event.title && creates()[1].event.startTime === "10:00" && creates()[1].event.endTime === "11:00");
    check("still not created", shadow.querySelector(".success").hidden === true);
    release();
    await settle();
    const expanded = shadow.querySelector(".card").getBoundingClientRect();
    check("created", shadow.querySelector(".success").hidden === false && shadow.textContent.includes("Event successfully created"));
    check("saved title", shadow.querySelector(".event-title").textContent === "Coffee with Alex <script>");
    check("saved when", shadow.textContent.includes("Oct 17, 2026") && shadow.textContent.includes("10:00–11:00 AM"));
    check("view link", shadow.querySelector("a.action").href.indexOf("https://calendar.google.com/calendar/event?eid=abc") === 0);
    check("follow-up", field.value === "" && field.placeholder === "Tell me what to change…");
    check("new event", visibleAction("New event") !== null);
    check("card inset", expanded.left >= 8 && expanded.right <= window.innerWidth - 8 && expanded.bottom <= window.innerHeight - 8);

    field.value = "Move it";
    nextResult = {
      ok: true,
      event: {
        title: null,
        date: null,
        startTime: null,
        endTime: null,
        timeZone: "America/Los_Angeles",
        location: null,
        needsClarification: true,
        durationDefaulted: false,
        clarificationQuestions: ["Which time should this event use?"],
      },
    };
    enter(field);
    release();
    await settle();
    check("ambiguous keeps details", shadow.textContent.includes("10:00–11:00 AM") && shadow.textContent.includes("Which time should this event use?"));
    check("ambiguous does not update", updates().length === 0 && creates().length === 2);

    field.value = "Move it to 11 AM";
    nextResult = {
      ok: true,
      event: {
        title: "Coffee with Alex <script>",
        date: "2026-10-17",
        endDate: "2026-10-17",
        startTime: "11:00",
        endTime: "11:30",
        timeZone: "America/Los_Angeles",
        location: "Avila",
        needsClarification: false,
        durationDefaulted: false,
        clarificationQuestions: [],
      },
    };
    enter(field);
    release();
    await settle();
    check("edit uses current event", parses()[parses().length - 1].currentEvent.startTime === "10:00" && parses()[parses().length - 1].currentEvent.endTime === "11:00");
    check("one update", updates().length === 1 && updates()[0].event.startTime === "11:00" && updates()[0].event.endTime === "11:30" && !updates()[0].event.id);
    check("same creates", creates().length === 2);
    check("updating", shadow.textContent.includes("Updating event…") && shadow.textContent.includes("10:00–11:00 AM"));
    nextResult = Object.assign({}, saved, { startTime: "11:00", endTime: "11:30", timeText: "11:00–11:30 AM" });
    release();
    await settle();
    check("updated time", shadow.textContent.includes("11:00–11:30 AM") && !shadow.querySelector(".schedule").textContent.includes("10:00–11:00 AM"));

    visibleAction("New event").click();
    await settle();
    check("creation mode", document.getElementById("quickcal-ai-host").dataset.mode === "input" && field.placeholder === "Coffee with Alex tomorrow at 10 AM");

    field.value = "Coffee with Alex";
    nextResult = {
      ok: true,
      event: {
        title: "Coffee with Alex",
        date: null,
        startTime: null,
        endTime: null,
        timeZone: "America/Los_Angeles",
        location: null,
        needsClarification: true,
        durationDefaulted: false,
        clarificationQuestions: ["What date should I use?", "What date should I use?"],
      },
    };
    enter(field);
    release();
    await settle();
    check("question once", shadow.querySelectorAll(".questions li").length === 1);
    check("question", shadow.textContent.includes("What date should I use?"));
    check("no create for clarification", creates().length === 2);

    field.value = "Coffee with Alex tomorrow at 10 AM";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    nextResult = { ok: false, error: "QuickCalAI could not reach QuickCal. Try again." };
    enter(field);
    release();
    await settle();
    check("unavailable", shadow.querySelector(".status").textContent.includes("could not reach QuickCal"));
    check("text kept", field.value === "Coffee with Alex tomorrow at 10 AM" && shadow.querySelector(".body").hidden === true);

    nextResult = preview;
    enter(field);
    const held = release;
    field.value = "Changed request";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    held();
    await settle();
    check("stale edit", shadow.querySelector(".body").hidden === true && creates().length === 2);

    field.value = "Coffee with Alex tomorrow at 10 AM";
    enter(field);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    release();
    await settle();
    check("closed during parse", document.getElementById("quickcal-ai-host").dataset.open === "false" && creates().length === 2);
    globalThis.__quickcalAi.toggle();
    check("reopen input", document.getElementById("quickcal-ai-host").dataset.mode === "input");
    check("still one host", document.querySelectorAll("#quickcal-ai-host").length === 1);

    field.value = "Make a date every Friday with John at 6pm";
    nextResult = {
      ok: true,
      event: {
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
        recurrenceText: "Every Friday",
        seriesEndText: "No end date",
      },
    };
    enter(field);
    release();
    await settle();
    check("weekly creating", shadow.textContent.includes("Every Friday") && shadow.textContent.includes("No end date") && shadow.textContent.includes("Oct 23, 2026"));
    nextResult = {
      ok: true,
      summary: "Date with John",
      title: "Date with John",
      date: "2026-10-23",
      endDate: "2026-10-23",
      startTime: "18:00",
      endTime: "19:00",
      dateText: "Oct 23, 2026",
      timeText: "6:00\u20137:00 PM",
      timeZone: "America/Los_Angeles",
      location: null,
      recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
      recurrenceText: "Every Friday",
      seriesEndText: "No end date",
      htmlLink: "https://calendar.google.com/calendar/event?eid=weekly",
    };
    release();
    await settle();
    check("weekly saved", shadow.textContent.includes("Event successfully created") && shadow.textContent.includes("Every Friday") && shadow.textContent.includes("No end date") && shadow.textContent.includes("America/Los_Angeles"));
    const updatesBeforeSeries = updates().length;
    field.value = "Move it to 7 PM";
    nextResult = {
      ok: true,
      event: {
        title: "Date with John",
        date: "2026-10-23",
        endDate: "2026-10-23",
        startTime: "18:00",
        endTime: "19:00",
        timeZone: "America/Los_Angeles",
        location: null,
        needsClarification: true,
        durationDefaulted: false,
        clarificationQuestions: ["Should this change the entire weekly series? QuickCal will not change the series unless you say so."],
        recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
      },
    };
    enter(field);
    release();
    await settle();
    check("series edit asks", shadow.textContent.includes("entire weekly series") && updates().length === updatesBeforeSeries);

    visibleAction("New event").click();
    await settle();
    const parsesBeforeReconnect = parses().length;
    const createsBeforeReconnect = creates().length;
    field.value = "Hosted backend test tomorrow at 10 AM for 30 minutes";
    nextResult = {
      ok: true,
      event: {
        title: "Hosted backend test",
        date: "2026-10-20",
        endDate: "2026-10-20",
        startTime: "10:00",
        endTime: "10:30",
        timeZone: "America/Los_Angeles",
        location: null,
        needsClarification: false,
        durationDefaulted: false,
        clarificationQuestions: [],
      },
    };
    enter(field);
    release();
    await settle();
    nextResult = {
      ok: false,
      state: "disconnected",
      error: "Connect Google Calendar before saving this event.",
    };
    release();
    await settle();
    check("save asks to connect", shadow.querySelector(".save-error").textContent.includes("Connect Google Calendar before saving"));
    check("connect action", visibleAction("Connect Google Calendar") !== null);
    check("draft kept", field.value === "Hosted backend test tomorrow at 10 AM for 30 minutes");
    globalThis.__quickcalAi.toggle();
    globalThis.__quickcalAi.toggle();
    await settle();
    check("reopen clears stale connect error", shadow.querySelector(".save-error").hidden === true);
    check("retry after reconnect", visibleAction("Try again") !== null);
    check("reopen does not create", creates().length === createsBeforeReconnect + 1 && parses().length === parsesBeforeReconnect + 1);
    field.focus();
    check("focus does not create", creates().length === createsBeforeReconnect + 1 && parses().length === parsesBeforeReconnect + 1);
    nextResult = {
      ok: true,
      summary: "Hosted backend test",
      title: "Hosted backend test",
      date: "2026-10-20",
      endDate: "2026-10-20",
      startTime: "10:00",
      endTime: "10:30",
      dateText: "Oct 20, 2026",
      timeText: "10:00–10:30 AM",
      timeZone: "America/Los_Angeles",
      htmlLink: "https://calendar.google.com/calendar/event?eid=hosted",
    };
    visibleAction("Try again").click();
    check("retry does not reparse", parses().length === parsesBeforeReconnect + 1 && creates().length === createsBeforeReconnect + 2);
    check("retry reuses draft", creates()[creates().length - 1].event.title === "Hosted backend test" && creates()[creates().length - 1].event.startTime === "10:00" && creates()[creates().length - 1].event.endTime === "10:30");
    release();
    await settle();
    check("retried save succeeds", shadow.textContent.includes("Event successfully created"));
    finish();
  });
</script>
`;

describe("floating preview", () => {
  it("covers preview, questions, failure, duplicate Enter, and stale responses", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "quickcal-preview-"));
    const profile = mkdtempSync(path.join(tmpdir(), "quickcal-chrome-"));
    const htmlPath = path.join(directory, "preview.html");
    writeFileSync(htmlPath, page);
    const output = await new Promise((resolve, reject) => {
      const child = spawn(chrome, [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--disable-extensions",
        "--user-data-dir=" + profile,
        "--dump-dom",
        "--allow-file-access-from-files",
        "--window-size=400,720",
        "--virtual-time-budget=8000",
        fileUrl(htmlPath),
      ], { windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    try {
      const passed = output.stdout.match(/QUICKCAL_PASS (\d+)/);
      assert.ok(passed, output.stdout + "\n" + output.stderr);
      assert.ok(Number(passed[1]) <= 520, output.stdout);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      rmSync(profile, { recursive: true, force: true });
    }
  });
});
