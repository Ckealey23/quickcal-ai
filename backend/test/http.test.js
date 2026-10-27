import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { HOST } from "../src/config.js";
import { startServer } from "../src/http.js";

const calls = [];

async function request(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

describe("local server", { concurrency: false }, () => {
  let server;
  let base;

  before(async () => {
    server = await startServer({
      host: HOST,
      port: 0,
      parseEvent: async (input) => {
        calls.push(input);
        return {
          title: "Coffee with Alex",
          date: "2026-10-17",
          startTime: "10:00",
          endTime: "10:30",
          timeZone: input.timeZone,
          location: null,
          needsClarification: false,
          clarificationQuestions: [],
        };
      },
    });
    base = "http://127.0.0.1:" + server.address().port;
  });

  after(async () => {
    server.close();
    await once(server, "close");
  });

  it("answers health without calling the parser", async () => {
    const beforeCount = calls.length;
    const response = await request(base, "/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      ok: true,
      apiKeyConfigured: false,
      quickcalApiVersion: 2,
      quickcalRelease: "local",
      capabilities: ["event-notifications"],
    });
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.equal(calls.length, beforeCount);
  });

  it("rejects invalid events before the parser", async () => {
    const beforeCount = calls.length;
    const empty = await request(base, "/parse-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "   ", timeZone: "America/Los_Angeles" }),
    });
    const zone = await request(base, "/parse-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Lunch", timeZone: "PST" }),
    });
    const huge = await request(base, "/parse-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "a".repeat(2001), timeZone: "America/Los_Angeles" }),
    });
    assert.equal(empty.status, 400);
    assert.equal(zone.status, 400);
    assert.equal(huge.status, 400);
    assert.equal(calls.length, beforeCount);
  });

  it("parses one valid request and does not serve repository files", async () => {
    const response = await request(base, "/parse-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Coffee with Alex tomorrow from 10 to 10:30 AM",
        timeZone: "America/Los_Angeles",
      }),
    });
    const missing = await request(base, "/manifest.json");
    const wrongMethod = await request(base, "/health", { method: "POST" });
    assert.equal(response.status, 200);
    assert.equal(response.body.title, "Coffee with Alex");
    assert.equal(response.body.quickcalApiVersion, 2);
    assert.equal(response.body.quickcalRelease, "local");
    assert.equal(calls.length, 1);
    assert.equal(missing.status, 404);
    assert.equal(wrongMethod.status, 405);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  });

  it("allows only the QuickCalAI extension origin", async () => {
    const origin = "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf";
    const allowed = await request(base, "/health", { headers: { origin } });
    const other = await request(base, "/health", {
      headers: { origin: "https://example.com" },
    });
    const preflight = await request(base, "/parse-event", {
      method: "OPTIONS",
      headers: { origin, "access-control-request-headers": "content-type" },
    });
    const denied = await request(base, "/parse-event", {
      method: "OPTIONS",
      headers: { origin: "https://example.com" },
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), origin);
    assert.equal(allowed.headers.get("vary"), "Origin");
    assert.equal(other.headers.get("access-control-allow-origin"), null);
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, Authorization");
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal(String(allowed.headers.get("access-control-allow-origin")).includes("*"), false);
  });
});

describe("listen address", () => {
  it("binds only to loopback", async () => {
    const probe = createServer();
    await new Promise((resolve) => probe.listen(0, HOST, resolve));
    const address = probe.address();
    probe.close();
    await once(probe, "close");
    assert.equal(address.address, "127.0.0.1");
  });
});
