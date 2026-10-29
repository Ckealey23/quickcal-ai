import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";
import { createParser } from "../src/parse.js";
import { validateExtraction, validateRequest } from "../src/validate.js";

const root = path.resolve(import.meta.dirname, "../..");
const zone = "America/Los_Angeles";

function blankOperation(fields) {
  return Object.assign({
    target: null,
    searchDate: null,
    searchTime: null,
    destinationDate: null,
    destinationTime: null,
    destinationEndTime: null,
    scope: "occurrence",
    selection: [],
  }, fields || {});
}

function loadLookup() {
  const sandbox = { Intl: Intl, Date: Date };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/schedule.js"), "utf8"), context, { filename: "shared/schedule.js" });
  runInContext(readFileSync(path.join(root, "shared/lookup.js"), "utf8"), context, { filename: "shared/lookup.js" });
  return sandbox.QuickCalLookup;
}

describe("calendar interpretation", () => {
  it("validates separate search and destination fields and rejects an invented ref", () => {
    const move = validateExtraction({
      title: null,
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      needsClarification: false,
      clarificationQuestions: [],
      intent: "move",
      operation: blankOperation({
        target: "Steve",
        searchDate: "2026-11-03",
        searchTime: "17:00",
        destinationDate: "2026-11-04",
        destinationTime: "19:00",
      }),
    }, zone);
    assert.equal(move.ok, true);
    assert.equal(move.event.intent, "move");
    assert.equal(move.event.needsClarification, false);
    assert.equal(move.event.operation.searchDate, "2026-11-03");
    assert.equal(move.event.operation.destinationDate, "2026-11-04");
    assert.equal(move.event.operation.destinationTime, "19:00");
    const invented = validateExtraction({
      title: null,
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
      notificationAction: "preserve",
      notificationOverrides: [],
      needsClarification: false,
      clarificationQuestions: [],
      intent: "delete",
      operation: blankOperation({ selection: ["series_20261029T000000Z"] }),
    }, zone);
    assert.equal(invented.ok, false);
  });

  it("merges a date correction without erasing the destination time", () => {
    const lookup = loadLookup();
    const pending = {
      target: "Steve",
      date: "2026-10-28",
      explicitDate: false,
      newStartTime: "19:00",
      scope: "occurrence",
    };
    const merged = lookup.mergeQuery(pending, blankOperation({ searchDate: "2026-11-03" }));
    assert.equal(merged.date, "2026-11-03");
    assert.equal(merged.explicitDate, true);
    assert.equal(merged.newStartTime, "19:00");
    assert.equal(merged.target, "Steve");
    const corrected = lookup.mergeQuery(merged, blankOperation({ searchDate: "2026-11-04" }));
    assert.equal(corrected.date, "2026-11-04");
    assert.equal(corrected.newStartTime, "19:00");
    assert.equal(corrected.newDate, "");
  });

  it("asks the model to resolve a follow-up instead of creating an event", async () => {
    const calls = [];
    const parseEvent = createParser({
      apiKey: "local-test-key",
      model: "gpt-6-luna",
      now: () => new Date("2026-10-28T19:00:00.000Z"),
      client: {
        responses: {
          create: async (body) => {
            calls.push(body);
            return {
              status: "completed",
              output_text: JSON.stringify({
                title: null,
                date: null,
                startTime: null,
                endTime: null,
                timeZone: zone,
                location: null,
                recurrence: null,
                notificationAction: "preserve",
                notificationOverrides: [],
                needsClarification: false,
                clarificationQuestions: [],
                intent: "move",
                operation: blankOperation({ target: "Steve", searchDate: "2026-11-03", destinationTime: "19:00" }),
              }),
              output: [],
            };
          },
        },
      },
    });
    const request = validateRequest({
      text: "Next Tuesday",
      timeZone: zone,
      operation: {
        intent: "move",
        target: "Steve",
        destinationTime: "19:00",
        scope: "occurrence",
        missing: "searchDate",
        prompt: "What date should I check?",
        candidates: [],
      },
    });
    assert.equal(request.ok, true);
    const event = await parseEvent(request);
    assert.equal(calls.length, 1);
    assert.match(calls[0].instructions, /searchDate and searchTime identify the event/);
    assert.match(calls[0].instructions, /Next Tuesday after a request for the search date/);
    assert.match(calls[0].input, /Destination time: 19:00/);
    assert.match(calls[0].input, /User: Next Tuesday/);
    assert.equal(calls[0].input.includes("tuesday-steve"), false);
    assert.equal(event.intent, "move");
    assert.equal(event.operation.searchDate, "2026-11-03");
    assert.equal(event.title, null);
  });
});
