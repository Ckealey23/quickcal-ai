import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");

function loadBackground(hooks) {
  const store = hooks.store || {};
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) {
          return "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/" + file;
        },
        onMessage: { addListener(listener) { listeners.message = listener; } },
        onInstalled: { addListener() {} },
        async openOptionsPage() {
          hooks.opened = (hooks.opened || 0) + 1;
        },
      },
      scripting: { executeScript() { return Promise.resolve(); } },
      storage: {
        local: {
          async get(key) { return { [key]: store[key] }; },
          async set(value) { Object.assign(store, value); },
          async remove(key) { delete store[key]; },
        },
        session: {
          async get(key) { return { [key]: hooks.sessionStore[key] }; },
          async set(value) { Object.assign(hooks.sessionStore, value); },
        },
      },
      identity: {
        async getAuthToken() { return hooks.token == null ? "test-token" : hooks.token; },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: async (url) => {
      const target = String(url);
      if (target.includes("/access")) {
        return { ok: true, status: 200, async json() { return { ok: true, approved: true }; } };
      }
      if (target.includes("/users/me/calendarList")) {
        if (hooks.conflictScopesDenied) {
          return {
            ok: false,
            status: 403,
            async json() { return { error: { message: "Request had insufficient authentication scopes." } }; },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return { items: [{ id: "primary", summary: "Primary", primary: true, accessRole: "owner" }] };
          },
        };
      }
      if (target.includes("maxResults=1")) {
        return { ok: true, status: 200, async json() { return { kind: "calendar#events" }; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
    console,
    URL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Promise,
    crypto,
    AbortSignal,
    encodeURIComponent,
    decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file }));
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return { listener: listeners.message, hooks: hooks };
}

function sender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    tab: { id: 4, incognito: false },
    url: "https://example.com/page",
  };
}

function ask(listener, message) {
  return new Promise((resolve) => listener(message, sender(), resolve));
}

describe("connect action wiring", () => {
  it("keeps pointer-events enabled on the floating connect route", () => {
    const css = readFileSync(path.join(root, "content/widget.css"), "utf8");
    const block = css.match(/\.connect-route,[\s\S]*?\.keep-draft \{[\s\S]*?\}/);
    assert.ok(block, "connect-route rule missing");
    assert.match(block[0], /pointer-events:\s*auto/);
    assert.match(
      readFileSync(path.join(root, "content/widget.js"), "utf8"),
      /action:\s*"open-settings"/
    );
  });

  it("opens options from the widget message and reports missing conflict scopes", async () => {
    const hooks = { sessionStore: {}, opened: 0 };
    const loaded = loadBackground(hooks);
    await ask(loaded.listener, { type: "quickcal-widget", action: "show" });
    const sessionId = hooks.sessionStore.quickcalWidgetSession.sessionId;
    await ask(loaded.listener, {
      type: "quickcal-widget",
      action: "patch",
      tabId: 4,
      claim: hooks.sessionStore.quickcalWidgetSession.claim,
      seq: 1,
      input: "Coffee with Alex tomorrow at 10 AM",
      sessionId: sessionId,
    });
    const opened = await ask(loaded.listener, {
      type: "quickcal-calendar",
      action: "open-settings",
    });
    assert.equal(opened.ok, true);
    assert.equal(hooks.opened, 1);
    const snapshot = await ask(loaded.listener, { type: "quickcal-widget", action: "snapshot" });
    assert.equal(snapshot.session.input, "Coffee with Alex tomorrow at 10 AM");
    assert.equal(snapshot.session.visible, true);

    const ready = await ask(loaded.listener, { type: "quickcal-calendar", action: "status" });
    assert.equal(ready.connected, true);
    assert.equal(ready.needsConflictScopes, false);

    const denied = loadBackground({ sessionStore: {}, conflictScopesDenied: true });
    const status = await ask(denied.listener, { type: "quickcal-calendar", action: "status" });
    assert.equal(status.connected, true);
    assert.equal(status.needsConflictScopes, true);
    assert.equal(status.needsReconnect, true);
    assert.equal(status.quickcalReady, false);
    assert.match(status.message, /Reconnect Google Calendar/);
  });
});
