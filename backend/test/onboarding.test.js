import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const extensionOrigin = "chrome-extension://epnmambadhgonpaplpfgajhdpbkaiikb";
const TOKEN = "ya29.hosted-extension-token";

function storageGet(store, key) {
  if (Array.isArray(key)) {
    const out = {};
    key.forEach((name) => {
      out[name] = store[name];
    });
    return out;
  }
  if (typeof key === "string") return { [key]: store[key] };
  return Object.assign({}, store);
}

function loadOnboardingHelpers() {
  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  const context = createContext(sandbox);
  runInContext(readFileSync(path.join(root, "shared/onboarding.js"), "utf8"), context, {
    filename: "shared/onboarding.js",
  });
  return sandbox.QuickCalOnboarding;
}

function ask(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const result = listener(message, sender, resolve);
    if (result && typeof result.then === "function") result.then(resolve, reject);
  });
}

function contentSender(tabId) {
  return {
    id: "epnmambadhgonpaplpfgajhdpbkaiikb",
    tab: { id: tabId || 4, incognito: false },
    url: "https://example.com/page",
  };
}

function loadBackground(hooks) {
  const settings = hooks || {};
  const local = Object.assign({}, settings.local || {});
  const session = Object.assign({}, settings.session || {});
  const fetches = [];
  const tokenCalls = [];
  const delivered = [];
  const listeners = {};
  const sandbox = {
    chrome: {
      action: {
        onClicked: {
          addListener(listener) {
            listeners.action = listener;
          },
        },
      },
      runtime: {
        id: "epnmambadhgonpaplpfgajhdpbkaiikb",
        getURL(file) {
          return extensionOrigin + "/" + file;
        },
        getManifest() {
          return { update_url: "https://clients2.google.com/service/update2/crx" };
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
        onStartup: {
          addListener(listener) {
            listeners.startup = listener;
          },
        },
        async openOptionsPage() {
          settings.opened = (settings.opened || 0) + 1;
        },
      },
      scripting: {
        executeScript() {
          return Promise.resolve();
        },
      },
      tabs: {
        async create(details) {
          const tab = {
            id: 88,
            url: details.url || "https://example.com/",
            active: true,
            status: "complete",
            incognito: false,
          };
          settings.createdTabs = settings.createdTabs || [];
          settings.createdTabs.push(tab);
          return tab;
        },
        async get(id) {
          return { id, url: "https://example.com/", status: "complete", incognito: false };
        },
        async query() {
          return settings.tabs || [{ id: 4, url: "https://example.com/", active: true, incognito: false }];
        },
        async sendMessage(tabId, message) {
          delivered.push({ tabId, message });
          return { ok: true, open: true };
        },
        onUpdated: { addListener() {}, removeListener() {} },
        onActivated: { addListener() {} },
        onRemoved: { addListener() {} },
      },
      storage: {
        local: {
          async get(key) {
            return storageGet(local, key);
          },
          async set(value) {
            Object.assign(local, value);
          },
          async remove(key) {
            delete local[key];
          },
        },
        session: {
          async get(key) {
            return storageGet(session, key);
          },
          async set(value) {
            Object.assign(session, value);
          },
        },
      },
      identity: {
        async getAuthToken(details) {
          tokenCalls.push(!!(details && details.interactive));
          if (settings.cancel && details && details.interactive) {
            throw new Error("The user did not approve access.");
          }
          return TOKEN;
        },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
      contextMenus: {
        create() {},
        onClicked: { addListener() {} },
      },
    },
    fetch: async (url) => {
      fetches.push(String(url));
      if (String(url).endsWith("/access")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { ok: true, approved: true };
          },
        };
      }
      if (String(url).includes("calendarList") || String(url).includes("tasks/v1")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { items: [{ id: "primary", primary: true, accessRole: "owner" }] };
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
    console: { info() {}, log() {}, error() {} },
    URL,
    URLSearchParams,
    Intl,
    Date,
    JSON,
    Math,
    Number,
    String,
    crypto,
    AbortSignal,
    setTimeout,
    clearTimeout,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => {
      runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
    });
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, {
    filename: "background.js",
  });
  return { listeners, local, session, tokenCalls, delivered, fetches, settings };
}

describe("onboarding helpers", () => {
  it("migrates established users and keeps fresh installs incomplete", () => {
    const api = loadOnboardingHelpers();
    assert.equal(api.shouldMigrateAsComplete({ quickcalWelcomeSeen: true }), true);
    assert.equal(api.shouldMigrateAsComplete({ quickcalCalendarSuppressed: false }), true);
    assert.equal(api.shouldMigrateAsComplete({ quickcalDraftEvent: { id: "1" } }), true);
    assert.equal(api.shouldMigrateAsComplete({}), false);
    assert.equal(api.normalize({ completed: true, step: "connect" }).completed, true);
  });

  it("maps legacy steps into the animated tour and keeps demos ordered", () => {
    const api = loadOnboardingHelpers();
    assert.equal(api.normalizeStep("welcome"), "overview");
    assert.equal(api.normalizeStep("examples"), "demo-event");
    assert.equal(api.nextStep("overview"), "demo-event");
    assert.equal(api.nextStep("demo-documents"), "connect");
    assert.equal(api.previousStep("demo-event"), "overview");
    assert.equal(api.demoIndex("demo-availability"), 1);
    assert.equal(api.DEMOS["demo-documents"].items.length, 3);
    assert.match(api.DEMOS["demo-availability"].eventTitle, /Project sync/);
  });
});

describe("widget onboarding flow", () => {
  it("shows onboarding on first open without opening options, then completes into input", async () => {
    const loaded = loadBackground({});
    await loaded.listeners.installed({ reason: "install" });
    assert.equal(loaded.settings.opened || 0, 0);
    assert.equal(loaded.local.quickcalOnboarding.completed, false);

    await loaded.listeners.action({ id: 4, url: "https://example.com/", incognito: false });
    const session = loaded.session.quickcalWidgetSession;
    assert.equal(session.visible, true);
    assert.equal(session.onboarding.active, true);
    assert.equal(session.onboarding.step, "overview");

    await ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "step", step: "demo-event", exampleIndex: 0 },
      contentSender(4)
    );
    assert.equal(loaded.session.quickcalWidgetSession.onboarding.step, "demo-event");

    await ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "step", step: "connect" },
      contentSender(4)
    );
    assert.equal(loaded.local.quickcalOnboarding.step, "connect");

    const connected = await ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "connect" },
      contentSender(4)
    );
    assert.equal(connected.ready, true);
    assert.equal(loaded.tokenCalls.includes(true), true);
    assert.equal(loaded.fetches.some((url) => url.endsWith("/parse-event")), false);

    const done = await ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "complete" },
      contentSender(4)
    );
    assert.equal(done.ok, true);
    assert.equal(loaded.local.quickcalOnboarding.completed, true);
    assert.equal(loaded.session.quickcalWidgetSession.onboarding, null);

    await loaded.listeners.action({ id: 4, url: "https://example.com/", incognito: false });
    await loaded.listeners.action({ id: 4, url: "https://example.com/", incognito: false });
    assert.equal(loaded.session.quickcalWidgetSession.onboarding, null);
  });

  it("keeps dismissed incomplete onboarding and ignores late auth after dismiss", async () => {
    const loaded = loadBackground({ cancel: false });
    await loaded.listeners.installed({ reason: "install" });
    await loaded.listeners.action({ id: 4, url: "https://example.com/", incognito: false });

    const connectPromise = ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "connect" },
      contentSender(4)
    );
    await ask(
      loaded.listeners.message,
      { type: "quickcal-widget", action: "dismiss" },
      contentSender(4)
    );
    const result = await connectPromise;
    assert.equal(result.dismissed || result.ignored, true);
    assert.equal(loaded.session.quickcalWidgetSession.visible, false);
    assert.equal(loaded.local.quickcalOnboarding.completed, false);

    await loaded.listeners.action({ id: 4, url: "https://example.com/", incognito: false });
    assert.equal(loaded.session.quickcalWidgetSession.onboarding.active, true);
    assert.equal(loaded.session.quickcalWidgetSession.onboarding.step, "overview");
  });

  it("preserves highlight text through onboarding without creating anything", async () => {
    const loaded = loadBackground({});
    await loaded.listeners.installed({ reason: "install" });
    // Simulate context-menu selection path via onboarding gate helpers by writing pending text
    // and completing the tour.
    loaded.local.quickcalOnboarding = {
      version: 1,
      completed: false,
      step: "connect",
      exampleIndex: 0,
      pendingSelection: "Coffee with Alex tomorrow at 10 AM",
      migrated: true,
    };
    await loaded.listeners.action({ id: 4, url: "https://example.com/", incognito: false });
    const connected = await ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "connect" },
      contentSender(4)
    );
    assert.equal(connected.ready, true);
    const done = await ask(
      loaded.listeners.message,
      { type: "quickcal-onboarding", action: "complete" },
      contentSender(4)
    );
    assert.equal(done.pendingSelection, "Coffee with Alex tomorrow at 10 AM");
    assert.equal(loaded.session.quickcalWidgetSession.input, "Coffee with Alex tomorrow at 10 AM");
    assert.equal(loaded.fetches.some((url) => url.endsWith("/parse-event")), false);
  });

  it("does not reset completion on disconnect and keeps replay from forcing incomplete", async () => {
    const loaded = loadBackground({
      local: {
        quickcalWelcomeSeen: true,
        quickcalOnboarding: {
          version: 1,
          completed: true,
          step: "connect",
          migrated: true,
          pendingSelection: "",
          exampleIndex: 0,
        },
      },
    });
    await loaded.listeners.installed({ reason: "update" });
    assert.equal(loaded.local.quickcalOnboarding.completed, true);

    await ask(
      loaded.listeners.message,
      { type: "quickcal-auth", action: "disconnect" },
      {
        id: "epnmambadhgonpaplpfgajhdpbkaiikb",
        url: extensionOrigin + "/options/options.html",
      }
    );
    assert.equal(loaded.local.quickcalOnboarding.completed, true);

    const replay = await ask(
      loaded.listeners.message,
      { type: "quickcal-auth", action: "replay-tour" },
      {
        id: "epnmambadhgonpaplpfgajhdpbkaiikb",
        url: extensionOrigin + "/options/options.html",
      }
    );
    assert.equal(replay.replay, true);
    assert.equal(loaded.local.quickcalOnboarding.completed, true);
    assert.equal(loaded.session.quickcalWidgetSession.onboarding.replay, true);

    await ask(
      loaded.listeners.message,
      { type: "quickcal-widget", action: "dismiss" },
      contentSender(4)
    );
    assert.equal(loaded.local.quickcalOnboarding.completed, true);
  });
});
