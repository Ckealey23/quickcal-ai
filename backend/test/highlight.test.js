import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createContext, runInContext } from "node:vm";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const MENU_ID = "quickcal-add-selection";

function loadBackground(hooks) {
  const logs = [];
  const scripts = [];
  const delivered = [];
  const menus = [];
  const listeners = {};
  let injected = !!hooks.ready;
  let failAfterInject = hooks.failOnceAfterInject ? 1 : 0;
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) {
          return "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf/" + file;
        },
        onMessage: { addListener() {} },
        onInstalled: { addListener() {} },
        lastError: undefined,
      },
      contextMenus: {
        create(props, callback) {
          menus.push({ props: props, callback: callback });
          if (hooks.duplicateMenu) sandbox.chrome.runtime.lastError = { message: "Duplicate id" };
          if (callback) callback();
          sandbox.chrome.runtime.lastError = undefined;
        },
        onClicked: { addListener(listener) { listeners.menu = listener; } },
      },
      tabs: {
        sendMessage(tabId, message) {
          if (!injected || failAfterInject > 0) {
            if (injected && failAfterInject > 0) failAfterInject -= 1;
            return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
          }
          delivered.push({ tabId: tabId, message: message });
          return Promise.resolve({ ok: true });
        },
        onActivated: { addListener() {} },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      scripting: {
        executeScript(details) {
          if (hooks.injectError) return Promise.reject(new Error(hooks.injectError));
          injected = true;
          scripts.push(details.files);
          return Promise.resolve();
        },
      },
      storage: { local: { async get() { return {}; }, async set() {}, async remove() {} } },
      identity: { async getAuthToken() { return ""; }, async removeCachedAuthToken() {}, async clearAllCachedAuthTokens() {} },
      offscreen: { async createDocument() {}, async closeDocument() {}, async getContexts() { return []; } },
    },
    fetch: async () => ({ ok: false, status: 404, async json() { return {}; } }),
    console: {
      info(...parts) { logs.push(parts.join(" ")); },
      log(...parts) { logs.push(parts.join(" ")); },
      error(...parts) { logs.push(parts.join(" ")); },
    },
    AbortController,
    AbortSignal,
    URL,
    Uint8Array,
    atob,
    JSON,
    Math,
    Number,
    String,
    crypto,
    setTimeout,
    clearTimeout,
  };
  sandbox.chrome.runtime.getContexts = sandbox.chrome.offscreen.getContexts;
  sandbox.__state = {
    injected: !!hooks.ready,
    failAfterInject: hooks.failOnceAfterInject ? 1 : 0,
    injectError: hooks.injectError || "",
  };
  sandbox.__delivered = delivered;
  sandbox.__scripts = scripts;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = createContext(sandbox);
  runInContext(`
    chrome.tabs.sendMessage = function(tabId, message) {
      if (!__state.injected || __state.failAfterInject > 0) {
        if (__state.injected && __state.failAfterInject > 0) __state.failAfterInject -= 1;
        return Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
      }
      __delivered.push({ tabId: tabId, message: message });
      return Promise.resolve({ ok: true });
    };
    chrome.scripting.executeScript = function(details) {
      if (__state.injectError) return Promise.reject(new Error(__state.injectError));
      __state.injected = true;
      __scripts.push(details.files);
      return Promise.resolve();
    };
  `, context);
  sandbox.importScripts = (...files) => {
    files.forEach((file) => {
      runInContext(readFileSync(path.join(root, file), "utf8"), context, { filename: file });
    });
  };
  runInContext(readFileSync(path.join(root, "background.js"), "utf8"), context, { filename: "background.js" });
  return { listeners, scripts, delivered, logs, menus };
}

function page(id) {
  return { id: id || 7, url: "https://example.com/article" };
}

function click(text) {
  return { menuItemId: MENU_ID, selectionText: text };
}

describe("highlighted text delivery", () => {
  it("registers one selection menu and injects the widget once for a new tab", async () => {
    const background = loadBackground({});
    assert.equal(background.menus.length, 1);
    assert.equal(background.menus[0].props.id, MENU_ID);
    assert.equal(background.menus[0].props.title, "Add to QuickCal");
    assert.equal([].join.call(background.menus[0].props.contexts), "selection");
    assert.equal([].join.call(background.menus[0].props.documentUrlPatterns), "http://*/*,https://*/*");
    background.menus[0].callback();

    await background.listeners.menu(click("Lunch Monday at noon"), page());
    assert.equal(background.scripts.length, 1);
    assert.equal([].join.call(background.scripts[0]), [
      "shared/schedule.js",
      "shared/preview.js",
      "shared/startup.js",
      "shared/selection.js",
      "content/widget.js",
    ].join());
    assert.equal(background.delivered.length, 1);
    assert.equal(background.delivered[0].tabId, 7);
    assert.equal(background.delivered[0].message.type, "quickcal-selection");
    assert.equal(background.delivered[0].message.text, "Lunch Monday at noon");
    assert.equal(background.delivered[0].message.tooLong, false);
    assert.match(background.delivered[0].message.operationId, /^[0-9a-f-]{36}$/);

    await background.listeners.menu(click("Dentist Friday at 3 PM"), page());
    assert.equal(background.scripts.length, 1);
    assert.equal(background.delivered.length, 2);
    assert.notEqual(background.delivered[0].message.operationId, background.delivered[1].message.operationId);
  });

  it("reuses an open widget and retries one operation without a second injection", async () => {
    const open = loadBackground({ ready: true });
    await open.listeners.menu(click("Studio Thursday at 6 PM"), page(3));
    assert.equal(open.scripts.length, 0);
    assert.equal(open.delivered.length, 1);

    const retry = loadBackground({ failOnceAfterInject: true });
    await retry.listeners.menu(click("Studio Thursday at 6 PM"), page(4));
    assert.equal(retry.scripts.length, 1);
    assert.equal(retry.delivered.length, 1);
    assert.equal(retry.delivered[0].message.text, "Studio Thursday at 6 PM");
  });

  it("serializes two clicks so the widget is injected once", async () => {
    const background = loadBackground({});
    await Promise.all([
      background.listeners.menu(click("Lunch Monday at noon"), page(8)),
      background.listeners.menu(click("Dentist Friday at 3 PM"), page(8)),
    ]);
    assert.equal(background.scripts.length, 1);
    assert.equal(background.delivered.length, 2);
  });

  it("does not inject or claim success for an empty selection, a restricted page, or a failed injection", async () => {
    const background = loadBackground({});
    await background.listeners.menu(click("   "), page());
    await background.listeners.menu(click("Lunch Monday at noon"), { id: 9, url: "chrome://extensions" });
    assert.equal(background.scripts.length, 0);
    assert.equal(background.delivered.length, 0);
    assert.match(background.logs.join("\n"), /normal http or https webpage/);
    assert.doesNotMatch(background.logs.join("\n"), /created|saved/i);

    const blocked = loadBackground({ injectError: "Cannot access a chrome:// URL" });
    await blocked.listeners.menu(click("Lunch Monday at noon"), page(11));
    assert.equal(blocked.delivered.length, 0);
    assert.equal(blocked.scripts.length, 0);
    assert.match(blocked.logs.join("\n"), /Cannot access a chrome:\/\/ URL/);
    assert.doesNotMatch(blocked.logs.join("\n"), /created|saved/i);
  });

  it("marks an oversized selection instead of sending the passage", async () => {
    const background = loadBackground({ ready: true });
    const passage = "a".repeat(2001);
    await background.listeners.menu(click(passage), page());
    assert.equal(background.delivered.length, 1);
    assert.equal(background.delivered[0].message.tooLong, true);
    assert.equal(background.delivered[0].message.text, "");
    assert.equal(JSON.stringify(background.delivered[0].message).includes(passage), false);
  });

  it("adds only the context menu permission", () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.permissions.includes("contextMenus"), true);
    assert.equal(manifest.permissions.includes("clipboardRead"), false);
    assert.equal(manifest.permissions.includes("tabs"), false);
    assert.equal(manifest.permissions.includes("notifications"), false);
    assert.equal(manifest.host_permissions.includes("https://quickcal-ai.onrender.com/*"), true);
    assert.equal(manifest.host_permissions.some((pattern) => pattern === "<all_urls>" || pattern === "*://*/*"), false);
  });
});
