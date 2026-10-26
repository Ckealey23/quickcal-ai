import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const extensionOrigin = "chrome-extension://mkihiedalmccmhoebiiikpdoafhdfglf";
const TOKEN = "ya29.voice-extension-token";
const AUDIO = Buffer.from("simulated-audio-bytes").toString("base64");

function loadBackground(hooks) {
  const store = {};
  const fetches = [];
  const messages = [];
  const tabMessages = [];
  const logs = [];
  const listeners = {};
  let offscreen = false;
  const sandbox = {
    chrome: {
      action: { onClicked: { addListener() {} } },
      runtime: {
        id: "mkihiedalmccmhoebiiikpdoafhdfglf",
        getURL(file) {
          return extensionOrigin + "/" + file;
        },
        onMessage: { addListener(listener) { listeners.message = listener; } },
        onInstalled: { addListener() {} },
        async getContexts() {
          return offscreen ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
        },
        async sendMessage(message) {
          messages.push(message);
          if (message.action === "permission") {
            return { ok: true, state: hooks.mic || "granted", sessionId: message.sessionId };
          }
          if (message.action === "start") {
            hooks.started = (hooks.started || 0) + 1;
            if (hooks.micError) return { ok: false, error: hooks.micError, sessionId: message.sessionId };
            return { ok: true, sessionId: message.sessionId };
          }
          if (message.action === "finish") {
            return { ok: true, sessionId: message.sessionId, mime: "audio/webm", audioBase64: AUDIO };
          }
          if (message.action === "cancel") {
            hooks.cancels = (hooks.cancels || 0) + 1;
            return { ok: true };
          }
          return { ok: false };
        },
        async openOptionsPage() {},
      },
      offscreen: {
        async createDocument() {
          offscreen = true;
          hooks.created = (hooks.created || 0) + 1;
        },
        async closeDocument() {
          offscreen = false;
          hooks.closed = (hooks.closed || 0) + 1;
        },
      },
      tabs: {
        async create() {
          hooks.permissionTabs = (hooks.permissionTabs || 0) + 1;
          return { id: 99 };
        },
        async remove(tabId) {
          hooks.removedTabs = hooks.removedTabs || [];
          hooks.removedTabs.push(tabId);
        },
        async sendMessage(tabId, message) {
          tabMessages.push({ tabId, message });
        },
        onActivated: { addListener(listener) { listeners.activated = listener; } },
        onRemoved: { addListener(listener) { listeners.removed = listener; } },
        onUpdated: { addListener(listener) { listeners.updated = listener; } },
      },
      scripting: { executeScript() { return Promise.resolve(); } },
      storage: {
        local: {
          async get(key) { return { [key]: store[key] }; },
          async set(value) { Object.assign(store, value); },
          async remove(key) { delete store[key]; },
        },
      },
      identity: {
        async getAuthToken() {
          hooks.tokens = (hooks.tokens || 0) + 1;
          if (hooks.noToken) return "";
          return TOKEN;
        },
        async removeCachedAuthToken() {},
        async clearAllCachedAuthTokens() {},
      },
    },
    fetch: async (url, options) => {
      fetches.push({ url: String(url), options: options || {} });
      if (String(url).endsWith("/health")) {
        if (hooks.healthDown) return { ok: false, status: 503, async json() { return { ok: false }; } };
        return { ok: true, status: 200, async json() { return { ok: true }; } };
      }
      if (String(url).endsWith("/transcribe")) {
        hooks.transcriptions = (hooks.transcriptions || 0) + 1;
        if (hooks.transcribeFails) throw new TypeError("Failed to fetch");
        if (hooks.emptyTranscript) {
          return { ok: true, status: 200, async json() { return { text: "  " }; } };
        }
        return { ok: true, status: 200, async json() { return { text: "Lunch tomorrow at noon" }; } };
      }
      return { ok: false, status: 404, async json() { return {}; } };
    },
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
  return { listeners, fetches, messages, tabMessages, logs, store };
}

function contentSender(tabId) {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    tab: { id: tabId == null ? 7 : tabId },
    url: "https://example.com/page",
  };
}

function offscreenSender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    url: extensionOrigin + "/offscreen/offscreen.html",
  };
}

function permissionSender() {
  return {
    id: "mkihiedalmccmhoebiiikpdoafhdfglf",
    url: extensionOrigin + "/mic/permission.html",
  };
}

function ask(listener, message, sender) {
  return new Promise((resolve) => {
    const keep = listener(message, sender, resolve);
    if (keep !== true) resolve(undefined);
  });
}

describe("voice capture", () => {
  it("uses an offscreen document and transcribes one granted recording through the service worker", async () => {
    const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.permissions.includes("offscreen"), true);
    assert.equal(manifest.permissions.includes("microphone"), false);

    const hooks = {};
    const loaded = loadBackground(hooks);
    const started = await ask(loaded.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    assert.equal(started.phase, "recording");
    assert.equal(started.audioBase64, undefined);
    assert.equal(hooks.permissionTabs || 0, 0);
    assert.equal(hooks.started, 1);
    assert.equal(loaded.fetches.some((call) => call.url.endsWith("/transcribe")), false);

    const first = ask(loaded.listeners.message, { type: "quickcal-voice", action: "stop", sessionId: started.sessionId }, contentSender());
    const second = ask(loaded.listeners.message, { type: "quickcal-voice", action: "stop", sessionId: started.sessionId }, contentSender());
    const replies = await Promise.all([first, second]);
    assert.equal(replies[0].text, "Lunch tomorrow at noon");
    assert.equal(replies[1].text, "Lunch tomorrow at noon");
    const posts = loaded.fetches.filter((call) => call.url.endsWith("/transcribe"));
    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, "https://quickcal-ai.onrender.com/transcribe");
    assert.equal(posts[0].options.headers.Authorization, "Bearer " + TOKEN);
    assert.equal(posts[0].options.headers["Content-Type"].startsWith("audio/webm"), true);
    assert.equal(String(posts[0].options.body).includes(TOKEN), false);
    assert.equal(JSON.stringify(replies[0]).includes(TOKEN), false);
    assert.equal(JSON.stringify(replies[0]).includes(AUDIO), false);
    assert.equal(loaded.logs.some((line) => line.includes(TOKEN) || line.includes(AUDIO)), false);
    assert.equal(loaded.fetches.some((call) => call.url.endsWith("/parse-event")), false);
  });

  it("keeps the recording for an explicit retry and does not submit a cancelled or limited take", async () => {
    const cold = {};
    const loaded = loadBackground(cold);
    cold.healthDown = true;
    const started = await ask(loaded.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    const held = await ask(
      loaded.listeners.message,
      { type: "quickcal-voice", action: "stop", sessionId: started.sessionId },
      contentSender()
    );
    assert.equal(held.phase, "held");
    assert.equal(loaded.fetches.some((call) => call.url.endsWith("/transcribe")), false);
    cold.healthDown = false;
    const retried = await ask(
      loaded.listeners.message,
      { type: "quickcal-voice", action: "retry", sessionId: started.sessionId },
      contentSender()
    );
    assert.equal(retried.text, "Lunch tomorrow at noon");
    assert.equal(loaded.fetches.filter((call) => call.url.endsWith("/transcribe")).length, 1);

    const limited = loadBackground({});
    const live = await ask(limited.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    limited.listeners.message(
      { type: "quickcal-offscreen", action: "limit", sessionId: live.sessionId },
      offscreenSender(),
      () => {}
    );
    assert.equal(limited.fetches.some((call) => call.url.endsWith("/transcribe")), false);
    assert.equal(limited.tabMessages.some((item) => item.message.phase === "review"), true);
    const submitted = await ask(
      limited.listeners.message,
      { type: "quickcal-voice", action: "stop", sessionId: live.sessionId },
      contentSender()
    );
    assert.equal(submitted.text, "Lunch tomorrow at noon");
    assert.equal(limited.fetches.filter((call) => call.url.endsWith("/transcribe")).length, 1);

    const cancelled = loadBackground({});
    const recording = await ask(cancelled.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    const dropped = await ask(
      cancelled.listeners.message,
      { type: "quickcal-voice", action: "cancel", sessionId: recording.sessionId },
      contentSender()
    );
    assert.equal(dropped.phase, "idle");
    assert.equal(cancelled.fetches.some((call) => call.url.endsWith("/transcribe")), false);
    const late = await ask(
      cancelled.listeners.message,
      { type: "quickcal-voice", action: "stop", sessionId: recording.sessionId },
      contentSender()
    );
    assert.equal(late.ignored, true);
    assert.equal(cancelled.fetches.some((call) => call.url.endsWith("/transcribe")), false);
    cancelled.listeners.activated({ tabId: 8 });
  });

  it("opens a visible permission page only when Chrome has not granted the microphone", async () => {
    const hooks = { mic: "prompt" };
    const loaded = loadBackground(hooks);
    const waiting = await ask(loaded.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    assert.equal(waiting.phase, "permission");
    assert.equal(hooks.permissionTabs, 1);
    assert.equal(hooks.started || 0, 0);
    const granted = await ask(
      loaded.listeners.message,
      { type: "quickcal-mic", action: "granted" },
      permissionSender()
    );
    assert.equal(granted.phase, "recording");
    assert.equal(hooks.started, 1);
    assert.equal(loaded.tabMessages[0].tabId, 7);

    const blocked = loadBackground({ mic: "denied" });
    const denied = await ask(blocked.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    assert.match(denied.error, /blocked/);
    assert.equal(blocked.fetches.some((call) => call.url.endsWith("/transcribe")), false);

    const missing = loadBackground({ micError: "QuickCalAI could not find a microphone." });
    const absent = await ask(missing.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    assert.match(absent.error, /could not find a microphone/);
    assert.equal(missing.fetches.some((call) => call.url.endsWith("/transcribe")), false);

    const silent = loadBackground({ emptyTranscript: true });
    const heard = await ask(silent.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender());
    const quiet = await ask(
      silent.listeners.message,
      { type: "quickcal-voice", action: "stop", sessionId: heard.sessionId },
      contentSender()
    );
    assert.match(quiet.error, /didn't hear any words/);
    assert.equal(quiet.phase, "idle");
    const again = await ask(
      silent.listeners.message,
      { type: "quickcal-voice", action: "retry", sessionId: heard.sessionId },
      contentSender()
    );
    assert.equal(again.ignored, true);
    assert.equal(silent.fetches.filter((call) => call.url.endsWith("/transcribe")).length, 1);

    const other = loadBackground({});
    const owned = await ask(other.listeners.message, { type: "quickcal-voice", action: "start" }, contentSender(7));
    other.listeners.removed(7);
    other.listeners.activated({ tabId: 3 });
    const foreign = await ask(
      other.listeners.message,
      { type: "quickcal-voice", action: "stop", sessionId: owned.sessionId },
      contentSender(8)
    );
    assert.equal(foreign.text, "Lunch tomorrow at noon");
    assert.equal(other.fetches.filter((call) => call.url.endsWith("/transcribe")).length, 1);
    const second = await ask(
      other.listeners.message,
      { type: "quickcal-voice", action: "stop", sessionId: owned.sessionId },
      contentSender(4)
    );
    assert.equal(second.ignored, true);
    assert.equal(other.fetches.filter((call) => call.url.endsWith("/transcribe")).length, 1);
  });
});
