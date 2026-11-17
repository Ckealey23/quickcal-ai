import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";
import { referenceClock } from "../src/clock.js";
import { applyClarification, applySchedule, prepareForSave } from "../src/schedule.js";
import { validateExtraction, validateBatchEvent } from "../src/validate.js";
import { validateProposals } from "../src/documents.js";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";
// Fixed local reference: Monday, November 16, 2026 afternoon Pacific.
const clock = referenceClock(new Date("2026-11-16T21:00:00Z"), zone);

function loadLookup() {
  const sandbox = { Intl, Date, Math, Number, String, Object, Array, JSON, console };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context, {
    filename: "shared/schedule.js",
  });
  runInContext(readFileSync(path.join(root, "shared/lookup.js"), "utf8"), context, {
    filename: "shared/lookup.js",
  });
  return sandbox.QuickCalLookup;
}

function extraction(overrides = {}) {
  return {
    title: "Coffee with Alex",
    date: "2026-11-17",
    endDate: null,
    startTime: null,
    endTime: null,
    allDay: false,
    timeZone: zone,
    location: null,
    recurrence: null,
    notificationAction: "preserve",
    notificationOverrides: [],
    needsClarification: false,
    clarificationQuestions: [],
    intent: "create",
    operation: {
      target: null,
      searchDate: null,
      searchTime: null,
      destinationDate: null,
      destinationTime: null,
      destinationEndTime: null,
      scope: "occurrence",
      selection: [],
      durationMinutes: null,
      windowStart: null,
      windowEnd: null,
      preference: null,
      searchEndDate: null,
      readOnly: null,
    },
    ...overrides,
  };
}

describe("date-only all-day creation", () => {
  it("creates a single-day all-day event from text without inventing a time", () => {
    const result = applySchedule(extraction(), "Coffee with Alex tomorrow", clock);
    assert.equal(result.allDay, true);
    assert.equal(result.date, "2026-11-17");
    assert.equal(result.endDate, "2026-11-17");
    assert.equal(result.startTime, null);
    assert.equal(result.endTime, null);
    assert.equal(result.needsClarification, false);
    const prepared = prepareForSave(result);
    assert.ok(prepared);
    assert.equal(prepared.allDay, true);
    assert.equal(prepared.exclusiveEndDate, "2026-11-18");
    assert.equal(prepared.timeText, "All day");
    assert.match(prepared.dateText, /Nov 17, 2026/);
  });

  it("creates an inclusive multi-day all-day trip with exclusive API end", () => {
    const result = applySchedule(
      extraction({
        title: "Trip to Bahamas",
        date: "2026-11-18",
        endDate: "2026-12-16",
        allDay: true,
      }),
      "Trip to Bahamas from the 18th to next month 16th",
      clock
    );
    assert.equal(result.allDay, true);
    assert.equal(result.date, "2026-11-18");
    assert.equal(result.endDate, "2026-12-16");
    assert.equal(result.needsClarification, false);
    const prepared = prepareForSave(result);
    assert.equal(prepared.exclusiveEndDate, "2026-12-17");
    assert.match(prepared.dateText, /Nov 18, 2026/);
    assert.match(prepared.dateText, /Dec 16, 2026/);
  });

  it("covers Conference December 3-5 as an inclusive all-day span", () => {
    const result = applySchedule(
      extraction({
        title: "Conference",
        date: "2026-12-03",
        endDate: "2026-12-05",
        allDay: true,
      }),
      "Conference December 3-5",
      clock
    );
    assert.equal(result.date, "2026-12-03");
    assert.equal(result.endDate, "2026-12-05");
    assert.equal(prepareForSave(result).exclusiveEndDate, "2026-12-06");
  });

  it("keeps timed defaults and refuses silent all-day when a duration needs a start", () => {
    const timed = applySchedule(
      extraction({ title: "Standup", date: "2026-11-17", startTime: "09:00", endTime: null }),
      "Standup tomorrow at 9 AM",
      clock
    );
    assert.equal(timed.allDay, false);
    assert.equal(timed.startTime, "09:00");
    assert.equal(timed.endTime, "10:00");
    assert.equal(timed.durationDefaulted, true);

    const durationOnly = applySchedule(
      extraction({ title: "Focus block", date: "2026-11-17", startTime: null }),
      "Focus block tomorrow for 30 minutes",
      clock
    );
    assert.equal(durationOnly.allDay, false);
    assert.equal(durationOnly.needsClarification, true);
    assert.match(durationOnly.clarificationQuestions.join(" "), /time/i);
  });

  it("rejects an impossible end ordering instead of inventing dates", () => {
    const result = applySchedule(
      extraction({ title: "Trip", date: "2026-12-16", endDate: "2026-11-18", allDay: true }),
      "Trip from December 16 to November 18",
      clock
    );
    assert.equal(result.needsClarification, true);
    assert.match(result.clarificationQuestions[0], /start and end dates/i);
  });

  it("rejects an invalid calendar day instead of rolling it into another month", () => {
    const result = validateExtraction(
      extraction({
        title: "Offsite",
        date: "2026-11-31",
        startTime: null,
        endTime: null,
        allDay: true,
      }),
      zone
    );
    assert.equal(result.ok, false);
  });

  it("keeps December-to-January year rollover on multi-day all-day spans", () => {
    const result = applySchedule(
      extraction({
        title: "Winter break",
        date: "2026-12-20",
        endDate: "2027-01-05",
        allDay: true,
      }),
      "Winter break from December 20 to next month 5th",
      clock
    );
    assert.equal(result.date, "2026-12-20");
    assert.equal(result.endDate, "2027-01-05");
    assert.equal(prepareForSave(result).exclusiveEndDate, "2027-01-06");
  });
});

describe("clarification continues create", () => {
  it("completes a missing-date create without switching to lookup", () => {
    const draft = {
      title: "Trip to Bahamas",
      date: null,
      endDate: null,
      startTime: null,
      endTime: null,
      allDay: false,
      timeZone: zone,
      location: null,
      recurrence: null,
      reminders: { useDefault: true, overrides: [] },
    };
    const answered = applyClarification(
      extraction({
        title: null,
        date: "2026-11-18",
        endDate: "2026-12-16",
        startTime: null,
        allDay: true,
        intent: "find",
        operation: Object.assign({}, extraction().operation, { target: "Bahamas", searchDate: "2026-11-18" }),
      }),
      draft,
      "from the 18th to next month 16th",
      "Trip to Bahamas",
      clock
    );
    assert.equal(answered.allDay, true);
    assert.equal(answered.date, "2026-11-18");
    assert.equal(answered.endDate, "2026-12-16");
    assert.equal(answered.needsClarification, false);
  });

  it("keeps validation from asking for a start time on date-only creates", () => {
    const result = validateExtraction(
      extraction({
        title: "Coffee with Alex",
        date: "2026-11-17",
        startTime: null,
        endTime: null,
        clarificationQuestions: ["What time does this event start?"],
        needsClarification: true,
      }),
      zone
    );
    assert.equal(result.event.allDay, true);
    assert.equal(result.event.clarificationQuestions.includes("What time does this event start?"), false);
  });
});

describe("batch and document date-only events", () => {
  it("marks highlighted batch date-only drafts as all-day and saveable after schedule", () => {
    const validated = validateBatchEvent(
      {
        ref: "e1",
        title: "Study hall",
        date: "2026-11-18",
        endDate: null,
        startTime: null,
        endTime: null,
        allDay: false,
        timeZone: zone,
        location: null,
        recurrence: null,
        notificationAction: "preserve",
        notificationOverrides: [],
        needsClarification: false,
        clarificationQuestions: [],
      },
      zone,
      "e1"
    );
    assert.equal(validated.ok, true);
    assert.equal(validated.event.allDay, true);
    const scheduled = applySchedule(validated.event, "Study hall Wednesday", clock);
    assert.equal(scheduled.allDay, true);
    assert.equal(scheduled.needsClarification, false);
    assert.ok(prepareForSave(scheduled));
  });

  it("promotes document date-only events to all-day without a time issue", () => {
    const text = "Team offsite: November 18, 2026\nKickoff meeting November 18, 2026 at 10:00 AM";
    const result = validateProposals(
      {
        items: [
          {
            kind: "event",
            title: "Team offsite",
            date: "2026-11-18",
            endDate: null,
            startTime: null,
            endTime: null,
            allDay: false,
            description: null,
            category: null,
            sourceQuote: "Team offsite: November 18, 2026",
            issues: [],
          },
          {
            kind: "event",
            title: "Kickoff meeting",
            date: "2026-11-18",
            endDate: null,
            startTime: "10:00",
            endTime: "11:00",
            allDay: false,
            description: null,
            category: null,
            sourceQuote: "Kickoff meeting November 18, 2026 at 10:00 AM",
            issues: [],
          },
        ],
        warning: null,
      },
      text
    );
    assert.equal(result.items[0].allDay, true);
    assert.equal(result.items[0].startTime, null);
    assert.equal(result.items[1].allDay, false);
    assert.equal(result.items[1].startTime, "10:00");
  });
});

describe("date-only moves preserve local time", () => {
  it("moves a timed event to tomorrow without asking for a new time", () => {
    const lookup = loadLookup();
    const candidate = {
      id: "evt1",
      allDay: false,
      date: "2026-11-16",
      endDate: "2026-11-16",
      startTime: "09:00",
      endTime: "10:30",
      exclusiveEndDate: "",
    };
    const plan = lookup.planMove(candidate, { newDate: "2026-11-17" }, zone);
    assert.equal(plan.ask, undefined);
    assert.equal(plan.date, "2026-11-17");
    assert.equal(plan.startTime, "09:00");
    assert.equal(plan.endTime, "10:30");
    assert.equal(plan.endDate, "2026-11-17");
  });

  it("moves an all-day multi-day event while preserving day count", () => {
    const lookup = loadLookup();
    const candidate = lookup.candidateFrom(
      {
        id: "all1",
        summary: "Trip",
        status: "confirmed",
        htmlLink: "https://calendar.google.com/calendar/event?eid=all1",
        start: { date: "2026-11-18" },
        end: { date: "2026-12-17" },
      },
      zone
    );
    assert.equal(candidate.allDay, true);
    assert.equal(candidate.endDate, "2026-12-16");
    const plan = lookup.planMove(candidate, { newDate: "2026-12-01" }, zone);
    assert.equal(plan.allDay, true);
    assert.equal(plan.date, "2026-12-01");
    assert.equal(plan.endDate, "2026-12-29");
    assert.equal(plan.exclusiveEndDate, "2026-12-30");
  });

  it("lets an explicit destination time override the original time", () => {
    const lookup = loadLookup();
    const plan = lookup.planMove(
      {
        id: "evt2",
        allDay: false,
        date: "2026-11-16",
        endDate: "2026-11-16",
        startTime: "09:00",
        endTime: "10:00",
      },
      { newDate: "2026-11-17", newStartTime: "14:00" },
      zone
    );
    assert.equal(plan.startTime, "14:00");
    assert.equal(plan.endTime, "15:00");
  });

  it("asks when a moved local clock time falls in a DST gap", () => {
    const lookup = loadLookup();
    const plan = lookup.planMove(
      {
        id: "dst1",
        allDay: false,
        date: "2026-03-07",
        endDate: "2026-03-07",
        startTime: "02:30",
        endTime: "03:30",
      },
      { newDate: "2026-03-08" },
      zone
    );
    assert.equal(plan.ask != null, true);
    assert.match(plan.ask, /daylight|does not exist|time/i);
  });
});
