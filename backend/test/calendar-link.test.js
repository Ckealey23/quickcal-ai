import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadPreview() {
  const sandbox = { URL: URL };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/preview.js"), "utf8"), context, {
    filename: "shared/preview.js",
  });
  return sandbox.QuickCalPreview;
}

function browserKey(eventId, calendarId) {
  return Buffer.from(eventId + " " + calendarId, "utf8").toString("base64url");
}

describe("calendar edit link", () => {
  it("opens the saved event from Google's browser identifier", () => {
    const preview = loadPreview();
    const createdKey = browserKey("quickcalid0001", "owner@gmail.com");
    const created = preview.calendarEditLink("https://www.google.com/calendar/event?eid=" + createdKey);
    assert.equal(created, "https://calendar.google.com/calendar/r/eventedit/" + createdKey);
    assert.equal(created.includes("action=TEMPLATE"), false);
    assert.equal(created.includes("quickcalid0001"), false);
    assert.equal(created.includes("primary"), false);
    assert.equal(Buffer.from(created.split("/").pop(), "base64url").toString("utf8"), "quickcalid0001 owner@gmail.com");

    const updatedKey = browserKey("quickcalid0001", "owner@gmail.com").slice(0, -1) + "x";
    const updated = preview.calendarEditLink("https://calendar.google.com/calendar/event?eid=" + updatedKey);
    assert.equal(updated, "https://calendar.google.com/calendar/r/eventedit/" + updatedKey);
    assert.notEqual(updated, created);

    assert.equal(preview.calendarEditLink("quickcalid0001"), "");
    assert.equal(preview.calendarEditLink("https://calendar.google.com/calendar/r/eventedit?text=Coffee"), "");
    assert.equal(
      preview.calendarEditLink("https://calendar.google.com/calendar/r/eventedit?action=TEMPLATE&text=Coffee&dates=20261023T170000Z/20261023T180000Z"),
      ""
    );
    assert.equal(preview.calendarEditLink("http://calendar.google.com/calendar/event?eid=" + createdKey), "");
    assert.equal(preview.calendarEditLink("https://calendar.google.com.evil.test/calendar/event?eid=" + createdKey), "");
    assert.equal(preview.calendarViewLink("https://www.google.com/calendar/event?eid=" + createdKey).startsWith("https://www.google.com/calendar/event?eid="), true);
  });

  it("keeps a recurring series and a single occurrence distinct", () => {
    const preview = loadPreview();
    const calendarId = "owner@gmail.com";
    const seriesKey = browserKey("quickcalid0001", calendarId);
    const occurrenceKey = browserKey("quickcalid0001_20261023T180000Z", calendarId);
    const series = preview.calendarEditLink("https://www.google.com/calendar/event?eid=" + seriesKey);
    const occurrence = preview.calendarEditLink("https://calendar.google.com/calendar/event?eid=" + occurrenceKey);
    assert.equal(Buffer.from(series.split("/").pop(), "base64url").toString("utf8"), "quickcalid0001 owner@gmail.com");
    assert.equal(
      Buffer.from(occurrence.split("/").pop(), "base64url").toString("utf8"),
      "quickcalid0001_20261023T180000Z owner@gmail.com"
    );
    assert.notEqual(series, occurrence);
    assert.equal(occurrence.includes("action=TEMPLATE"), false);
  });
});
