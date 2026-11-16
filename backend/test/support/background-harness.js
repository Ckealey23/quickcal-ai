import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../../..");
export const EXTENSION_ID = "mkihiedalmccmhoebiiikpdoafhdfglf";

export const plain = (value) => JSON.parse(JSON.stringify(value));

export function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status: status,
    async json() {
      if (body === undefined) throw new SyntaxError("no body");
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

export function sender(tabId) {
  return { id: EXTENSION_ID, tab: { id: tabId || 4, incognito: false }, url: "https://example.com/page" };
}

// Loads background.js in a sandbox. `route(url, options)` answers every fetch
// that is not part of the connection check; it may return undefined to fall
// through to a 404.
export function loadBackground(options) {
  const settings = options || {};
  const local = settings.local || {};
  const session = settings.session || {};
  const fetches = [];
  const delivered = [];
  const listeners = {};
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: EXTENSION_ID,
        getURL(file) {
          return "chrome-extension://" + EXTENSION_ID + "/" + file;
        },
        getManifest() {
          return { update_url: "https://clients2.google.com/service/update2/crx" };
        },
        async getPlatformInfo() {
          return { os: "win" };
        },
        onMessage: { addListener(listener) { listeners.message = listener; } },
        onInstalled: { addListener() {} },
        onStartup: { addListener() {} },
        async openOptionsPage() {
          settings.openedOptions = true;
        },
        lastError: undefined,
      },
      contextMenus: {
        create(props, callback) {
          if (callback) callback();
        },
        removeAll(callback) {
          if (callback) callback();
        },
        onClicked: { addListener() {} },
      },
      tabs: {
        async query() {
          return settings.tabs || [];
        },
        async get(tabId) {
          return (settings.tabs || []).find((tab) => tab.id === tabId) || null;
        },
        async sendMessage(tabId, message) {
          delivered.push({ tabId: tabId, message: message });
          return { ok: true };
        },
        onActivated: { addListener() {} },
        onRemoved: { addListener() {} },
        onUpdated: { addListener() {} },
      },
      scripting: { async executeScript() {} },
      storage: {
        local: {
          async get(key) {
            return { [key]: local[key] };
          },
          async set(value) {
            Object.assign(local, plain(value));
          },
          async remove(key) {
            delete local[key];
          },
        },
        session: settings.noSession ? undefined : {
          async get(key) {
            return { [key]: session[key] === undefined ? undefined : plain(session[key]) };
          },
          async set(value) {
            Object.assign(session, plain(value));
          },
          async remove(key) {
            (Array.isArray(key) ? key : [key]).forEach((name) => delete session[name]);
          },
        },
      },
      identity: {
        async getAuthToken() {
          if (settings.disconnected) return "";
          return "ya29.test-token";
        },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: async (url, init) => {
      const href = String(url);
      const request = init || {};
      fetches.push({ url: href, options: request });
      if (href.includes("/access")) return response(200, { ok: true, approved: true });
      if (href.includes("maxResults=1&fields=kind")) return response(200, { kind: "calendar#events" });
      if (href.includes("/users/me/calendarList")) {
        return response(200, { items: settings.calendars || [{ id: "primary", summary: "Primary", primary: true, accessRole: "owner" }] });
      }
      const routed = settings.route ? await settings.route(href, request) : undefined;
      if (routed) return routed;
      if (href.includes("singleEvents=true")) return response(200, { items: [] });
      if (href.includes("/freeBusy")) return response(200, { calendars: {} });
      return response(404, {});
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
    Map,
    Set,
    Error,
    TypeError,
    crypto,
    AbortSignal,
    TextEncoder,
    TextDecoder,
    atob,
    btoa,
    setTimeout: settings.setTimeout || setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    encodeURIComponent,
    decodeURIComponent,
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

  function ask(message, from) {
    return new Promise((resolve) => {
      const async = listeners.message(message, from || sender(), (reply) => resolve(plain(reply)));
      if (async !== true) resolve(undefined);
    });
  }

  return { ask, fetches, delivered, local, session, sandbox };
}
