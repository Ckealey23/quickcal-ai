import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { referenceClock } from "../src/clock.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { applyEnvFile, decodeEnvBytes, envFilePath, parseEnvFile } from "../src/config.js";
import { isRealDate, isRealTime, validateExtraction, validateRequest } from "../src/validate.js";

const zone = "America/Los_Angeles";

function event(overrides = {}) {
  return {
    title: "Lunch with Priya",
    date: "2026-10-21",
    startTime: "12:00",
    endTime: "13:00",
    timeZone: zone,
    location: "Avila",
    recurrence: null,
    needsClarification: false,
    clarificationQuestions: [],
    ...overrides,
  };
}

describe("request validation", () => {
  it("accepts nonempty text and an IANA time zone", () => {
    const result = validateRequest({
      text: "  Coffee with Alex tomorrow from 10 to 10:30 AM  ",
      timeZone: " America/Los_Angeles ",
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, "Coffee with Alex tomorrow from 10 to 10:30 AM");
    assert.equal(result.timeZone, "America/Los_Angeles");
  });

  it("rejects empty, blank, and non-string text", () => {
    assert.equal(validateRequest({ text: "", timeZone: zone }).error, "Text is required.");
    assert.equal(validateRequest({ text: "   ", timeZone: zone }).error, "Text is required.");
    assert.equal(validateRequest({ text: 12, timeZone: zone }).error, "Text must be a string.");
    assert.equal(validateRequest(["text"]).error, "Request body must be a JSON object.");
  });

  it("rejects text above the length limit", () => {
    const result = validateRequest({ text: "a".repeat(2001), timeZone: zone });
    assert.equal(result.ok, false);
    assert.match(result.error, /2000/);
  });

  it("rejects a missing or unknown time zone", () => {
    assert.equal(validateRequest({ text: "Lunch" }).error, "Time zone must be a string.");
    assert.equal(
      validateRequest({ text: "Lunch", timeZone: "PST" }).error,
      "Time zone must be a valid IANA time zone."
    );
    assert.equal(
      validateRequest({ text: "Lunch", timeZone: "Not/AZone" }).error,
      "Time zone must be a valid IANA time zone."
    );
    assert.equal(validateRequest({ text: "Lunch", timeZone: "UTC" }).ok, true);
  });

  it("accepts an unsaved clarification and rejects mixing it with a saved event", () => {
    const draft = {
      title: "Coffee with Alex",
      date: null,
      startTime: null,
      endTime: null,
      timeZone: zone,
      location: null,
      recurrence: null,
    };
    const result = validateRequest({
      text: "Tuesday at 8 PM",
      timeZone: zone,
      clarification: { originalText: "Coffee with Alex", draft: draft },
    });
    assert.equal(result.ok, true);
    assert.equal(result.currentEvent, null);
    assert.equal(result.clarification.originalText, "Coffee with Alex");
    assert.equal(result.clarification.draft.title, "Coffee with Alex");
    assert.equal(result.clarification.draft.date, null);
    const saved = {
      title: "Coffee with Alex",
      date: "2026-10-20",
      endDate: "2026-10-20",
      startTime: "20:00",
      endTime: "21:00",
      timeZone: zone,
      location: null,
      recurrence: null,
    };
    const mixed = validateRequest({
      text: "Tuesday at 8 PM",
      timeZone: zone,
      currentEvent: saved,
      clarification: { originalText: "Coffee with Alex", draft: draft },
    });
    assert.equal(mixed.ok, false);
    assert.match(mixed.error, /saved event/);
  });
});

describe("calendar values", () => {
  it("accepts real dates and rejects impossible ones", () => {
    assert.equal(isRealDate("2026-10-21"), true);
    assert.equal(isRealDate("2024-02-29"), true);
    assert.equal(isRealDate("2000-02-29"), true);
    assert.equal(isRealDate("2026-02-29"), false);
    assert.equal(isRealDate("1900-02-29"), false);
    assert.equal(isRealDate("2026-02-31"), false);
    assert.equal(isRealDate("2026-13-01"), false);
    assert.equal(isRealDate("2026-1-01"), false);
  });

  it("accepts 24-hour times only", () => {
    assert.equal(isRealTime("00:00"), true);
    assert.equal(isRealTime("10:30"), true);
    assert.equal(isRealTime("23:59"), true);
    assert.equal(isRealTime("24:00"), false);
    assert.equal(isRealTime("10:30 AM"), false);
    assert.equal(isRealTime("9:00"), false);
  });

  it("keeps a complete event without inventing an end time", () => {
    const result = validateExtraction(event({ location: null }), zone);
    assert.equal(result.ok, true);
    assert.equal(result.event.needsClarification, false);
    assert.deepEqual(result.event.clarificationQuestions, []);
    assert.equal(result.event.location, null);
    assert.equal(result.event.endTime, "13:00");
  });

  it("asks for a missing date or time instead of filling one in", () => {
    const result = validateExtraction(
      event({
        date: null,
        startTime: null,
        endTime: null,
        location: null,
        needsClarification: false,
      }),
      zone
    );
    assert.equal(result.ok, true);
    assert.equal(result.event.date, null);
    assert.equal(result.event.startTime, null);
    assert.equal(result.event.endTime, null);
    assert.equal(result.event.needsClarification, true);
    assert.deepEqual(result.event.clarificationQuestions, [
      "What date should this event use?",
      "What time does this event start?",
    ]);
  });

  it("does not ask for a missing end time or a weekly date", () => {
    const openEnded = validateExtraction(event({ endTime: null, location: null }), zone);
    assert.equal(openEnded.event.needsClarification, false);
    assert.equal(openEnded.event.endTime, null);
    assert.deepEqual(openEnded.event.clarificationQuestions, []);

    const weekly = validateExtraction(event({
      date: null,
      endTime: null,
      location: null,
      recurrence: { frequency: "weekly", weekdays: ["FR"], until: null, count: null },
    }), zone);
    assert.equal(weekly.ok, true);
    assert.equal(weekly.event.date, null);
    assert.equal(weekly.event.needsClarification, false);
    assert.deepEqual(Array.from(weekly.event.recurrence.weekdays), ["FR"]);
  });

  it("flags an end time that is not after the start and keeps both times", () => {
    const result = validateExtraction(
      event({ startTime: "22:00", endTime: "01:00", needsClarification: false }),
      zone
    );
    assert.equal(result.event.startTime, "22:00");
    assert.equal(result.event.endTime, "01:00");
    assert.equal(result.event.needsClarification, true);
    assert.match(result.event.clarificationQuestions[0], /not later than the start time/);
  });

  it("rejects impossible dates, bad types, and an invalid time zone", () => {
    assert.equal(validateExtraction(event({ date: "2026-02-31" }), zone).ok, false);
    assert.equal(validateExtraction(event({ startTime: "25:00" }), zone).ok, false);
    assert.equal(validateExtraction(event({ needsClarification: "yes" }), zone).ok, false);
    assert.equal(validateExtraction(event({ timeZone: "PST" }), zone).ok, false);
    assert.equal(validateExtraction(event({ timeZone: "UTC" }), zone).event.timeZone, "UTC");
    assert.equal(validateExtraction(event({ recurrence: { frequency: "daily" } }), zone).ok, false);
    assert.equal(validateExtraction(event({ extra: true }), zone).ok, false);
  });
});

describe("reference clock", () => {
  it("uses the requested time zone rather than the UTC date", () => {
    const now = new Date("2026-10-17T06:30:00.000Z");
    const local = referenceClock(now, zone);
    assert.equal(local.serverTimestamp, "2026-10-17T06:30:00.000Z");
    assert.equal(local.localDate, "2026-10-16");
    assert.equal(local.localTime, "23:30:00");
    assert.equal(local.weekday, "Friday");
    assert.equal(referenceClock(now, "UTC").localDate, "2026-10-17");
  });
});

describe("env file", () => {
  it("reads only the model settings and ignores other assignments", () => {
    const values = parseEnvFile(
      '# comment\nOPENAI_API_KEY="placeholder"\nOPENAI_MODEL=gpt-6-luna\nPATH=C:\\secret\n'
    );
    assert.deepEqual(values, {
      OPENAI_API_KEY: "placeholder",
      OPENAI_MODEL: "gpt-6-luna",
    });
  });

  it("uses one unlabeled token when the named key is still empty", () => {
    const values = parseEnvFile(
      "OPENAI_API_KEY=\nsk-test-not-a-real-key\nOPENAI_MODEL=gpt-6-luna\n"
    );
    assert.equal(values.OPENAI_API_KEY, "sk-test-not-a-real-key");
    const named = parseEnvFile(
      "OPENAI_API_KEY=sk-named-test-key\nsk-other-test-key-value\n"
    );
    assert.equal(named.OPENAI_API_KEY, "sk-named-test-key");
  });

  it("loads a BOM or UTF-16 file and replaces a blank environment value", () => {
    const directory = mkdtempSync(join(tmpdir(), "quickcal-env-"));
    const filePath = join(directory, ".env");
    const encoded = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("OPENAI_API_KEY=sk-test-not-a-real-key\nOPENAI_MODEL=gpt-6-luna\n", "utf8"),
    ]);
    assert.equal(decodeEnvBytes(encoded).includes("OPENAI_API_KEY"), true);
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("OPENAI_API_KEY=sk-test-not-a-real-key\n", "utf16le"),
    ]);
    assert.equal(decodeEnvBytes(utf16).includes("sk-test-not-a-real-key"), true);
    writeFileSync(filePath, encoded);
    const env = { OPENAI_API_KEY: "   " };
    applyEnvFile(filePath, env);
    assert.equal(env.OPENAI_API_KEY, "sk-test-not-a-real-key");
    assert.equal(env.OPENAI_MODEL, "gpt-6-luna");
  });

  it("resolves .env from the backend source directory", () => {
    const resolved = envFilePath(new URL("../src/config.js", import.meta.url));
    assert.equal(basename(resolved), ".env");
    assert.equal(basename(dirname(resolved)), "backend");
  });
});
