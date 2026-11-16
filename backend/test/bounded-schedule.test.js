import assert from "node:assert/strict";
import { it } from "node:test";
import { referenceClock } from "../src/clock.js";
import { applySchedule, applyClarification, normalizeDraft, prepareForSave, resolveBoundedDates } from "../src/schedule.js";

const zone = "America/Los_Angeles";
const clock = referenceClock(new Date("2026-11-12T02:00:00Z"), zone); // November 11 locally
const plain = (value) => JSON.parse(JSON.stringify(value));
const extraction = (extra = {}) => ({
  title: "Walk the dog", date: null, startTime: null, endTime: null,
  timeZone: zone, location: null, recurrence: null,
  clarificationQuestions: ["What date?", "Single event or weekly series?"], ...extra,
});

it("resolves tmr through Saturday inclusively using the local date and saves a daily time window", () => {
  const result = applySchedule(extraction({ startTime: "09:00", endTime: "15:00" }), "Walk the dog tmr through Saturday 9am–3pm", clock);
  assert.deepEqual(plain(result.recurrence.dates), ["2026-11-12", "2026-11-13", "2026-11-14"]);
  assert.equal(result.needsClarification, false);
  const saved = prepareForSave(result);
  assert.equal(saved.startDateTime, "2026-11-12T09:00:00-08:00");
  assert.equal(saved.endDateTime, "2026-11-12T15:00:00-08:00");
  assert.equal(saved.recurrenceRule, "RDATE:20261112T170000Z,20261113T170000Z,20261114T170000Z");
});

it("keeps all 12 dates and exclusions through validation and a time follow-up", () => {
  const text = "CPR training every m/w/f in November except the 4th";
  const result = applySchedule(extraction({ title: "CPR training" }), text, clock);
  assert.equal(result.recurrence.dates.length, 12);
  assert.equal(result.recurrence.dates[0], "2026-11-02");
  assert.ok(!result.recurrence.dates.includes("2026-11-04"));
  assert.deepEqual(plain(result.clarificationQuestions), ["What time should I schedule these events for?"]);
  const draft = normalizeDraft(result, zone);
  assert.equal(draft.ok, true);
  const answered = applyClarification(extraction({ title: null, startTime: "09:00", endTime: "10:00" }), draft.event, "9am–10am", text, referenceClock(new Date("2027-01-01T12:00:00Z"), zone));
  assert.deepEqual(plain(answered.recurrence), plain(result.recurrence));
  assert.equal(answered.title, "CPR training");
  assert.equal(answered.needsClarification, false);
  assert.equal(answered.endTime, "10:00");
  assert.ok(prepareForSave(answered));
});

it("asks only for time when explicit weekday, month and year specify all dates", () => {
  const result = applySchedule(extraction(), "Walk the dog every Tuesday in November 2026", clock);
  assert.deepEqual(plain(result.recurrence.dates), ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"]);
  assert.deepEqual(plain(result.clarificationQuestions), ["What time should I schedule these events for?"]);
  assert.equal(result.startTime, null);
});

it("supports varied months, explicit years, duplicate weekday names and nonmatching exclusions", () => {
  for (const weekdays of ["Mon/Wed/Fri", "Mondays, Wednesdays, and Fridays", "Mon/Mon/Wed/Fri"]) {
    const result = resolveBoundedDates("Swimming every " + weekdays + " in February 2024 except the 2nd and 5th", clock);
    assert.equal(result.dates.length, 10);
    assert.ok(result.dates.every((date) => date.startsWith("2024-02")));
  }
  const result = resolveBoundedDates("Piano every Tue/Thu in June 2027 except the 2nd", clock);
  assert.equal(result.dates.length, 9);
  assert.equal(result.dates[0], "2027-06-01");
});

it("crosses month and year boundaries and filters weekdays in explicit ranges", () => {
  const boundary = { localDate: "2026-12-30" };
  assert.deepEqual(plain(resolveBoundedDates("Practice tomorrow through Saturday 9am–3pm", boundary).dates), ["2026-12-31", "2027-01-01", "2027-01-02"]);
  assert.deepEqual(plain(resolveBoundedDates("Lessons every Mon/Wed from March 29, 2027 to April 5, 2027", clock).dates), ["2027-03-29", "2027-03-31", "2027-04-05"]);
  assert.equal(resolveBoundedDates("Continuous trip tomorrow through Saturday", clock), null);
});

it("validates daylight saving on every occurrence and preserves explicit durations", () => {
  const result = applySchedule(extraction({ startTime: "09:00" }), "Practice Monday to Thursday for 90 minutes", clock);
  assert.equal(result.endTime, "10:30");
  assert.equal(result.durationDefaulted, false);
  const invalid = applySchedule(extraction({ startTime: "02:30", endTime: "03:30" }), "Training every Sunday in March 2027", clock);
  assert.equal(invalid.needsClarification, true);
  assert.equal(prepareForSave(invalid), null);
});

it("does not silently flatten distinct time windows or continuous events", () => {
  const result = applySchedule(extraction({ startTime: "09:00", endTime: "10:00" }), "Training every Mon/Wed in November 9am–10am Mondays and 2pm–3pm Wednesdays", clock);
  assert.equal(result.needsClarification, true);
  assert.equal(prepareForSave(result), null);
  assert.equal(resolveBoundedDates("One event Monday to Thursday 9am–3pm", clock), null);
  assert.equal(resolveBoundedDates("Trip Monday to Thursday", clock), null);
  const exclusions = resolveBoundedDates("Piano every Tue/Thu in June 2027 except the 2nd and 3rd at 9am–10am", clock);
  assert.equal(exclusions.dates.length, 8);
});
