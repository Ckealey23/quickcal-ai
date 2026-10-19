import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadRecording() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/recording.js"), "utf8"), context, {
    filename: "shared/recording.js",
  });
  return sandbox.QuickCalRecording;
}

describe("recording session", () => {
  it("submits one recording and ignores a second stop, a late result, and another tab", () => {
    const recording = loadRecording();
    const session = recording.createRecordingController();
    const started = session.begin(4);
    assert.equal(started.phase, "arming");
    assert.equal(session.begin(4).ok, false);
    assert.equal(session.markRecording(started.sessionId).phase, "recording");
    const stop = session.requestSubmit(started.sessionId, 4);
    assert.equal(stop.submit, true);
    assert.equal(stop.submissions, 1);
    assert.equal(session.requestSubmit(started.sessionId, 4).submit, false);
    assert.equal(session.requestSubmit(started.sessionId, 9).ignored, true);
    assert.equal(session.snapshot().submissions, 1);
    session.hold(started.sessionId);
    const retry = session.requestSubmit(started.sessionId, 4);
    assert.equal(retry.submit, true);
    assert.equal(retry.submissions, 2);
    session.finish(started.sessionId);
    assert.equal(session.snapshot().phase, "idle");
    assert.equal(session.finish(started.sessionId).ignored, true);
  });

  it("does not submit when recording is cancelled or reaches the time limit", () => {
    const recording = loadRecording();
    assert.equal(recording.LIMIT_MS, 60000);
    const limited = recording.createRecordingController();
    const first = limited.begin(2);
    limited.markRecording(first.sessionId);
    const review = limited.limit(first.sessionId);
    assert.equal(review.phase, "review");
    assert.equal(review.submit, false);
    assert.equal(limited.snapshot().submissions, 0);
    const explicit = limited.requestSubmit(first.sessionId, 2);
    assert.equal(explicit.submit, true);
    assert.equal(explicit.submissions, 1);

    const cancelled = recording.createRecordingController();
    const second = cancelled.begin(2);
    cancelled.markRecording(second.sessionId);
    const done = cancelled.cancel(second.sessionId, 2);
    assert.equal(done.submit, false);
    assert.equal(done.phase, "idle");
    assert.equal(cancelled.requestSubmit(second.sessionId, 2).ignored, true);
    assert.equal(cancelled.snapshot().submissions, 0);

    const busy = recording.createRecordingController();
    const third = busy.begin(2);
    busy.markRecording(third.sessionId);
    assert.equal(busy.cancel(third.sessionId, 8).ignored, true);
    assert.equal(busy.snapshot().phase, "recording");
    assert.equal(busy.snapshot().submissions, 0);
  });
});
