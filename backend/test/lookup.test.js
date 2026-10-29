import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";
const now = new Date("2026-10-28T22:00:00.000Z");

function loadLookup() {
  const sandbox = { URL: URL, Intl: Intl, Date: Date };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context, { filename: "shared/schedule.js" });
  runInContext(readFileSync(path.join(root, "shared/lookup.js"), "utf8"), context, { filename: "shared/lookup.js" });
  return sandbox.QuickCalLookup;
}

function item(id, summary, start, end, extra) {
  return Object.assign({
    id: id,
    summary: summary,
    status: "confirmed",
    htmlLink: "https://calendar.google.com/calendar/event?eid=" + id,
    start: { dateTime: start },
    end: { dateTime: end },
    attendees: [],
  }, extra || {});
}

describe("calendar lookup", () => {
  it("moves today's unique 5 PM event to 7 PM and keeps the duration", () => {
    const lookup = loadLookup();
    const clock = lookup.clockFrom(now, zone);
    const decision = lookup.classify("Move my 5 PM meeting with Steve to 7 PM", { clock: clock, hasSaved: true });
    assert.equal(decision.intent, "move");
    assert.equal(decision.query.date, "2026-10-28");
    assert.equal(decision.query.startTime, "17:00");
    assert.equal(decision.query.newStartTime, "19:00");
    assert.equal(decision.query.scope, "occurrence");
    const events = [
      item("early", "Meeting with Steve", "2026-10-29T00:00:00.000Z", "2026-10-29T01:00:00.000Z", {
        attendees: [{ email: "steve@example.com", displayName: "Steve" }],
      }),
      item("later", "Meeting with Steve", "2026-10-29T02:00:00.000Z", "2026-10-29T03:00:00.000Z"),
    ];
    const matches = lookup.matchEvents(events, decision.query, zone);
    assert.equal([].join.call(matches.map((entry) => entry.id)), "early");
    const plan = lookup.planMove(matches[0], decision.query, zone);
    assert.equal(plan.startTime, "19:00");
    assert.equal(plan.endTime, "20:00");
    assert.equal(plan.id, "early");
    assert.equal(lookup.classify("make it 7 PM", { clock: clock, hasSaved: true }).intent, "edit-current");
  });

  it("asks for a date instead of choosing another day", () => {
    const lookup = loadLookup();
    const clock = lookup.clockFrom(now, zone);
    const decision = lookup.classify("Remove my meeting with Steve", { clock: clock });
    assert.equal(decision.intent, "delete");
    assert.equal(decision.query.explicitDate, false);
    assert.equal(decision.query.date, "2026-10-28");
    const tomorrow = item("tomorrow", "Meeting with Steve", "2026-10-30T00:00:00.000Z", "2026-10-30T01:00:00.000Z");
    assert.equal(lookup.matchEvents([tomorrow], decision.query, zone).length, 0);
    const dated = lookup.classify("Remove my meeting with Steve on Tuesday", { clock: clock });
    assert.equal(dated.query.date, "2026-11-03");
    assert.equal(dated.query.explicitDate, true);
  });

  it("selects only listed events and keeps a series occurrence separate", () => {
    const lookup = loadLookup();
    const candidates = [
      { id: "a_20261029T000000Z", recurringEventId: "series", summary: "Meeting with Steve", startTime: "17:00", dateText: "Oct 28, 2026", timeText: "5:00–6:00 PM" },
      { id: "b", recurringEventId: "", summary: "Lunch with Steve", startTime: "12:00", dateText: "Oct 28, 2026", timeText: "12:00–1:00 PM" },
    ];
    assert.equal([].join.call(lookup.choose("both", candidates).ids), "a_20261029T000000Z,b");
    assert.equal([].join.call(lookup.choose("the first", candidates).ids), "a_20261029T000000Z");
    assert.equal(lookup.choose("steve", candidates).ask, true);
    assert.equal(lookup.targetId(candidates[0], "occurrence"), "a_20261029T000000Z");
    assert.equal(lookup.targetId(candidates[0], "series"), "series");
    const series = lookup.classify("Delete every occurrence of my meeting with Steve", { clock: lookup.clockFrom(now, zone) });
    assert.equal(series.query.scope, "series");
    const unsupported = lookup.classify("Delete this and following meetings with Steve", { clock: lookup.clockFrom(now, zone) });
    assert.equal(unsupported.intent, "unsupported");
  });

  it("requires a separate armed Enter and ignores a correction or a held key", () => {
    const lookup = loadLookup();
    assert.equal(lookup.enterAction({ mode: "confirming", text: "", armed: false, repeat: false }), "ignore");
    assert.equal(lookup.enterAction({ mode: "confirming", text: "", armed: true, repeat: true }), "ignore");
    assert.equal(lookup.enterAction({ mode: "confirming", text: "keep it", armed: true, repeat: false }), "submit");
    assert.equal(lookup.enterAction({ mode: "confirming", text: "", armed: true, repeat: false }), "confirm");
    assert.equal(lookup.enterAction({ mode: "input", text: "Coffee", armed: false, repeat: false }), "submit");
  });

  it("treats a changed event as a different candidate", () => {
    const lookup = loadLookup();
    const original = item("early", "Meeting with Steve", "2026-10-29T00:00:00.000Z", "2026-10-29T01:00:00.000Z");
    const candidate = lookup.candidateFrom(original, zone);
    const moved = item("early", "Meeting with Steve", "2026-10-29T02:00:00.000Z", "2026-10-29T03:00:00.000Z");
    assert.equal(lookup.sameFingerprint(candidate, original, zone), true);
    assert.equal(lookup.sameFingerprint(candidate, moved, zone), false);
  });
});
