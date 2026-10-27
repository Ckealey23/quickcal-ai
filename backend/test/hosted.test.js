import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const extensionOrigin = "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf";
const TOKEN = "ya29.hosted-extension-token";

function loadStartup() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/startup.js"), "utf8"), context, {
    filename: "shared/startup.js",
  });
  return sandbox.QuickCalStartup;
}

function loadBackground(hooks) {
  const store = {};
  const fetches = [];
  const tokenCalls = [];
  const removed = [];
  const stored = [];
  const logs = [];
  let releaseHealth = null;
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) {
          return extensionOrigin + "/" + file;
        },
        onMessage: {
          addListener(listener) {
            listeners.message = listener;
          },
        },
        onInstalled: {
          addListener(listener) {
            listeners.installed = listener;
          },
        },
        async openOptionsPage() {
          hooks.opened = (hooks.opened || 0) + 1;
        },
      },
      scripting: { executeScript() { return Promise.resolve(); } },
      storage: {
        local: {
          async get(key) {
            return { [key]: store[key] };
          },
          async set(value) {
            stored.push(JSON.stringify(value));
            Object.assign(store, value);
          },
          async remove(key) {
            delete store[key];
          },
        },
      },
      identity: {
        async getAuthToken(details) {
          const interactive = !!(details && details.interactive);
          tokenCalls.push(interactive);
          if (hooks.cancel && interactive) throw new Error("The user did not approve access.");
          if (hooks.noToken) return "";
          return TOKEN;
        },
        async removeCachedAuthToken(details) {
          removed.push(details && details.token);
        },
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: async (url, options) => {
      const call = { url: String(url), options: options || {} };
      fetches.push(call);
      if (String(url).endsWith("/health")) {
        if (hooks.holdHealth) {
          await new Promise((resolve) => {
            releaseHealth = resolve;
          });
        }
        if (hooks.healthDown) throw new TypeError("Failed to fetch");
        return {
          ok: true,
          status: 200,
          async json() {
            if (hooks.healthBody) return hooks.healthBody;
            return {
              ok: true,
              apiKeyConfigured: true,
              quickcalApiVersion: 2,
              quickcalRelease: "test-revision",
              capabilities: ["event-notifications"],
            };
          },
        };
      }
      if (String(url).endsWith("/access")) {
        const status = hooks.accessStatus || 200;
        const body = hooks.accessBody || { ok: true, approved: true };
        return { ok: status === 200, status: status, async json() { return body; } };
      }
      if (String(url).endsWith("/parse-event")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              quickcalApiVersion: 2,
              quickcalRelease: "test-revision",
              title: "Coffee with Alex",
              date: "2026-10-20",
              startTime: "10:00",
              endTime: "11:00",
              timeZone: "America/Los_Angeles",
              location: null,
              reminders: { useDefault: true, overrides: [] },
              needsClarification: false,
              clarificationQuestions: [],
            };
          },
        };
      }
      if (String(url).includes("maxResults=1")) {
        return { ok: true, status: 200, async json() { return { kind: "calendar#events" }; } };
      }
      if (String(url).includes("revoke")) {
        return { ok: true, status: 200, async json() { return {}; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
    console: {
      info(...parts) { logs.push(parts.join(" ")); },
      log(...parts) { logs.push(parts.join(" ")); },
      error(...parts) { logs.push(parts.join(" ")); },
    },
    URL,
    Intl,
    Date,
    JSON,
    Math,
    Number,
    String,
    crypto,
    AbortSignal,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => {
      runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
    });
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return { listeners, fetches, store, tokenCalls, removed, stored, logs, releaseHealth: () => releaseHealth && releaseHealth() };
}

function contentSender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    tab: { id: 7 },
    url: "https://example.com/page",
  };
}

function optionsSender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    url: extensionOrigin + "/options/options.html",
  };
}

function ask(listener, message, sender) {
  return new Promise((resolve) => {
    const keep = listener(message, sender, resolve);
    if (keep !== true) resolve(undefined);
  });
}

describe("customer manifest", () => {
  it("keeps the extension identity and points only at the hosted parser", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.key.startsWith("MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8A"), true);
    assert.equal(
      manifest.oauth2.client_id,
      "942667174356-iqt4btv1vojdqr2lg97unc1jl22si0ht.apps.googleusercontent.com"
    );
    assert.deepEqual(manifest.oauth2.scopes, [
      "https://www.googleapis.com/auth/calendar.events.owned",
      "https://www.googleapis.com/auth/userinfo.email",
    ]);
    assert.equal(manifest.host_permissions.includes("https://quickcal-ai.onrender.com/*"), true);
    assert.equal(manifest.host_permissions.includes("http://127.0.0.1:3000/*"), false);
    assert.equal(JSON.stringify(manifest).includes("OPENAI"), false);
  });
});

describe("hosted startup", () => {
  it("queues one submission while the service is cold and does not parse until it is ready", () => {
    const startup = loadStartup();
    const session = startup.createSession({ budgetMs: 1000, gapMs: 100 });
    assert.equal(session.begin(0).status, startup.CONNECTING);
    assert.equal(session.requestParse("Lunch tomorrow at noon", 10).parse, false);
    assert.equal(session.requestParse("Lunch tomorrow at noon", 20).parse, false);
    assert.equal(session.healthResult(false, 400).parse, false);
    const cold = session.healthResult(false, 1000);
    assert.equal(cold.parse, false);
    assert.equal(cold.retry, true);
    assert.equal(session.phase(), "unavailable");
    assert.equal(session.requestParse("Lunch tomorrow at noon", 1001).parse, false);
    session.retry(1100);
    const ready = session.healthResult(true, 1200);
    assert.equal(ready.parse, true);
    assert.equal(ready.text, "Lunch tomorrow at noon");
    assert.equal(session.healthResult(true, 1300).parse, false);
  });
});

describe("hosted extension access", () => {
  it("opens the welcome page once for a new install and once for an existing update", async () => {
    const installed = {};
    const loaded = loadBackground(installed);
    await loaded.listeners.installed({ reason: "install" });
    await loaded.listeners.installed({ reason: "update" });
    await loaded.listeners.installed({ reason: "update" });
    assert.equal(installed.opened, 1);
    assert.equal(loaded.tokenCalls.length, 0);
    assert.equal(loaded.store.quickcalWelcomeSeen, true);

    const updated = {};
    const existing = loadBackground(updated);
    await existing.listeners.installed({ reason: "update" });
    await existing.listeners.installed({ reason: "update" });
    assert.equal(updated.opened, 1);
    assert.equal(existing.tokenCalls.length, 0);
    assert.equal(existing.store.quickcalWelcomeSeen, true);
  });

  it("sends the Google token only to the hosted parser and checks health without it", async () => {
    const loaded = loadBackground({});
    const healthA = ask(loaded.listeners.message, { type: "quickcal-backend", action: "health" }, contentSender());
    const healthB = ask(loaded.listeners.message, { type: "quickcal-backend", action: "health" }, contentSender());
    await new Promise((resolve) => setImmediate(resolve));
    const healthFetches = loaded.fetches.filter((call) => call.url.endsWith("/health"));
    assert.equal(healthFetches.length, 1);
    assert.equal(healthFetches[0].options.headers, undefined);
    loaded.releaseHealth();
    const health = await Promise.all([healthA, healthB]);
    assert.equal(health[0].ok, true);
    assert.equal(health[1].ok, true);

    const reply = await ask(
      loaded.listeners.message,
      { type: "quickcal-parse", text: "Coffee with Alex tomorrow at 10 AM", timeZone: "America/Los_Angeles" },
      contentSender()
    );
    const parses = loaded.fetches.filter((call) => call.url.endsWith("/parse-event"));
    assert.equal(parses.length, 1);
    assert.equal(parses[0].url, "https://quickcal-ai.onrender.com/parse-event");
    assert.equal(parses[0].options.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(parses[0].options.body.includes(TOKEN), false);
    assert.equal(reply.ok, true);
    assert.equal(JSON.stringify(reply).includes(TOKEN), false);
    assert.equal(loaded.stored.some((value) => value.includes(TOKEN)), false);
    assert.equal(loaded.logs.some((line) => line.includes(TOKEN)), false);
    assert.equal(loaded.tokenCalls.includes(true), false);
  });

  it("reports an incompatible hosted parser immediately", async () => {
    const loaded = loadBackground({ healthBody: { ok: true, apiKeyConfigured: true } });
    const health = await ask(
      loaded.listeners.message,
      { type: "quickcal-backend", action: "health" },
      contentSender(),
    );
    assert.equal(health.ok, false);
    assert.equal(health.incompatible, true);
    assert.match(health.error, /hosted parser is out of date/i);
  });

  it("reconnects interactively for the email scope and reports an unapproved account", async () => {
    const loaded = loadBackground({
      accessStatus: 403,
      accessBody: { error: "Google did not confirm an email for this sign-in. Connect again so QuickCalAI can check your account." },
    });
    const status = await ask(
      loaded.listeners.message,
      { type: "quickcal-auth", action: "status" },
      optionsSender()
    );
    assert.equal(status.state, "connected");
    assert.equal(status.googleConnected, true);
    assert.equal(status.quickcalReady, false);
    assert.equal(status.needsReconnect, true);
    assert.match(status.message, /confirm an email/);
    assert.deepEqual(loaded.tokenCalls, [false]);

    loaded.fetches.length = 0;
    const reconnect = await ask(
      loaded.listeners.message,
      { type: "quickcal-auth", action: "connect" },
      optionsSender()
    );
    assert.equal(loaded.removed.includes(TOKEN), true);
    assert.equal(loaded.tokenCalls.includes(true), true);
    assert.equal(reconnect.quickcalReady, false);
    assert.equal(loaded.fetches.some((call) => call.url.endsWith("/parse-event")), false);

    const denied = loadBackground({
      accessStatus: 403,
      accessBody: { error: "This Google account is not approved for QuickCalAI." },
    });
    const unapproved = await ask(
      denied.listeners.message,
      { type: "quickcal-auth", action: "status" },
      optionsSender()
    );
    assert.equal(unapproved.googleConnected, true);
    assert.equal(unapproved.quickcalReady, false);
    assert.match(unapproved.message, /not approved/);
    assert.equal(denied.fetches.some((call) => call.url.endsWith("/parse-event")), false);
  });

  it("keeps a cancelled connection disconnected and does not reconnect after Disconnect", async () => {
    const cancelled = loadBackground({ cancel: true });
    const result = await ask(
      cancelled.listeners.message,
      { type: "quickcal-auth", action: "connect" },
      optionsSender()
    );
    assert.equal(result.state, "error");
    assert.match(result.message, /cancelled/);
    assert.equal(cancelled.fetches.some((call) => call.url.endsWith("/parse-event")), false);

    const loaded = loadBackground({});
    const disconnected = await ask(
      loaded.listeners.message,
      { type: "quickcal-auth", action: "disconnect" },
      optionsSender()
    );
    assert.equal(disconnected.state, "disconnected");
    const calls = loaded.tokenCalls.length;
    const status = await ask(
      loaded.listeners.message,
      { type: "quickcal-auth", action: "status" },
      optionsSender()
    );
    assert.equal(status.state, "disconnected");
    assert.equal(loaded.tokenCalls.length, calls);
    const widget = await ask(
      loaded.listeners.message,
      { type: "quickcal-calendar", action: "status" },
      contentSender()
    );
    assert.equal(widget.connected, false);
    assert.equal(loaded.tokenCalls.length, calls);
  });

  it("does not call the parser while Render is unavailable", async () => {
    const loaded = loadBackground({ healthDown: true });
    const health = await ask(
      loaded.listeners.message,
      { type: "quickcal-backend", action: "health" },
      contentSender()
    );
    assert.equal(health.ok, false);
    assert.equal(loaded.fetches.filter((call) => call.url.endsWith("/health")).length, 1);
    assert.equal(loaded.fetches.some((call) => call.url.endsWith("/parse-event")), false);
  });
});
