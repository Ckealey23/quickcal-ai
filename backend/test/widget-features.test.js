import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chromePath, runPage } from "./support/chrome.js";
import { widgetPage } from "./support/widget-page.js";

async function expectPass(script, options) {
  if (!chromePath) assert.fail("Chrome is required for widget checks.");
  const output = await runPage(widgetPage(script, options), options);
  assert.match(output.stdout, /QUICKCAL_PASS/, output.stdout.slice(-3000) + "\n" + output.stderr.slice(-2000));
}

// Checks that run against the bar while the panel opens, in the default
// bottom-right placement and in a dragged position near the top.
const panelGeometry = `
  const bar = $(".bar");
  const before = rect(bar);
  check("paperclip visible", !$(".attach").hidden && rect(".attach").width > 0);
  check("paperclip left of input", rect(".attach").right <= rect("#quickcal-input").left + 1);
  check("mic still rightmost", rect(".mic").right <= before.right && rect(".mic").left > rect("#quickcal-input").left);
  check("bar height unchanged", Math.round(before.height) === 60, before.height);
  check("no time editor before a request", $(".time-edit").hidden === true);
  check("panel starts hidden", $(".docs").hidden === true);
  $(".attach").click();
  await settle();
  await wait(320);
  const after = rect(bar);
  check("bar does not move", Math.abs(after.top - before.top) < 0.5 && Math.abs(after.left - before.left) < 0.5, before.top + "->" + after.top);
  check("bar keeps size", Math.abs(after.width - before.width) < 0.5 && Math.abs(after.height - before.height) < 0.5);
  check("panel open", $(".docs").hidden === false && $(".docs").dataset.state === "settled", $(".docs").dataset.state);
  check("panel unclipped", getComputedStyle($(".docs-sheet")).clipPath === "none" && getComputedStyle($(".docs-body")).opacity === "1");
  check("open state marked", $(".attach").getAttribute("aria-expanded") === "true");
  const sheet = rect(".docs-sheet");
  check("sheet aligned with bar", Math.abs(sheet.left - after.left) < 1 && Math.abs(sheet.right - after.right) < 1, sheet.left + "/" + after.left);
  const dir = $(".docs").dataset.dir;
  if (dir === "down") check("sheet starts under the bar", Math.abs(sheet.top - after.top) < 1 && sheet.bottom > after.bottom + 100);
  else check("sheet ends at the bar", Math.abs(sheet.bottom - after.bottom) < 1 && sheet.top < after.top - 100);
  check("sheet on screen", sheet.top >= 0 && sheet.bottom <= window.innerHeight, sheet.top + "," + sheet.bottom);
  check("sheet background matches bar", getComputedStyle($(".docs-sheet")).backgroundColor === getComputedStyle(bar).backgroundColor);
  check("drop zone text", $(".docs-drop-title").textContent === "Drag and drop a file here");
  check("browse button", $(".docs-browse").textContent === "Browse Files");
`;

describe("upload panel layout", () => {
  it("opens below a bar placed near the top without moving it", async () => {
    await expectPass(panelGeometry + `
      check("opens downward with room below", $(".docs").dataset.dir === "down");
      $(".attach").click();
      await settle();
      await wait(320);
      check("collapses", $(".docs").hidden === true && $(".attach").getAttribute("aria-expanded") === "false");
      check("bar still fixed after collapse", Math.abs(rect(bar).top - before.top) < 0.5);
      finish();
    `, { layout: { scale: 1, left: 300, top: 80 } });
  });

  it("opens upward in the default bottom-right spot without moving the bar", async () => {
    await expectPass(panelGeometry + `
      check("flips upward at the bottom edge", $(".docs").dataset.dir === "up");
      finish();
    `);
  });

  it("keeps the bar fixed at a larger scale", async () => {
    await expectPass(panelGeometry + "finish();", { layout: { scale: 1.3, left: 200, top: 60 } });
  });
});

describe("document workflow in the panel", () => {
  it("uploads by drop and browse, shows a readable file name, and filters with the main input", async () => {
    await expectPass(`
      $(".attach").click();
      await settle();
      await wait(300);
      let clicked = false;
      const original = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () { if (this.type === "file") clicked = true; else original.call(this); };
      $(".docs-browse").click();
      HTMLInputElement.prototype.click = original;
      check("browse opens the file picker", clicked);

      const transfer = new DataTransfer();
      const name = "BIO-101 Fall 2026 Syllabus and Course Schedule (final revised version).pdf";
      transfer.items.add(new File(["%PDF-1.4 syllabus"], name, { type: "application/pdf" }));
      $(".docs-sheet").dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      check("drag feedback", $(".docs").classList.contains("dragging"));
      $(".docs-sheet").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      await settle();
      await wait(50);
      const attach = quickcalTest.calls.find((message) => message.action === "doc-attach");
      check("upload sent", !!attach && attach.name === name && atob(attach.data) === "%PDF-1.4 syllabus");
      check("drag feedback cleared", !$(".docs").classList.contains("dragging"));
      const fileName = $(".docs-file-name");
      check("file name shown", fileName.textContent === name && fileName.title === name);
      check("long name truncates", fileName.scrollWidth > fileName.clientWidth && getComputedStyle(fileName).textOverflow === "ellipsis");
      const ratio = contrast(getComputedStyle(fileName).color, getComputedStyle($(".docs-file")).backgroundColor);
      check("file name contrast", ratio >= 7, ratio.toFixed(2));
      check("remove offered", $(".docs-remove").textContent === "Remove" && !$(".docs-remove").hidden);
      check("analyze offered", $(".docs-prompt").hidden === false && $(".docs-analyze").textContent === "Analyze Document");

      const field = $("#quickcal-input");
      field.focus();
      typeInto(field, "Only find midterms and final exams.");
      enter(field);
      await settle();
      const analysis = quickcalTest.calls.find((message) => message.action === "doc-analyze");
      check("instructions go to the document", !!analysis && analysis.instructions === "Only find midterms and final exams.");
      check("no ordinary submission", !quickcalTest.calls.some((message) => message.action === "submit"));
      check("filter shown", $(".docs-filter").textContent.includes("Only find midterms and final exams."));
      field.blur();
      await settle();
      check("input cleared after analysis", field.value === "" && quickcalTest.state().input === "", field.value);
      const rows = $$(".docs-item");
      check("three proposals", rows.length === 3, rows.length);
      check("all undecided", rows.every((row) => row.dataset.decision === "pending"));
      check("create disabled until approval", $(".docs-create").disabled === true);
      check("missing time flagged", rows[2].textContent.includes("Time not stated in the document."));
      check("incomplete item cannot be approved", rows[2].querySelector(".docs-approve").disabled === true);
      check("default end shown", rows[1].textContent.includes("1 hour is assumed"));
      check("source shown", rows[0].querySelector(".docs-item-source").textContent.includes("page 2"));

      rows[0].querySelector(".docs-approve").click();
      await settle();
      check("approved", $$(".docs-item")[0].dataset.decision === "approved");
      check("label counts approvals", $(".docs-create").textContent === "Create 1 Approved Event" && $(".docs-create").disabled === false);
      $$(".docs-item")[1].querySelector(".docs-skip").click();
      await settle();
      check("skipped", $$(".docs-item")[1].dataset.decision === "skipped");

      // Edit the final exam's time with the 5-minute dropdown.
      $$(".docs-item")[2].querySelector(".docs-edit").click();
      await settle();
      const form = $$(".docs-item")[2].querySelector(".docs-edit-form");
      check("edit form open", form.hidden === false);
      form.querySelector(".docs-time").click();
      await settle();
      const options = $$(".time-menu .time-option");
      check("five-minute options", options.length === 288 && options[1].textContent === "12:05 AM");
      const eight = options.find((option) => option.textContent === "8:00 AM");
      eight.click();
      await settle();
      check("start picked", form.querySelector(".docs-time").textContent === "8:00 AM");
      form.querySelector(".docs-form-actions .docs-action").click();
      await settle();
      const edited = quickcalTest.calls.filter((message) => message.action === "doc-edit").pop();
      check("edit sent", !!edited && edited.patch.startTime === "08:00" && edited.patch.endTime === "09:00");
      check("edit closes", $$(".docs-item")[2].querySelector(".docs-edit-form").hidden === true);
      check("now approvable", $$(".docs-item")[2].querySelector(".docs-approve").disabled === false);
      $$(".docs-item")[2].querySelector(".docs-approve").click();
      await settle();
      check("label updates", $(".docs-create").textContent === "Create 2 Approved Events", $(".docs-create").textContent);

      $(".docs-create").click();
      await settle();
      check("create sent once", quickcalTest.calls.filter((message) => message.action === "doc-create").length === 1);
      check("results shown", $$(".docs-item").filter((row) => row.dataset.decision === "created").length === 2);
      check("summary", $(".docs-message").textContent === "Created 1 event.");
      check("view link", $$(".docs-item")[0].querySelector(".docs-item-result a").href.startsWith("https://www.google.com/calendar/"));
      finish();
    `, { layout: { scale: 1, left: 300, top: 40 }, size: "1100,1000", budget: 9000 });
  });
});

describe("panel and ordinary input stay separate", () => {
  it("collapses the panel on Escape and sends highlighted text down the ordinary path", async () => {
    await expectPass(`
      $(".attach").click();
      await settle();
      await wait(320);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle();
      await wait(320);
      check("escape collapses the panel", $(".docs").hidden === true);
      check("widget stays open", document.getElementById("quickcal-ai-host").dataset.open === "true");
      check("review kept", quickcalTest.state().doc && quickcalTest.state().doc.open === false);
      $(".attach").click();
      await settle();
      await wait(320);
      check("reopened", $(".docs").hidden === false);
      const reply = await new Promise((resolve) => {
        const result = listeners[0]({ type: "quickcal-selection", operationId: "sel-1", text: "Lunch with Sam Monday at noon" }, {}, resolve);
        if (result !== true) resolve(null);
      });
      await settle();
      await wait(320);
      const actions = quickcalTest.calls.map((message) => message.action);
      check("panel closed for the event", actions.includes("doc-close") && $(".docs").hidden === true);
      const submit = quickcalTest.calls.find((message) => message.action === "submit");
      check("ordinary submit", !!submit && submit.text === "Lunch with Sam Monday at noon");
      check("no document analysis", !actions.includes("doc-analyze"));
      check("event saved", $(".success").hidden === false);
      finish();
    `, { layout: { scale: 1, left: 300, top: 60 } });
  });
});

describe("task results", () => {
  it("shows a created task without a time editor and links to Google Tasks", async () => {
    await expectPass(`
      globalThis.nextTask = true;
      const field = $("#quickcal-input");
      field.focus();
      typeInto(field, "Remind me to submit my report tomorrow");
      enter(field);
      await settle();
      check("task saved", $(".success").hidden === false && $(".success p").textContent === "Task successfully created");
      check("no time editor for tasks", $(".time-edit").hidden === true);
      check("due date shown", $(".summary").textContent.includes("Nov 17, 2026"));
      const link = $$(".actions .action").find((node) => node.tagName === "A");
      check("tasks link", !!link && !link.hidden && link.textContent === "View in Google Tasks" && link.href.startsWith("https://tasks.google.com/"));
      check("no time zone line for a task", $$(".meta").every((node) => node.hidden || !/America/.test(node.textContent)));
      check("ordinary placeholder", field.placeholder === "Coffee with Alex tomorrow at 10 AM");
      finish();
    `, { layout: { scale: 1, left: 300, top: 60 } });
  });
});

describe("success card details", () => {
  it("hides the raw time zone and drops an overlap warning once the session clears it", async () => {
    await expectPass(`
      const field = $("#quickcal-input");
      field.focus();
      typeInto(field, "Coffee with Alex tomorrow at 9 AM");
      enter(field);
      await settle();
      check("saved", $(".success").hidden === false);
      check("no raw time zone", !shadow().textContent.includes("America/Los_Angeles"));
      check("title, date, and time still shown", $(".summary").textContent.includes("Coffee with Alex") && $(".summary").textContent.includes("Nov 17, 2026") && $(".summary").textContent.includes("9:00"));
      const base = quickcalTest.state();
      const notice = { checkId: "c1", savedEventId: "evt123", status: "conflicts", statusText: "2 overlapping events found.", lines: ["Overlaps Standup 9:00-9:30 AM", "Overlaps Gym 9:30-10:00 AM"], horizonText: "", incomplete: false, needsScopes: false };
      const push = (patch) => listeners[0]({ type: "quickcal-widget", action: "render", session: Object.assign({}, base, patch, { revision: base.revision + 10 + Math.random() }) }, {}, () => {});
      push({ conflictNotice: notice, statusText: notice.statusText });
      await settle();
      check("overlap shown", $(".status").hidden === false && $(".status").textContent === "2 overlapping events found." && $$(".questions li").length === 2);
      push({ conflictNotice: null, statusText: "" });
      await settle();
      check("overlap cleared", $(".status").hidden === true && $$(".questions li").length === 0, $(".status").textContent);
      check("card kept", $(".success").hidden === false);
      push({ conflictNotice: { checkId: "c2", savedEventId: "evt123", status: "checking", statusText: "Checking for conflicts\\u2026", lines: [] }, statusText: "Checking for conflicts\\u2026" });
      await settle();
      push({ conflictNotice: { checkId: "c2", savedEventId: "evt123", status: "clear", statusText: "", lines: [], horizonText: "" }, statusText: "" });
      await settle();
      check("checking message cleared when clear", $(".status").hidden === true, $(".status").textContent);
      finish();
    `, { layout: { scale: 1, left: 300, top: 60 } });
  });
});

describe("ordinary events stay automatic", () => {
  it("creates an event with no confirmation and lets the saved time change in 5-minute steps", async () => {
    await expectPass(`
      const field = $("#quickcal-input");
      field.focus();
      typeInto(field, "Coffee with Alex tomorrow at 9 AM");
      enter(field);
      await settle();
      const submits = quickcalTest.calls.filter((message) => message.action === "submit");
      check("ordinary submit", submits.length === 1 && submits[0].text === "Coffee with Alex tomorrow at 9 AM");
      check("no document calls", !quickcalTest.calls.some((message) => /^doc-/.test(message.action)));
      check("saved immediately", $(".success").hidden === false && $(".success p").textContent === "Event successfully created");
      check("no approval controls", !$$("button").some((button) => /confirm|approve/i.test(button.textContent) && button.offsetParent));
      const timeButton = $(".time-edit");
      check("time is clickable after saving", timeButton.hidden === false && timeButton.textContent.includes("9:00–10:00 AM"));
      timeButton.click();
      await settle();
      const lists = $$(".time-menu .time-list");
      check("start and end columns", lists.length === 2);
      const start = Array.from(lists[0].children);
      const selected = start.find((option) => option.getAttribute("aria-selected") === "true");
      check("current start highlighted", !!selected && selected.textContent === "9:00 AM");
      check("scrolled to current", lists[0].scrollTop > 0);
      check("focus on current", shadow().activeElement === selected);
      selected.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
      check("keyboard moves", shadow().activeElement.textContent === "9:05 AM");
      check("end list after start", Array.from(lists[1].children)[0].textContent === "9:05 AM");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      await settle();
      check("escape closes the menu only", $(".time-menu").hidden === true && document.getElementById("quickcal-ai-host").dataset.open === "true");
      timeButton.click();
      await settle();
      const quarter = $$(".time-menu .time-list")[0].querySelector('[data-value="09:15"]');
      quarter.click();
      await settle();
      const retime = quickcalTest.calls.find((message) => message.action === "retime");
      check("updates the same event", !!retime && retime.eventId === "evt123" && retime.startTime === "09:15" && retime.endTime === "10:15");
      check("no new event", quickcalTest.calls.filter((message) => message.action === "submit").length === 1);
      check("time text updated", $(".time-edit").textContent.includes("9:15–10:15 AM"));
      finish();
    `, { layout: { scale: 1, left: 300, top: 60 } });
  });
});
