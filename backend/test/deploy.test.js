import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { once } from "node:events";
import { HOST, startupConfig } from "../src/config.js";
import { TOKENINFO_URL, createGoogleVerifier } from "../src/auth.js";
import { createRateLimiter } from "../src/rate-limit.js";
import { startServer } from "../src/http.js";

const CLIENT_ID = "942667174356-testclientidexample.apps.googleusercontent.com";
const APPROVED = "ya29.approved-reference-token";
const SECRET = "sk-test-secret-do-not-log";

function futureExp() {
  return String(Math.floor(Date.now() / 1000) + 3600);
}

function identity(overrides) {
  return Object.assign({
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: "google-user-1",
    email: "ada@example.com",
    email_verified: "true",
    exp: futureExp(),
    scope: "https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.events.owned",
  }, overrides);
}

function googleResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

async function request(base, path, options = {}) {
  const response = await fetch(base + path, options);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    body: text ? JSON.parse(text) : null,
  };
}

describe("deployment configuration", () => {
  it("keeps local development on loopback port 3000", () => {
    const startup = startupConfig({ OPENAI_API_KEY: SECRET, OPENAI_MODEL: "gpt-6-luna" });
    assert.equal(startup.error, "");
    assert.equal(startup.listen.host, "127.0.0.1");
    assert.equal(startup.listen.port, 3000);
    assert.equal(startup.auth.requireAuth, false);
    assert.equal(startup.model.apiKey, SECRET);
  });

  it("uses Render PORT and listens on all interfaces", () => {
    const startup = startupConfig({
      RENDER: "true",
      PORT: "10000",
      OPENAI_API_KEY: SECRET,
      OPENAI_MODEL: "gpt-6-luna",
      GOOGLE_CLIENT_ID: CLIENT_ID,
      ALLOWED_EMAILS: "Ada@Example.com, guest@example.com",
    });
    assert.equal(startup.error, "");
    assert.equal(startup.listen.host, "0.0.0.0");
    assert.equal(startup.listen.port, 10000);
    assert.equal(startup.auth.requireAuth, true);
    assert.deepEqual(startup.auth.allowedEmails, ["ada@example.com", "guest@example.com"]);
    assert.equal(startup.error.includes(SECRET), false);
    assert.equal(startup.model.apiKey, SECRET);
  });

  it("fails closed when production authentication is missing", () => {
    const missing = startupConfig({
      RENDER: "true",
      PORT: "10000",
      NODE_ENV: "production",
      OPENAI_API_KEY: SECRET,
      OPENAI_MODEL: "gpt-6-luna",
    });
    assert.match(missing.error, /Production authentication is not configured/);
    assert.equal(missing.error.includes(SECRET), false);
    assert.equal(missing.auth.clientId, "");
    assert.deepEqual(missing.auth.allowedEmails, []);

    const explicit = startupConfig({
      QUICKCAL_REQUIRE_AUTH: "true",
      GOOGLE_CLIENT_ID: "not-a-client",
      ALLOWED_EMAILS: "ada@example.com",
      OPENAI_API_KEY: SECRET,
    });
    assert.equal(explicit.auth.requireAuth, true);
    assert.match(explicit.error, /GOOGLE_CLIENT_ID/);
    assert.equal(explicit.error.includes("not-a-client"), false);
    assert.equal(explicit.error.includes(SECRET), false);

    const noPort = startupConfig({ RENDER: "true", OPENAI_API_KEY: SECRET });
    assert.match(noPort.error, /PORT/);
    assert.equal(noPort.error.includes(SECRET), false);
    const badPort = startupConfig({ PORT: "0" });
    assert.match(badPort.error, /PORT/);
  });

  it("still requires authentication when a production bypass is set", () => {
    const startup = startupConfig({
      RENDER: "true",
      PORT: "10000",
      QUICKCAL_REQUIRE_AUTH: "false",
      OPENAI_MODEL: "gpt-6-luna",
    });
    assert.equal(startup.auth.requireAuth, true);
    assert.match(startup.error, /Production authentication is not configured/);
  });
});

describe("google token verification", () => {
  it("checks Google's tokeninfo response and ignores a client-supplied email", async () => {
    const calls = [];
    const verify = createGoogleVerifier({
      clientId: CLIENT_ID,
      allowedEmails: ["ada@example.com"],
      fetchImpl: async (url, options) => {
        calls.push({ url, options });
        const token = new URLSearchParams(options.body).get("access_token");
        if (token !== APPROVED) return googleResponse(400, { error: "invalid_token", access_token: token });
        return googleResponse(200, identity());
      },
    });
    const approved = await verify("Bearer " + APPROVED);
    assert.deepEqual(approved, { ok: true, userId: "google-user-1" });
    assert.equal(calls[0].url, TOKENINFO_URL);
    assert.equal(calls[0].options.redirect, "error");
    assert.equal(calls[0].url.includes(APPROVED), false);
    const rejected = await verify("Bearer ya29.not-a-google-token");
    assert.equal(rejected.ok, false);
    assert.equal(rejected.status, 401);
    assert.equal(rejected.error.includes("ya29.not-a-google-token"), false);
  });

  it("rejects a token Google issued to another app, an unapproved account, or an expired token", async () => {
    const verify = createGoogleVerifier({
      clientId: CLIENT_ID,
      allowedEmails: ["ada@example.com"],
      now: () => Date.parse("2026-10-19T17:00:00Z"),
      fetchImpl: async (url, options) => {
        const token = new URLSearchParams(options.body).get("access_token");
        if (token === "ya29.wrong-audience-token") {
          return googleResponse(200, identity({
            aud: "000000000000-otherapp.apps.googleusercontent.com",
            azp: "000000000000-otherapp.apps.googleusercontent.com",
          }));
        }
        if (token === "ya29.unapproved-account") {
          return googleResponse(200, identity({ email: "bob@example.com", sub: "google-user-2" }));
        }
        if (token === "ya29.unverified-account") {
          return googleResponse(200, identity({ email_verified: "false" }));
        }
        return googleResponse(200, identity({ exp: "1" }));
      },
    });
    const audience = await verify("Bearer ya29.wrong-audience-token");
    const unapproved = await verify("Bearer ya29.unapproved-account");
    const unverified = await verify("Bearer ya29.unverified-account");
    const expired = await verify("Bearer ya29.expired-access-token");
    assert.equal(audience.status, 403);
    assert.match(unapproved.error, /not approved/);
    assert.equal(unverified.status, 403);
    assert.match(unverified.error, /confirm an email/);
    assert.equal(expired.status, 401);
    assert.equal(await verify("Bearer").then((result) => result.status), 401);
  });
});

describe("rate limit", () => {
  it("limits each approved user and resets only after the window", () => {
    let time = 1_000_000;
    const consume = createRateLimiter({ limit: 1, windowMs: 1000, now: () => time });
    assert.equal(consume("google-user-1").ok, true);
    const blocked = consume("google-user-1");
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 429);
    assert.equal(consume("google-user-2").ok, true);
    time += 1001;
    assert.equal(consume("google-user-1").ok, true);
  });
});

describe("production parse access", { concurrency: false }, () => {
  const parserCalls = [];
  const googleCalls = [];
  let server;
  let base;

  before(async () => {
    const verify = createGoogleVerifier({
      clientId: CLIENT_ID,
      allowedEmails: ["ada@example.com"],
      fetchImpl: async (url, options) => {
        googleCalls.push(url);
        const token = new URLSearchParams(options.body).get("access_token");
        assert.equal(url, TOKENINFO_URL);
        assert.equal(url.includes(token), false);
        if (token === APPROVED) return googleResponse(200, identity());
        if (token === "ya29.wrong-audience-token") {
          return googleResponse(200, identity({
            aud: "000000000000-otherapp.apps.googleusercontent.com",
            azp: "000000000000-otherapp.apps.googleusercontent.com",
          }));
        }
        if (token === "ya29.unapproved-account") {
          return googleResponse(200, identity({ email: "bob@example.com", sub: "google-user-2" }));
        }
        return googleResponse(400, { error_description: token });
      },
    });
    server = await startServer({
      host: HOST,
      port: 0,
      requireAuth: true,
      authenticate: verify,
      rateLimit: createRateLimiter({ limit: 1, windowMs: 60_000 }),
      apiKeyConfigured: true,
      release: "test-revision",
      parseEvent: async (input) => {
        parserCalls.push(input);
        return {
          title: "Coffee with Alex",
          date: "2026-10-20",
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

  async function post(headers, body) {
    return request(base, "/parse-event", {
      method: "POST",
      headers: Object.assign({ "content-type": "application/json" }, headers || {}),
      body: JSON.stringify(body || {
        text: "Coffee with Alex tomorrow from 10 to 10:30 AM",
        timeZone: "America/Los_Angeles",
        email: "ada@example.com",
      }),
    });
  }

  it("does not call the paid model for health or unauthorized requests", async () => {
    const health = await request(base, "/health");
    const access = await request(base, "/access");
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, {
      ok: true,
      apiKeyConfigured: true,
      quickcalApiVersion: 2,
      quickcalRelease: "test-revision",
      capabilities: ["event-notifications"],
    });
    assert.equal(health.text.includes(SECRET), false);

    const missing = await post();
    const origin = await post({ origin: "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf" });
    const sharedSecret = await post({ "x-quickcal-key": "extension-shared-secret" });
    const wrongApp = await post({ authorization: "Bearer ya29.wrong-audience-token" });
    const unapproved = await post({ authorization: "Bearer ya29.unapproved-account" });
    const invalid = await post({ authorization: "Bearer ya29.rejected-google-token" });
    const huge = await post({}, {
      text: "a".repeat(20_000),
      timeZone: "America/Los_Angeles",
      email: "ada@example.com",
    });

    assert.equal(missing.status, 401);
    assert.equal(access.status, 401);
    assert.equal(origin.status, 401);
    assert.equal(sharedSecret.status, 401);
    assert.equal(wrongApp.status, 403);
    assert.equal(unapproved.status, 403);
    assert.equal(invalid.status, 401);
    assert.equal(invalid.text.includes("ya29.rejected-google-token"), false);
    assert.equal(huge.status, 413);
    assert.equal(parserCalls.length, 0);
    assert.equal(googleCalls.includes(TOKENINFO_URL), true);
    assert.equal(googleCalls.length, 3);
  });

  it("parses one approved request and rate limits the next before the model", async () => {
    const before = parserCalls.length;
    const allowed = await post({ authorization: "Bearer " + APPROVED });
    const limited = await post({ authorization: "Bearer " + APPROVED });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.title, "Coffee with Alex");
    assert.equal(allowed.text.includes(APPROVED), false);
    assert.equal(allowed.text.includes("ada@example.com"), false);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after") > "0", true);
    assert.equal(parserCalls.length, before + 1);
    const approved = await request(base, "/access", {
      headers: { authorization: "Bearer " + APPROVED },
    });
    assert.equal(approved.status, 200);
    assert.deepEqual(approved.body, { ok: true, approved: true });
    assert.equal(approved.text.includes(APPROVED), false);
    assert.equal(approved.text.includes("ada@example.com"), false);
    assert.equal(parserCalls.length, before + 1);
  });
});

describe("fail closed without a verifier", () => {
  it("refuses production parse requests when authentication is not wired", async () => {
    const parserCalls = [];
    const server = await startServer({
      host: HOST,
      port: 0,
      requireAuth: true,
      parseEvent: async () => {
        parserCalls.push("paid");
        return {};
      },
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const health = await request(base, "/health");
    const response = await request(base, "/parse-event", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + APPROVED,
        origin: "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf",
      },
      body: JSON.stringify({
        text: "Coffee with Alex tomorrow from 10 to 10:30 AM",
        timeZone: "America/Los_Angeles",
      }),
    });
    assert.equal(health.status, 200);
    assert.equal(response.status, 503);
    assert.equal(parserCalls.length, 0);
    server.close();
    await once(server, "close");
  });
});

describe("request deadline", () => {
  it("returns a timeout without waiting for a stalled parser", async () => {
    let called = 0;
    const server = await startServer({
      host: HOST,
      port: 0,
      parseTimeoutMs: 30,
      parseEvent: async () => {
        called += 1;
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { title: "Late" };
      },
    });
    const base = "http://127.0.0.1:" + server.address().port;
    const response = await request(base, "/parse-event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "Coffee with Alex tomorrow from 10 to 10:30 AM",
        timeZone: "America/Los_Angeles",
      }),
    });
    assert.equal(response.status, 504);
    assert.equal(called, 1);
    server.close();
    await once(server, "close");
  });
});
