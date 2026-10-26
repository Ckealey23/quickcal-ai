import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadSession() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/session.js"), "utf8"), context, {
    filename: "shared/session.js",
  });
  return sandbox.QuickCalSession;
}

describe("shared widget session", () => {
  it("keeps one clarification across tabs and drops a stale tab", () => {
    const session = loadSession();
    assert.notEqual(session.storageKey(false), session.storageKey(true));
    const fresh = session.show(session.create(false));
    const firstType = session.patchInput(fresh, {
      tabId: 4,
      claim: fresh.claim,
      seq: 1,
      input: "Coffee with Alex",
      sessionId: fresh.sessionId,
    });
    assert.equal(firstType.accepted, true);
    assert.equal(firstType.state.ownerTabId, 4);
    const intruder = session.patchInput(firstType.state, {
      tabId: 5,
      claim: firstType.state.claim,
      seq: 2,
      input: "other conversation",
      sessionId: fresh.sessionId,
    });
    assert.equal(intruder.accepted, false);
    assert.equal(intruder.state.input, "Coffee with Alex");

    let state = session.show(session.create(false));
    state.layout = { scale: 1.25, left: 40, top: 80 };
    const claimed = session.claim(state, 1);
    state = claimed.state;
    const typed = session.patchInput(state, {
      tabId: 1,
      claim: state.claim,
      seq: 1,
      input: "Coffee with Alex",
      sessionId: state.sessionId,
    });
    assert.equal(typed.accepted, true);
    state = typed.state;
    const other = session.claim(state, 2);
    state = other.state;
    const stale = session.patchInput(state, {
      tabId: 1,
      claim: claimed.state.claim,
      seq: 2,
      input: "overwritten",
      sessionId: state.sessionId,
    });
    assert.equal(stale.accepted, false);
    assert.equal(stale.state.input, "Coffee with Alex");
    state = session.noteClarification(state, {
      title: "Coffee with Alex",
      date: null,
      startTime: null,
      endTime: null,
      timeZone: "America/Los_Angeles",
      location: null,
      recurrence: null,
    }, "Coffee with Alex");
    assert.equal(state.clarification.originalText, "Coffee with Alex");
    assert.equal(state.input, "");
    const answered = session.noteClarification(state, {
      title: "Coffee with Alex",
      date: "2026-10-20",
      startTime: "20:00",
      endTime: "21:00",
      timeZone: "America/Los_Angeles",
      location: null,
      recurrence: null,
    }, "Tuesday at 8 PM");
    assert.equal(answered.clarification.originalText, "Coffee with Alex");
    assert.equal(answered.clarification.draft.date, "2026-10-20");
    assert.equal(answered.clarification.draft.startTime, "20:00");

    const first = session.beginOperation(state, "parse", "a", state.sessionId);
    const second = session.beginOperation(first.state, "parse", "b", first.state.sessionId);
    assert.equal(first.accepted, true);
    assert.equal(second.accepted, false);
    const dismissed = session.dismiss(Object.assign({}, first.state, { layout: { scale: 1.25, left: 40, top: 80 } }));
    assert.equal(dismissed.visible, false);
    assert.equal(dismissed.clarification, null);
    assert.equal(dismissed.input, "");
    assert.equal(dismissed.layout.scale, 1.25);
    assert.notEqual(dismissed.sessionId, first.state.sessionId);
    const late = session.finishOperation(dismissed, first.state.operation, { input: "Coffee with Alex", mode: "clarifying" });
    assert.equal(late.accepted, false);
    assert.equal(late.state.input, "");
    const reopened = session.show(dismissed);
    assert.equal(reopened.visible, true);
    assert.equal(reopened.mode, "input");
    assert.equal(reopened.layout.left, 40);
  });

  it("round-trips through storage without keeping a dismissed operation", () => {
    const session = loadSession();
    const saved = JSON.parse(JSON.stringify(session.show(session.create(false))));
    const restored = JSON.parse(JSON.stringify(saved));
    assert.equal(restored.visible, true);
    assert.equal(restored.sessionId, saved.sessionId);
    const gone = session.dismiss(restored);
    assert.equal(JSON.parse(JSON.stringify(gone)).savedRecord, null);
  });
});
