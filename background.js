importScripts(
  "shared/schedule.js",
  "shared/test-event.js",
  "shared/local-parse.js",
  "shared/preview.js",
  "shared/recording.js",
  "shared/transcribe.js",
  "shared/selection.js",
  "shared/layout.js",
  "shared/session.js"
);

const SUPPORTED_PAGE = /^https?:\/\//i;

function canInject(url) {
  return typeof url === "string" && SUPPORTED_PAGE.test(url);
}

function reportBlocked(error) {
  const detail = error ? " " + error.message : "";
  console.info(
    "QuickCalAI: open a normal http or https webpage. Chrome blocks the input bar on browser pages." +
      detail
  );
}

function accessFailureText(error) {
  const message = error && error.message ? error.message : "";
  if (/cannot access|site access|permission|denied|gallery/i.test(message)) {
    return (
      "QuickCalAI does not have site access on this page. In chrome://extensions, open QuickCalAI, allow access to ordinary websites, and reload the page. " +
      message
    );
  }
  return message || "QuickCalAI could not open the shared panel on this page.";
}

const WIDGET_FILES = [
  "shared/schedule.js",
  "shared/preview.js",
  "shared/startup.js",
  "shared/selection.js",
  "shared/layout.js",
  "content/widget.js",
];
const WIDGET_MESSAGE = "quickcal-widget";
const SELECTION_MENU_ID = "quickcal-add-selection";
const SELECTION_MESSAGE = "quickcal-selection";
const selectionChains = new Map();

function createOperationId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "sel-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendSelection(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (error) {
    return false;
  }
}

async function deliverSelectionOnce(tabId, message) {
  if (await sendSelection(tabId, message)) {
    return { ok: true, injected: false, operationId: message.operationId };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: WIDGET_FILES,
    });
  } catch (error) {
    reportBlocked(error);
    return { ok: false, injected: false, operationId: message.operationId };
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await sendSelection(tabId, message)) {
      return { ok: true, injected: true, operationId: message.operationId };
    }
    await wait(50);
  }
  reportBlocked();
  return { ok: false, injected: true, operationId: message.operationId };
}

async function tabWidgetPresence(tabId) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return { present: false, open: false };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: WIDGET_MESSAGE, action: "ping" });
    return { present: !!(response && response.ok), open: !!(response && response.open) };
  } catch (error) {
    return { present: false, open: false };
  }
}

async function focusSharedWidget(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: WIDGET_MESSAGE, action: "focus" });
  } catch (error) {
    console.info("QuickCalAI: the shared panel is open, but this page could not focus it.");
  }
}

async function toggleWidget(tab) {
  if (!tab || tab.id == null || !canInject(tab.url)) {
    reportBlocked();
    return;
  }
  if (!sessionStore()) {
    console.info("QuickCalAI: chrome.storage.session is unavailable, so QuickCal cannot share one conversation across tabs.");
    return;
  }
  const incognito = !!tab.incognito;
  const before = await readWidgetSession(incognito);
  const presence = await tabWidgetPresence(tab.id);
  if (before.visible && !presence.open) {
    const delivered = await deliverSession(tab.id, before);
    if (delivered === "blocked" || delivered === "failed") return;
    await focusSharedWidget(tab.id);
    return;
  }
  const state = await mutateWidgetSession(incognito, (current) => {
    if (current.visible) return self.QuickCalSession.dismiss(current);
    return self.QuickCalSession.claim(self.QuickCalSession.show(current), tab.id).state;
  });
  const delivered = await deliverSession(tab.id, state);
  if (delivered === "blocked" || delivered === "failed") return;
  if (state.visible) await focusSharedWidget(tab.id);
}

function enqueueSelection(tabId, task) {
  const previous = selectionChains.get(tabId) || Promise.resolve();
  const run = previous.then(task, task);
  selectionChains.set(
    tabId,
    run.then(
      () => undefined,
      () => undefined
    )
  );
  return run;
}

function handleSelection(info, tab) {
  if (!info || info.menuItemId !== SELECTION_MENU_ID) return Promise.resolve({ ok: false });
  const text = typeof info.selectionText === "string" ? info.selectionText : "";
  if (!text.trim()) return Promise.resolve({ ok: false });
  if (!tab || tab.id == null || !canInject(tab.url)) {
    reportBlocked();
    return Promise.resolve({ ok: false, blocked: true });
  }
  const operationId = createOperationId();
  const tooLong = text.trim().length > self.QuickCalSelection.MAX_TEXT_LENGTH;
  const message = {
    type: SELECTION_MESSAGE,
    operationId: operationId,
    text: tooLong ? "" : text,
    tooLong: tooLong,
  };
  return enqueueSelection(tab.id, () => deliverSelectionOnce(tab.id, message));
}

function registerSelectionMenu() {
  if (!chrome.contextMenus || !chrome.contextMenus.create) return;
  chrome.contextMenus.create(
    {
      id: SELECTION_MENU_ID,
      title: "Add to QuickCal",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

registerSelectionMenu();

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const run = handleSelection(info, tab);
    run.catch(() => {});
    return run;
  });
}

chrome.action.onClicked.addListener((tab) => {
  const run = toggleWidget(tab);
  run.catch(() => {});
  return run;
});

const AUTH_MESSAGE = "quickcal-auth";
const SUPPRESS_KEY = "quickcalCalendarSuppressed";
const WELCOME_KEY = "quickcalWelcomeSeen";
const CALENDAR_PROBE_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind";
const TEST_EVENT_KEY = "quickcalTestEvent";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const AUTH_ACTIONS = new Set(["status", "connect", "disconnect", "create-test-event"]);
const BACKEND_MESSAGE = "quickcal-backend";
const HEALTH_ATTEMPT_MS = 10000;
const ACCESS_TIMEOUT_MS = 10000;

let healthInFlight = null;

chrome.runtime.onInstalled.addListener((details) => openWelcomeOnce(details).catch(() => {}));

async function openWelcomeOnce(details) {
  if (!details || (details.reason !== "install" && details.reason !== "update")) return;
  if (details.reason === "update") {
    const stored = await chrome.storage.local.get(WELCOME_KEY);
    if (stored[WELCOME_KEY] === true) return;
  }
  await chrome.storage.local.set({ [WELCOME_KEY]: true });
  await chrome.runtime.openOptionsPage();
}

let authChain = Promise.resolve();
let connectInFlight = false;
let createInFlight = false;

function runAuth(message) {
  const action = message && message.action;
  if (action === "connect" && connectInFlight) {
    return Promise.resolve(
      failed("Google Calendar connection is already in progress.")
    );
  }
  if (action === "create-test-event" && createInFlight) {
    return Promise.resolve(failed("Test event creation is already in progress."));
  }
  if (action === "connect") connectInFlight = true;
  if (action === "create-test-event") createInFlight = true;

  const result = authChain
    .then(() => performAuth(message))
    .finally(() => {
      if (action === "connect") connectInFlight = false;
      if (action === "create-test-event") createInFlight = false;
    });
  authChain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function extensionToken(result) {
  if (typeof result === "string") return result;
  if (result && typeof result.token === "string") return result.token;
  return "";
}

const PARSE_MESSAGE = "quickcal-parse";
const CALENDAR_MESSAGE = "quickcal-calendar";
const VOICE_MESSAGE = "quickcal-voice";
const OFFSCREEN_MESSAGE = "quickcal-offscreen";
const MIC_MESSAGE = "quickcal-mic";
const DRAFT_EVENT_KEY = "quickcalDraftEvent";
const WIDGET_DESCRIPTION = "Created by QuickCalAI.";

function isParseSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || !sender.tab || sender.tab.id == null) {
    return false;
  }
  if (typeof sender.url !== "string" || !/^https?:\/\//i.test(sender.url)) return false;
  try {
    const senderUrl = new URL(sender.url);
    const optionsUrl = new URL(chrome.runtime.getURL("options/options.html"));
    return !(
      senderUrl.origin === optionsUrl.origin && senderUrl.pathname === optionsUrl.pathname
    );
  } catch (error) {
    return false;
  }
}

async function parseForContent(message) {
  const input = self.QuickCalLocalParse.validateParseRequest(message);
  if (!input.ok) return { ok: false, error: input.error };
  if (await isSuppressed()) {
    return {
      ok: false,
      state: "disconnected",
      error: "Connect Google Calendar before using QuickCalAI.",
    };
  }
  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    return {
      ok: false,
      state: "disconnected",
      error: "Connect Google Calendar before using QuickCalAI.",
    };
  }
  if (!token) {
    return {
      ok: false,
      state: "disconnected",
      error: "Connect Google Calendar before using QuickCalAI.",
    };
  }
  return self.QuickCalLocalParse.requestLocalParse(input, { fetchImpl: fetch, token: token });
}

function isOptionsSender(sender) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== "string") {
    return false;
  }

  try {
    const senderUrl = new URL(sender.url);
    const optionsUrl = new URL(chrome.runtime.getURL("options/options.html"));
    return (
      senderUrl.origin === optionsUrl.origin &&
      senderUrl.pathname === optionsUrl.pathname
    );
  } catch (error) {
    return false;
  }
}

function disconnected(message) {
  return { state: "disconnected", message: message || "" };
}

function failed(message) {
  return { state: "error", message: message };
}

function authFailure(error, interactive) {
  const message = String(error && error.message ? error.message : "").toLowerCase();

  if (
    message.includes("did not approve") ||
    message.includes("cancelled") ||
    message.includes("canceled")
  ) {
    return failed("Google Calendar connection was cancelled.");
  }

  if (
    message.includes("bad client id") ||
    message.includes("invalid client") ||
    message.includes("invalid oauth") ||
    message.includes("client id")
  ) {
    return failed("Google sign-in is not configured correctly for this extension.");
  }

  if (
    message.includes("network") ||
    message.includes("offline") ||
    message.includes("could not be loaded")
  ) {
    return failed("QuickCalAI could not reach Google. Check your connection and try again.");
  }

  if (
    !interactive &&
    (message.includes("not granted") ||
      message.includes("revoked") ||
      message.includes("not signed in") ||
      message === "")
  ) {
    return disconnected();
  }

  if (message.includes("not granted") || message.includes("revoked")) {
    return failed("Google Calendar permission was not granted.");
  }

  if (!interactive) return disconnected();
  return failed("Google Calendar could not be connected.");
}

function calendarFailure(status) {
  if (status === 401) {
    return failed("Google Calendar rejected the authorization. Connect again.");
  }
  if (status === 403) {
    return failed("This Google account did not allow QuickCalAI to access Calendar.");
  }
  return failed("Google Calendar could not be verified (" + status + ").");
}

async function isSuppressed() {
  const stored = await chrome.storage.local.get(SUPPRESS_KEY);
  return stored[SUPPRESS_KEY] === true;
}

async function setSuppressed(value) {
  await chrome.storage.local.set({ [SUPPRESS_KEY]: value });
}

async function requestToken(interactive) {
  return extensionToken(
    await chrome.identity.getAuthToken({ interactive: interactive })
  );
}

async function removeCachedToken(token) {
  if (!token) return;
  try {
    await chrome.identity.removeCachedAuthToken({ token: token });
  } catch (error) {
    // The cache is cleared again before disconnect finishes.
  }
}

async function probeCalendar(token) {
  let response;
  try {
    response = await fetch(CALENDAR_PROBE_URL, {
      method: "GET",
      credentials: "omit",
      headers: { Authorization: "Bearer " + token },
    });
  } catch (error) {
    return { network: true };
  }

  if (response.status === 401) return { unauthorized: true };
  if (!response.ok) return { status: response.status };

  try {
    await response.json();
  } catch (error) {
    return { unreadable: true };
  }
  return { ok: true };
}

async function verifyCalendar(token) {
  let result = await probeCalendar(token);
  if (result.unauthorized) {
    await removeCachedToken(token);
    let refreshed = "";
    try {
      refreshed = await requestToken(false);
    } catch (error) {
      return calendarFailure(401);
    }
    if (!refreshed || refreshed === token) return calendarFailure(401);
    result = await probeCalendar(refreshed);
    if (result.unauthorized) {
      await removeCachedToken(refreshed);
      return calendarFailure(401);
    }
  }

  if (result.ok) return { state: "connected", message: "" };
  if (result.network) {
    return failed("QuickCalAI could not reach Google Calendar. Check your connection and try again.");
  }
  if (result.unreadable) {
    return failed("Google Calendar returned an unreadable response.");
  }
  return calendarFailure(result.status);
}

function readyTestEvent(now) {
  return Object.assign(
    { phase: "ready", htmlLink: "" },
    self.QuickCalTestEvent.localTomorrowWindow(now || new Date())
  );
}

function publicTestEvent(record) {
  return {
    phase: record.phase,
    summary: record.summary,
    description: record.description,
    startDateTime: record.startDateTime,
    endDateTime: record.endDateTime,
    timeZone: record.timeZone,
    dateText: record.dateText,
    timeText: record.timeText,
    htmlLink: typeof record.htmlLink === "string" ? record.htmlLink : "",
  };
}

function isRfc3339(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/.test(value)
  );
}

function clientPayload(event) {
  if (!event || typeof event !== "object") return null;
  const payload = {
    summary: event.summary,
    description: event.description,
    startDateTime: event.startDateTime,
    endDateTime: event.endDateTime,
    timeZone: event.timeZone,
  };
  if (payload.summary !== self.QuickCalTestEvent.SUMMARY) return null;
  if (payload.description !== self.QuickCalTestEvent.DESCRIPTION) return null;
  if (!isRfc3339(payload.startDateTime) || !isRfc3339(payload.endDateTime)) return null;
  if (typeof payload.timeZone !== "string" || payload.timeZone.length < 1 || payload.timeZone.length > 100) {
    return null;
  }
  return payload;
}

function createEventId() {
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  const bytes = new Uint8Array(26);
  crypto.getRandomValues(bytes);
  let id = "";
  for (let index = 0; index < bytes.length; index += 1) {
    id += alphabet[bytes[index] & 31];
  }
  return id;
}

async function loadTestEvent() {
  const stored = await chrome.storage.local.get(TEST_EVENT_KEY);
  const record = stored[TEST_EVENT_KEY];
  if (!record || typeof record !== "object") return null;
  if (!self.QuickCalTestEvent.isValidEventId(record.id)) return null;
  if (record.phase !== "pending" && record.phase !== "created") return null;
  if (!clientPayload(record)) return null;
  if (typeof record.dateText !== "string" || typeof record.timeText !== "string") return null;
  return record;
}

async function saveTestEvent(record) {
  await chrome.storage.local.set({ [TEST_EVENT_KEY]: record });
}

async function clearTestEvent() {
  await chrome.storage.local.remove(TEST_EVENT_KEY);
}

async function withTestEvent(result) {
  if (!result || result.state !== "connected") return result;
  const stored = await loadTestEvent();
  result.testEvent = stored ? publicTestEvent(stored) : readyTestEvent(new Date());
  return result;
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (error) {
    return null;
  }
}

async function verifyAccess(token) {
  let response;
  try {
    response = await fetch(self.QuickCalLocalParse.ACCESS_URL, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      headers: { Authorization: "Bearer " + token },
      signal: AbortSignal.timeout(ACCESS_TIMEOUT_MS),
    });
  } catch (error) {
    return { ready: false, message: "QuickCalAI could not be reached. Try again." };
  }
  const body = await readJson(response);
  if (response.status === 200 && body && body.ok === true && body.approved === true) {
    return { ready: true, message: "" };
  }
  const message = body && typeof body.error === "string" ? body.error : "";
  if (response.status === 403 && message.indexOf("confirm an email") !== -1) {
    return { ready: false, needsReconnect: true, message: message };
  }
  if (response.status === 403) {
    return {
      ready: false,
      message: message || "This Google account is not approved for QuickCalAI.",
    };
  }
  if (response.status === 401) {
    return {
      ready: false,
      needsReconnect: true,
      message: "Google sign-in is required. Connect again.",
    };
  }
  return { ready: false, message: "QuickCalAI could not be reached. Try again." };
}

function accessResult(calendar, access) {
  if (!calendar || calendar.state !== "connected") return calendar;
  if (access && access.ready) {
    return { state: "ready", message: "", googleConnected: true, quickcalReady: true };
  }
  return {
    state: "connected",
    message: access && access.message ? access.message : "QuickCalAI could not be reached. Try again.",
    googleConnected: true,
    quickcalReady: false,
    needsReconnect: !!(access && access.needsReconnect),
  };
}

async function refreshStatus() {
  if (await isSuppressed()) return disconnected();

  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    return authFailure(error, false);
  }
  if (!token) return disconnected();
  const calendar = await verifyCalendar(token);
  if (!calendar || calendar.state !== "connected") return calendar;
  return accessResult(calendar, await verifyAccess(token));
}

async function connectCalendar() {
  let existing = "";
  try {
    existing = await requestToken(false);
  } catch (error) {
    existing = "";
  }
  if (existing) await removeCachedToken(existing);

  let token = "";
  try {
    token = await requestToken(true);
  } catch (error) {
    return authFailure(error, true);
  }
  if (!token) return failed("Google Calendar could not be connected.");

  const calendar = await verifyCalendar(token);
  if (!calendar || calendar.state !== "connected") return calendar;
  try {
    await setSuppressed(false);
  } catch (error) {
    return failed("QuickCalAI could not save the Calendar connection.");
  }
  return accessResult(calendar, await verifyAccess(token));
}

async function disconnectCalendar() {
  let token = "";
  let revokeFailed = false;
  try {
    token = await requestToken(false);
  } catch (error) {
    const message = String(error && error.message ? error.message : "").toLowerCase();
    const absent =
      message.includes("not granted") ||
      message.includes("revoked") ||
      message.includes("not signed in") ||
      message === "";
    token = "";
    if (!absent) revokeFailed = true;
  }

  if (token) {
    try {
      const response = await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=" + encodeURIComponent(token),
      });
      revokeFailed = !response.ok;
    } catch (error) {
      revokeFailed = true;
    }
    await removeCachedToken(token);
  }

  try {
    await chrome.identity.clearAllCachedAuthTokens();
  } catch (error) {
    // An empty token cache can reject. Local suppression still blocks reconnecting.
  }

  let storageError = false;
  try {
    await setSuppressed(true);
  } catch (error) {
    storageError = true;
  }
  try {
    await clearTestEvent();
  } catch (error) {
    storageError = true;
  }
  try {
    await clearDraftEvent();
  } catch (error) {
    storageError = true;
  }
  if (storageError) {
    return failed("QuickCalAI could not clear its saved authorization state.");
  }

  if (revokeFailed) {
    return failed(
      "Google did not revoke access, but QuickCalAI cleared its saved authorization. It will not reconnect until you choose Connect."
    );
  }
  return disconnected();
}

function eventPatchUrl(id) {
  return (
    CALENDAR_EVENTS_URL +
    "/" +
    encodeURIComponent(id) +
    "?sendUpdates=none&fields=id,summary,htmlLink,status"
  );
}

function eventReadUrl(id) {
  return (
    CALENDAR_EVENTS_URL +
    "/" +
    encodeURIComponent(id) +
    "?fields=id,summary,htmlLink,status"
  );
}

function eventInsertUrl() {
  return CALENDAR_EVENTS_URL + "?sendUpdates=none&fields=id,summary,htmlLink,status";
}

function insertBody(record) {
  return JSON.stringify({
    id: record.id,
    summary: record.summary,
    description: record.description,
    start: { dateTime: record.startDateTime, timeZone: record.timeZone },
    end: { dateTime: record.endDateTime, timeZone: record.timeZone },
    reminders: { useDefault: false },
  });
}

function safeCalendarLink(value) {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    const calendarHost =
      url.hostname === "calendar.google.com" ||
      (url.hostname === "www.google.com" && url.pathname.indexOf("/calendar/") === 0);
    if (url.protocol !== "https:" || !calendarHost) return "";
    return url.href;
  } catch (error) {
    return "";
  }
}

function confirmedRecord(record, body) {
  if (!body || body.id !== record.id || body.summary !== record.summary) return null;
  if (body.status === "cancelled") return null;
  const link = safeCalendarLink(body.htmlLink);
  if (!link) return null;
  return {
    id: record.id,
    phase: "created",
    summary: record.summary,
    description: record.description,
    startDateTime: record.startDateTime,
    endDateTime: record.endDateTime,
    timeZone: record.timeZone,
    dateText: record.dateText,
    timeText: record.timeText,
    htmlLink: link,
  };
}

function connectedWith(testEvent, message) {
  return { state: "connected", message: message || "", testEvent: testEvent };
}

function createAuthFailure(error) {
  const result = authFailure(error, false);
  if (result.state === "disconnected" && !result.message) {
    return failed("Google Calendar rejected the authorization. Connect again.");
  }
  return result;
}

async function calendarFetch(token, url, options) {
  let response;
  try {
    response = await fetch(url, {
      method: options.method,
      credentials: "omit",
      headers: Object.assign(
        { Authorization: "Bearer " + token },
        options.body ? { "Content-Type": "application/json" } : null
      ),
      body: options.body,
    });
  } catch (error) {
    return { network: true };
  }

  if (response.status === 401) return { unauthorized: true };
  if (response.status === 404) return { notFound: true };
  if (response.status === 409) return { conflict: true };

  let body = null;
  try {
    body = await response.json();
  } catch (error) {
    body = null;
  }
  if (response.ok) return { ok: true, status: response.status, body: body };
  return { status: response.status, body: body };
}

async function calendarCall(url, options) {
  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    return { authError: error };
  }
  if (!token) return { authError: new Error("OAuth2 not granted or revoked.") };

  let result = await calendarFetch(token, url, options);
  if (!result.unauthorized) return result;

  await removeCachedToken(token);
  try {
    token = await requestToken(false);
  } catch (error) {
    return { authError: error, unauthorized: true };
  }
  if (!token) return { unauthorized: true };

  result = await calendarFetch(token, url, options);
  if (result.unauthorized) await removeCachedToken(token);
  return result;
}

async function lookupEvent(record) {
  return calendarCall(eventReadUrl(record.id), { method: "GET" });
}

async function postEvent(record) {
  return calendarCall(eventInsertUrl(), { method: "POST", body: insertBody(record) });
}

async function finishSaved(record, body) {
  const saved = confirmedRecord(record, body);
  if (!saved) {
    return connectedWith(
      publicTestEvent(record),
      "Google Calendar did not confirm the saved test event."
    );
  }
  try {
    await saveTestEvent(saved);
  } catch (error) {
    return connectedWith(
      publicTestEvent(saved),
      "The test event was saved, but QuickCalAI could not remember it. Check Google Calendar before trying again."
    );
  }
  return connectedWith(publicTestEvent(saved), "");
}

function pendingError(record, message) {
  return connectedWith(publicTestEvent(record), message);
}

function callFailed(result) {
  if (result.unauthorized) return calendarFailure(401);
  if (result.authError) return createAuthFailure(result.authError);
  return null;
}

function withEvent(result, record) {
  if (result && record) result.testEvent = publicTestEvent(record);
  return result;
}

async function insertOrRecover(record) {
  const existing = await lookupEvent(record);
  const existingFailure = callFailed(existing);
  if (existingFailure) return withEvent(existingFailure, record);
  if (existing.network) {
    return pendingError(
      record,
      "QuickCalAI could not reach Google Calendar. Check your connection and try again."
    );
  }
  if (existing.ok) return finishSaved(record, existing.body);
  if (!existing.notFound) {
    if (existing.status === 403) {
      return pendingError(
        record,
        "This Google account did not allow QuickCalAI to create a Calendar event."
      );
    }
    return pendingError(
      record,
      "Google Calendar could not be checked (" + (existing.status || "unknown") + ")."
    );
  }

  const created = await postEvent(record);
  const createdFailure = callFailed(created);
  if (createdFailure) return withEvent(createdFailure, record);
  if (created.ok) return finishSaved(record, created.body);

  const uncertain =
    created.network || created.conflict || (created.status && created.status >= 500);
  if (!uncertain) {
    if (created.status === 403) {
      return pendingError(
        record,
        "This Google account did not allow QuickCalAI to create a Calendar event."
      );
    }
    return pendingError(
      record,
      "Google Calendar could not save the test event (" + (created.status || "unknown") + ")."
    );
  }

  const check = await lookupEvent(record);
  const checkFailure = callFailed(check);
  if (checkFailure) return withEvent(checkFailure, record);
  if (check.ok) return finishSaved(record, check.body);
  if (check.notFound && (created.network || (created.status && created.status >= 500))) {
    const second = await postEvent(record);
    const secondFailure = callFailed(second);
    if (secondFailure) return withEvent(secondFailure, record);
    if (second.ok) return finishSaved(record, second.body);
    if (second.conflict || second.network || (second.status && second.status >= 500)) {
      const again = await lookupEvent(record);
      const againFailure = callFailed(again);
      if (againFailure) return withEvent(againFailure, record);
      if (again.ok) return finishSaved(record, again.body);
    } else if (second.status === 403) {
      return pendingError(
        record,
        "This Google account did not allow QuickCalAI to create a Calendar event."
      );
    } else {
      return pendingError(
        record,
        "Google Calendar could not save the test event (" + (second.status || "unknown") + ")."
      );
    }
  }

  return pendingError(
    record,
    "QuickCalAI could not confirm whether the test event was saved. It will use the same event if you try again."
  );
}

async function createTestEvent(event) {
  if (await isSuppressed()) {
    return disconnected("Connect Google Calendar before creating a test event.");
  }

  const status = await refreshStatus();
  if (!status || (status.state !== "connected" && status.state !== "ready")) return status;
  if (!status.testEvent) status.testEvent = readyTestEvent(new Date());

  const proposed = clientPayload(event);
  if (!proposed) {
    return connectedWith(status.testEvent, "The test event details are not valid.");
  }

  const stored = await loadTestEvent();
  if (stored && stored.phase === "created") {
    return connectedWith(publicTestEvent(stored), "");
  }

  let record = stored;
  if (stored && stored.phase === "pending") {
    if (!self.QuickCalTestEvent.sameTestPayload(stored, proposed)) {
      return connectedWith(
        publicTestEvent(stored),
        "Review the test event time shown below, then create that event."
      );
    }
  } else {
    const canonical = self.QuickCalTestEvent.localTomorrowWindow(new Date());
    if (!self.QuickCalTestEvent.sameTestPayload(canonical, proposed)) {
      return connectedWith(
        readyTestEvent(new Date()),
        "The test event time changed. Review the updated time, then create that event."
      );
    }
    record = {
      id: createEventId(),
      phase: "pending",
      summary: canonical.summary,
      description: canonical.description,
      startDateTime: canonical.startDateTime,
      endDateTime: canonical.endDateTime,
      timeZone: canonical.timeZone,
      dateText: canonical.dateText,
      timeText: canonical.timeText,
      htmlLink: "",
    };
    try {
      await saveTestEvent(record);
    } catch (error) {
      return failed("QuickCalAI could not save the test event request.");
    }
  }

  return insertOrRecover(record);
}

const widgetSaves = new Map();

function scheduleFields(source) {
  return {
    fingerprint: source.fingerprint,
    location: source.location || "",
    date: source.date,
    endDate: source.endDate,
    startTime: source.startTime,
    endTime: source.endTime,
    recurrence: source.recurrence || null,
    recurrenceRule: source.recurrenceRule || "",
    recurrenceText: source.recurrenceText || "",
    seriesEndText: source.seriesEndText || "",
  };
}

function applyScheduleFields(target, source) {
  const fields = scheduleFields(source);
  Object.keys(fields).forEach((key) => {
    target[key] = fields[key];
  });
  return target;
}

function publicSavedEvent(record) {
  return {
    ok: true,
    summary: record.summary,
    dateText: record.dateText,
    timeText: record.timeText,
    timeZone: record.timeZone,
    htmlLink: record.htmlLink,
    title: record.summary,
    date: record.date,
    endDate: record.endDate,
    startTime: record.startTime,
    endTime: record.endTime,
    location: record.location || null,
    durationDefaulted: false,
    recurrence: record.recurrence || null,
    recurrenceText: record.recurrenceText || "",
    seriesEndText: record.seriesEndText || "",
  };
}

function widgetInsertBody(record) {
  const body = {
    id: record.id,
    summary: record.summary,
    description: record.description,
    start: { dateTime: record.startDateTime, timeZone: record.timeZone },
    end: { dateTime: record.endDateTime, timeZone: record.timeZone },
    reminders: { useDefault: false },
  };
  if (record.location) body.location = record.location;
  if (record.recurrenceRule) body.recurrence = [record.recurrenceRule];
  return JSON.stringify(body);
}

async function loadDraftEvent() {
  const stored = await chrome.storage.local.get(DRAFT_EVENT_KEY);
  const record = stored[DRAFT_EVENT_KEY];
  if (!record || typeof record !== "object") return null;
  if (!self.QuickCalTestEvent.isValidEventId(record.id)) return null;
  if (record.phase !== "pending" && record.phase !== "created") return null;
  if (typeof record.fingerprint !== "string" || !record.fingerprint) return null;
  if (record.description !== WIDGET_DESCRIPTION) return null;
  if (!isRfc3339(record.startDateTime) || !isRfc3339(record.endDateTime)) return null;
  if (typeof record.summary !== "string" || typeof record.dateText !== "string" || typeof record.timeText !== "string") {
    return null;
  }
  return record;
}

async function clearDraftEvent() {
  await chrome.storage.local.remove(DRAFT_EVENT_KEY);
}

async function saveDraftEvent(record) {
  await chrome.storage.local.set({ [DRAFT_EVENT_KEY]: record });
}

async function commitWidgetRecord(record) {
  const existing = await lookupEvent(record);
  const existingFailure = callFailed(existing);
  if (existingFailure) {
    return { ok: false, error: existingFailure.message || "Google Calendar could not be checked." };
  }
  if (existing.network) {
    return {
      ok: false,
      error: "QuickCalAI could not reach Google Calendar. Check your connection and try again.",
    };
  }
  if (existing.ok) {
    const saved = confirmedRecord(record, existing.body);
    if (!saved) return { ok: false, error: "Google Calendar did not confirm the saved event." };
    applyScheduleFields(saved, record);
    try {
      await saveDraftEvent(saved);
    } catch (error) {
      return publicSavedEvent(saved);
    }
    return publicSavedEvent(saved);
  }
  if (!existing.notFound) {
    if (existing.status === 403) {
      return { ok: false, error: "This Google account did not allow QuickCalAI to create a Calendar event." };
    }
    return {
      ok: false,
      error: "Google Calendar could not be checked (" + (existing.status || "unknown") + ").",
    };
  }

  const created = await calendarCall(eventInsertUrl(), { method: "POST", body: widgetInsertBody(record) });
  const createdFailure = callFailed(created);
  if (createdFailure) {
    return { ok: false, error: createdFailure.message || "Google Calendar could not save this event." };
  }
  if (created.ok) {
    const saved = confirmedRecord(record, created.body);
    if (!saved) return { ok: false, error: "Google Calendar did not confirm the saved event." };
    applyScheduleFields(saved, record);
    try {
      await saveDraftEvent(saved);
    } catch (error) {
      return publicSavedEvent(saved);
    }
    return publicSavedEvent(saved);
  }

  const uncertain = created.network || created.conflict || (created.status && created.status >= 500);
  if (!uncertain) {
    if (created.status === 403) {
      return { ok: false, error: "This Google account did not allow QuickCalAI to create a Calendar event." };
    }
    return {
      ok: false,
      error: "Google Calendar could not save this event (" + (created.status || "unknown") + ").",
    };
  }

  const check = await lookupEvent(record);
  const checkFailure = callFailed(check);
  if (checkFailure) {
    return { ok: false, error: checkFailure.message || "Google Calendar could not be checked." };
  }
  if (check.ok) {
    const saved = confirmedRecord(record, check.body);
    if (!saved) return { ok: false, error: "Google Calendar did not confirm the saved event." };
    applyScheduleFields(saved, record);
    await saveDraftEvent(saved);
    return publicSavedEvent(saved);
  }
  if (check.notFound && (created.network || (created.status && created.status >= 500))) {
    const second = await calendarCall(eventInsertUrl(), { method: "POST", body: widgetInsertBody(record) });
    if (second.ok) {
      const saved = confirmedRecord(record, second.body);
      if (!saved) return { ok: false, error: "Google Calendar did not confirm the saved event." };
      applyScheduleFields(saved, record);
      await saveDraftEvent(saved);
      return publicSavedEvent(saved);
    }
  }

  return {
    ok: false,
    error: "QuickCalAI could not confirm whether this event was saved. It will use the same event if you try again.",
  };
}

function missingCalendarGrant(status, message) {
  const authorized = !!(
    status &&
    (status.state === "connected" || status.state === "ready" || status.googleConnected === true)
  );
  if (authorized) return null;
  if (!status || status.state === "disconnected") {
    return { ok: false, state: "disconnected", error: message };
  }
  return {
    ok: false,
    error: status.message || "QuickCalAI could not verify Google Calendar. Try again.",
  };
}

async function saveWidgetEventOnce(prepared) {
  const denied = missingCalendarGrant(
    await refreshStatus(),
    "Connect Google Calendar before saving this event."
  );
  if (denied) return denied;

  const stored = await loadDraftEvent();
  if (stored && stored.fingerprint === prepared.fingerprint && stored.phase === "created" && stored.htmlLink) {
    return publicSavedEvent(stored);
  }

  let record = stored;
  if (!stored || stored.fingerprint !== prepared.fingerprint || stored.phase !== "pending") {
    record = applyScheduleFields({
      id: createEventId(),
      phase: "pending",
      summary: prepared.summary,
      description: prepared.description,
      startDateTime: prepared.startDateTime,
      endDateTime: prepared.endDateTime,
      timeZone: prepared.timeZone,
      dateText: prepared.dateText,
      timeText: prepared.timeText,
      htmlLink: "",
    }, prepared);
    try {
      await saveDraftEvent(record);
    } catch (error) {
      return { ok: false, error: "QuickCalAI could not save this event request." };
    }
  }

  return commitWidgetRecord(record);
}

function saveWidgetEvent(event) {
  const prepared = self.QuickCalSchedule.prepareForSave(event);
  if (!prepared) {
    return Promise.resolve({
      ok: false,
      error: "This event needs a title, date, and start and end time before it can be saved.",
    });
  }
  const current = widgetSaves.get(prepared.fingerprint);
  if (current) return current;
  const promise = saveWidgetEventOnce(prepared).finally(() => {
    widgetSaves.delete(prepared.fingerprint);
  });
  widgetSaves.set(prepared.fingerprint, promise);
  return promise;
}

function rememberedEvent(record, prepared) {
  return applyScheduleFields({
    id: record.id,
    phase: "created",
    summary: prepared.summary,
    description: record.description,
    startDateTime: prepared.startDateTime,
    endDateTime: prepared.endDateTime,
    timeZone: prepared.timeZone,
    dateText: prepared.dateText,
    timeText: prepared.timeText,
    htmlLink: record.htmlLink,
  }, prepared);
}

async function patchWidgetEvent(stored, prepared) {
  const denied = missingCalendarGrant(
    await refreshStatus(),
    "Connect Google Calendar before changing this event."
  );
  if (denied) return denied;
  const next = rememberedEvent(stored, prepared);
  const patched = await calendarCall(eventPatchUrl(stored.id), {
    method: "PATCH",
    body: widgetInsertBody(next),
  });
  const failure = callFailed(patched);
  if (failure) return { ok: false, error: failure.message || "Google Calendar could not update this event." };
  if (patched.network) {
    return { ok: false, error: "QuickCalAI could not reach Google Calendar. Check your connection and try again." };
  }
  if (!patched.ok) {
    return {
      ok: false,
      error: "Google Calendar could not update this event (" + (patched.status || "unknown") + ").",
    };
  }
  const saved = confirmedRecord(next, patched.body);
  if (!saved) return { ok: false, error: "Google Calendar did not confirm the update." };
  applyScheduleFields(saved, next);
  try {
    await saveDraftEvent(saved);
  } catch (error) {
    return publicSavedEvent(saved);
  }
  return publicSavedEvent(saved);
}

function updateWidgetEvent(event) {
  const prepared = self.QuickCalSchedule.prepareForSave(event);
  if (!prepared) {
    return Promise.resolve({
      ok: false,
      error: "QuickCalAI needs a clearer change before it can update this event.",
    });
  }
  return loadDraftEvent().then((stored) => {
    if (!stored || stored.phase !== "created" || !stored.htmlLink) {
      return {
        ok: false,
        state: "disconnected",
        error: "Connect Google Calendar before changing this event.",
      };
    }
    const key = "update:" + stored.id;
    const current = widgetSaves.get(key);
    if (current) return current;
    const promise = patchWidgetEvent(stored, prepared).finally(() => {
      widgetSaves.delete(key);
    });
    widgetSaves.set(key, promise);
    return promise;
  });
}

async function activeWidgetEvent() {
  if (await isSuppressed()) return { ok: true, connected: false, event: null };
  const stored = await loadDraftEvent();
  if (!stored || stored.phase !== "created" || !stored.htmlLink) {
    return { ok: true, connected: true, event: null };
  }
  const event = publicSavedEvent(stored);
  delete event.ok;
  return { ok: true, connected: true, event: event };
}

async function widgetCalendarStatus() {
  if (await isSuppressed()) return { ok: true, connected: false, quickcalReady: false, message: "" };
  const status = await refreshStatus();
  const googleConnected = !!(
    status &&
    (status.state === "connected" || status.state === "ready" || status.googleConnected === true)
  );
  return {
    ok: true,
    connected: googleConnected,
    quickcalReady: !!(status && status.quickcalReady === true),
    message: status && typeof status.message === "string" ? status.message : "",
  };
}

async function checkHealth() {
  if (healthInFlight) return healthInFlight;
  const pending = (async () => {
    try {
      const response = await fetch(self.QuickCalLocalParse.HEALTH_URL, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(HEALTH_ATTEMPT_MS),
      });
      if (!response.ok) return { ok: false };
      const body = await readJson(response);
      return { ok: !!(body && body.ok === true) };
    } catch (error) {
      return { ok: false };
    }
  })();
  healthInFlight = pending;
  try {
    return await pending;
  } finally {
    if (healthInFlight === pending) healthInFlight = null;
  }
}

const voice = self.QuickCalRecording.createRecordingController();
let voiceStartedAt = 0;
let voiceAudio = null;
let voiceTask = null;
let voiceAbort = null;
let permissionTabId = null;

function isExtensionPage(sender, path) {
  if (!sender || sender.id !== chrome.runtime.id || typeof sender.url !== "string") return false;
  try {
    const senderUrl = new URL(sender.url);
    const pageUrl = new URL(chrome.runtime.getURL(path));
    return senderUrl.origin === pageUrl.origin && senderUrl.pathname === pageUrl.pathname;
  } catch (error) {
    return false;
  }
}

function tellTab(tabId, payload) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return;
  chrome.tabs.sendMessage(tabId, Object.assign({ type: VOICE_MESSAGE }, payload)).catch(() => {});
}

async function ensureOffscreen() {
  const contexts = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
    : [];
  if (contexts && contexts.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record microphone audio for a calendar event.",
  });
}

async function closeOffscreen() {
  try {
    const contexts = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })
      : [];
    if (!contexts || !contexts.length) return;
    await chrome.offscreen.closeDocument();
  } catch (error) {
    // The document may already be closed.
  }
}

async function closePermissionTab() {
  const tabId = permissionTabId;
  permissionTabId = null;
  if (tabId == null || !chrome.tabs || !chrome.tabs.remove) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // The permission tab may already be closed.
  }
}

async function offscreenCall(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage(Object.assign({ type: OFFSCREEN_MESSAGE }, message));
}

function clearVoiceAudio() {
  voiceAudio = null;
  if (voiceAbort) {
    voiceAbort.abort();
    voiceAbort = null;
  }
}

async function beginCapture(sessionId, tabId) {
  let started;
  try {
    started = await offscreenCall({ action: "start", sessionId: sessionId });
  } catch (error) {
    started = null;
  }
  if (voice.snapshot().sessionId !== sessionId) {
    await closeOffscreen();
    return { ok: false, ignored: true };
  }
  if (!started || !started.ok) {
    voice.cancel(sessionId, tabId);
    await closeOffscreen();
    return {
      ok: false,
      phase: "idle",
      error: started && started.error ? started.error : "QuickCalAI could not reach the microphone.",
    };
  }
  voice.markRecording(sessionId);
  voiceStartedAt = Date.now();
  publishVoice().catch(() => {});
  return { ok: true, phase: "recording", sessionId: sessionId, startedAt: voiceStartedAt };
}

async function startVoice(tabId, incognito) {
  const begun = voice.begin(tabId, incognito);
  if (!begun.ok) return { ok: false, error: begun.error, phase: voice.snapshot().phase };
  clearVoiceAudio();
  let permission;
  try {
    permission = await offscreenCall({ action: "permission", sessionId: begun.sessionId });
  } catch (error) {
    permission = null;
  }
  if (voice.snapshot().sessionId !== begun.sessionId) return { ok: false, ignored: true };
  if (!permission || !permission.ok) {
    voice.cancel(begun.sessionId, tabId);
    await closeOffscreen();
    return { ok: false, phase: "idle", error: "QuickCalAI could not reach the microphone." };
  }
  if (permission.state === "granted") {
    await closeOffscreen();
    return beginCapture(begun.sessionId, tabId);
  }
  if (permission.state === "denied") {
    voice.cancel(begun.sessionId, tabId);
    await closeOffscreen();
    return {
      ok: false,
      phase: "idle",
      error: "Microphone access is blocked. Allow the microphone for QuickCalAI in Chrome settings, then try again.",
    };
  }
  await closeOffscreen();
  try {
    const tab = await chrome.tabs.create({
      url: chrome.runtime.getURL("mic/permission.html"),
      active: true,
    });
    permissionTabId = tab && tab.id != null ? tab.id : null;
  } catch (error) {
    voice.cancel(begun.sessionId, tabId);
    return { ok: false, phase: "idle", error: "QuickCalAI could not open microphone access." };
  }
  return { ok: true, phase: "permission", sessionId: begun.sessionId };
}

async function transcribeHeld(sessionId) {
  if (voice.snapshot().sessionId !== sessionId) return { ok: false, ignored: true };
  const health = await checkHealth();
  if (voice.snapshot().sessionId !== sessionId) return { ok: false, ignored: true };
  if (!health || !health.ok) {
    voice.hold(sessionId);
    return {
      ok: false,
      phase: "held",
      sessionId: sessionId,
      error: "QuickCalAI is still starting. Try again.",
    };
  }
  if (await isSuppressed()) {
    voice.hold(sessionId);
    return {
      ok: false,
      phase: "held",
      state: "disconnected",
      sessionId: sessionId,
      error: "Connect Google Calendar before using QuickCalAI.",
    };
  }
  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    token = "";
  }
  if (voice.snapshot().sessionId !== sessionId) return { ok: false, ignored: true };
  if (!token) {
    voice.hold(sessionId);
    return {
      ok: false,
      phase: "held",
      state: "disconnected",
      sessionId: sessionId,
      error: "Connect Google Calendar before using QuickCalAI.",
    };
  }
  voiceAbort = new AbortController();
  const signal = voiceAbort.signal;
  let result;
  try {
    result = await self.QuickCalTranscribe.requestTranscription(voiceAudio, {
      fetchImpl: fetch,
      token: token,
      signal: signal,
    });
  } catch (error) {
    result = { ok: false, retain: true, error: "QuickCalAI could not reach QuickCal. Try again." };
  }
  if (signal.aborted || voice.snapshot().sessionId !== sessionId) {
    return { ok: false, ignored: true };
  }
  if (!result || !result.ok) {
    if (result && result.ignored) return { ok: false, ignored: true };
    if (result && result.retain) voice.hold(sessionId);
    else {
      voice.finish(sessionId);
      clearVoiceAudio();
    }
    return {
      ok: false,
      phase: result && result.retain ? "held" : "idle",
      state: result && result.state ? result.state : "",
      sessionId: sessionId,
      error: result && result.error ? result.error : "QuickCalAI could not transcribe that recording.",
    };
  }
  const text = result.text;
  voice.finish(sessionId);
  clearVoiceAudio();
  return { ok: true, text: text, sessionId: sessionId };
}

async function submitVoice(tabId, sessionId, incognito) {
  const snap = voice.snapshot();
  if (snap.sessionId !== sessionId || !!snap.incognito !== !!incognito) return { ok: false, ignored: true };
  if (voiceTask) return voiceTask;
  const decision = voice.requestSubmit(sessionId, tabId, incognito);
  if (!decision.submit) return { ok: false, ignored: true };
  voiceTask = (async () => {
    if (!voiceAudio) {
      let audio = null;
      try {
        audio = await offscreenCall({ action: "finish", sessionId: sessionId });
      } catch (error) {
        audio = null;
      }
      await closeOffscreen();
      if (voice.snapshot().sessionId !== sessionId) return { ok: false, ignored: true };
      if (!audio || !audio.ok || audio.sessionId !== sessionId || !audio.audioBase64) {
        voice.finish(sessionId);
        return { ok: false, phase: "idle", error: "QuickCalAI didn't hear any words. Try again." };
      }
      voiceAudio = { mime: audio.mime, audioBase64: audio.audioBase64 };
    }
    return transcribeHeld(sessionId);
  })().finally(() => {
    voiceTask = null;
    publishVoice().catch(() => {});
  });
  return voiceTask;
}

async function cancelVoice(sessionId, tabId) {
  const decision = voice.cancel(sessionId, tabId);
  if (!decision.ok) return decision;
  clearVoiceAudio();
  try {
    await offscreenCall({ action: "cancel", sessionId: sessionId });
  } catch (error) {
    // The offscreen document may already be gone.
  }
  await closeOffscreen();
  await closePermissionTab();
  voiceStartedAt = 0;
  publishVoice().catch(() => {});
  return { ok: true, phase: "idle", submit: false };
}

async function onMicGranted() {
  const snap = voice.snapshot();
  if (snap.phase !== "arming") return { ok: true, ignored: true };
  await closePermissionTab();
  const result = await beginCapture(snap.sessionId, snap.tabId);
  tellTab(snap.tabId, result);
  return result;
}

async function onMicDenied(message) {
  const snap = voice.snapshot();
  if (snap.phase !== "arming") return { ok: true, ignored: true };
  const error = message && message.error
    ? message.error
    : "QuickCalAI needs microphone access. Allow the microphone and try again.";
  voice.cancel(snap.sessionId, snap.tabId);
  await closeOffscreen();
  tellTab(snap.tabId, { ok: false, phase: "idle", error: error, sessionId: snap.sessionId });
  return { ok: true };
}

function onVoiceLimit(sessionId) {
  const decision = voice.limit(sessionId);
  if (!decision.ok) return;
  publishVoice().catch(() => {});
  tellTab(voice.snapshot().tabId, {
    ok: true,
    phase: "review",
    sessionId: sessionId,
    startedAt: voiceStartedAt,
    error: "",
  });
}

function onVoiceTabActivated(info) {
  publishVoice().catch(() => {});
  ensureTabSession(info && info.tabId).catch(() => {});
}

function onVoiceTabRemoved(tabId) {
  if (tabId === permissionTabId && voice.snapshot().phase === "arming") {
    const snap = voice.snapshot();
    permissionTabId = null;
    cancelVoice(snap.sessionId, snap.tabId).then(() => {
      tellTab(snap.tabId, {
        ok: false,
        phase: "idle",
        sessionId: snap.sessionId,
        error: "QuickCalAI needs microphone access. Allow the microphone and try again.",
      });
    });
    return;
  }
}

function onVoiceTabUpdated(tabId, info, tab) {
  publishVoice().catch(() => {});
  if (!info || info.status !== "complete" || !tab || !canInject(tab.url)) return;
  ensureTabSession(tab.id).catch(() => {});
}

function reply(result) {
  const safe = {
    state: result && result.state ? result.state : "error",
    message: result && typeof result.message === "string" ? result.message : "",
    googleConnected: !!(result && result.googleConnected === true),
    quickcalReady: !!(result && result.quickcalReady === true),
    needsReconnect: !!(result && result.needsReconnect === true),
  };
  if (result && result.testEvent && typeof result.testEvent === "object") {
    safe.testEvent = publicTestEvent(result.testEvent);
  }
  return safe;
}

function performAuth(message) {
  const action = message && message.action;
  if (action === "status") return refreshStatus();
  if (action === "connect") return connectCalendar();
  if (action === "disconnect") return disconnectCalendar();
  if (action === "create-test-event") return createTestEvent(message.event);
  return Promise.resolve(failed("QuickCalAI could not complete that request."));
}

if (chrome.tabs && chrome.tabs.onActivated) chrome.tabs.onActivated.addListener(onVoiceTabActivated);
if (chrome.tabs && chrome.tabs.onRemoved) chrome.tabs.onRemoved.addListener(onVoiceTabRemoved);
if (chrome.tabs && chrome.tabs.onUpdated) chrome.tabs.onUpdated.addListener(onVoiceTabUpdated);

let widgetSessionChain = Promise.resolve();

function sessionStore() {
  return chrome.storage && chrome.storage.session ? chrome.storage.session : null;
}

async function readWidgetSession(incognito) {
  const blank = self.QuickCalSession.create(!!incognito);
  const store = sessionStore();
  if (!store) return blank;
  const key = self.QuickCalSession.storageKey(!!incognito);
  const stored = await store.get(key);
  const value = stored ? stored[key] : null;
  if (!value || value.incognito !== !!incognito || typeof value.sessionId !== "string") return blank;
  return value;
}

async function writeWidgetSession(state) {
  const store = sessionStore();
  if (!store) return state;
  const key = self.QuickCalSession.storageKey(!!state.incognito);
  await store.set({ [key]: state });
  return state;
}

function mutateWidgetSession(incognito, updater) {
  const run = widgetSessionChain.then(async () => {
    const store = sessionStore();
    if (!store) {
      console.info("QuickCalAI: chrome.storage.session is unavailable, so QuickCal cannot share one conversation across tabs.");
      return readWidgetSession(incognito);
    }
    const current = await readWidgetSession(incognito);
    const next = await updater(current);
    if (!next) return current;
    await writeWidgetSession(next);
    await broadcastSession(next);
    return next;
  });
  widgetSessionChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function supportedTabs(incognito) {
  if (!chrome.tabs || !chrome.tabs.query) return [];
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    return (tabs || []).filter((tab) => tab && tab.id != null && !!tab.incognito === !!incognito && canInject(tab.url));
  } catch (error) {
    console.info("QuickCalAI: could not list open pages. " + accessFailureText(error));
    return [];
  }
}

async function deliverSession(tabId, state) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.sendMessage) return "failed";
  const message = { type: WIDGET_MESSAGE, action: "render", session: state };
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return "delivered";
  } catch (error) {
    if (!state || !state.visible) return "hidden";
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      console.info("QuickCalAI: " + accessFailureText(error));
      return "failed";
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: WIDGET_FILES,
      });
    } catch (injectError) {
      console.info("QuickCalAI: " + accessFailureText(injectError));
      return "blocked";
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await chrome.tabs.sendMessage(tabId, message);
        return "injected";
      } catch (sendError) {
        await wait(40);
      }
    }
    console.info("QuickCalAI: the shared panel did not start on this page.");
    return "failed";
  }
}

async function broadcastSession(state) {
  if (!state) return;
  const tabs = await supportedTabs(!!state.incognito);
  await Promise.all(tabs.map((tab) => deliverSession(tab.id, state)));
}

function ensureTabSession(tabId) {
  if (tabId == null || !chrome.tabs || !chrome.tabs.get || !sessionStore()) return Promise.resolve();
  return chrome.tabs.get(tabId).then((tab) => {
    if (!tab || tab.id == null || !canInject(tab.url)) return null;
    return readWidgetSession(!!tab.incognito).then((state) => deliverSession(tab.id, state));
  }).catch((error) => {
    console.info("QuickCalAI: " + accessFailureText(error));
  });
}

function wakeSharedTabs() {
  if (!self.QuickCalSession || !sessionStore()) return Promise.resolve();
  return readWidgetSession(false)
    .then((normal) => broadcastSession(normal))
    .then(() => readWidgetSession(true))
    .then((privateSession) => broadcastSession(privateSession))
    .catch((error) => {
      console.info("QuickCalAI: could not restore the shared panel. " + accessFailureText(error));
    });
}

function voiceNotice(snap) {
  return {
    ok: snap.phase !== "idle",
    phase: snap.phase,
    sessionId: snap.sessionId,
    startedAt: voiceStartedAt,
    cancelled: snap.phase === "idle",
  };
}

function voiceSnapshotState(snap) {
  if (!snap || snap.phase === "idle") return null;
  return {
    phase: snap.phase,
    sessionId: snap.sessionId,
    startedAt: voiceStartedAt,
    incognito: !!snap.incognito,
  };
}

async function publishVoice() {
  const snap = voice.snapshot();
  const voiceState = voiceSnapshotState(snap);
  if (self.QuickCalSession && sessionStore()) {
    await mutateWidgetSession(snap.incognito, (state) => {
      const current = state.voice;
      const same = (!current && !voiceState) || (
        current &&
        voiceState &&
        current.phase === voiceState.phase &&
        current.sessionId === voiceState.sessionId &&
        current.startedAt === voiceState.startedAt
      );
      if (same) return state;
      return Object.assign({}, state, { voice: voiceState, revision: state.revision + 1 });
    });
  }
  const notice = voiceNotice(snap);
  if (chrome.tabs && chrome.tabs.query) {
    try {
      const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
      (tabs || []).forEach((tab) => {
        if (!tab || !!tab.incognito !== !!snap.incognito) return;
        tellTab(tab.id, notice);
      });
      return;
    } catch (error) {
      // Fall back to the tab that started recording.
    }
  }
  if (snap.phase !== "idle") tellTab(snap.tabId, notice);
}

function savedPayload(record) {
  if (!record) return null;
  return {
    title: record.title || record.summary,
    date: record.date,
    endDate: record.endDate || record.date,
    startTime: record.startTime,
    endTime: record.endTime,
    timeZone: record.timeZone,
    location: record.location || null,
    recurrence: record.recurrence || null,
  };
}

async function runWidgetSubmit(incognito, text, timeZone, operation, editing, clarification, savedRecord, originalText) {
  const message = { text: text, timeZone: timeZone || "UTC" };
  if (clarification) message.clarification = clarification;
  else if (editing) message.currentEvent = savedPayload(savedRecord);
  const result = await parseForContent(message);
  const pendingState = await mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    if (!result || result.ok !== true || !result.event) {
      const failed = self.QuickCalSession.finishOperation(latest, operation, {
        statusText: result && result.error ? result.error : "QuickCalAI could not read that event.",
        statusError: true,
        input: text,
      });
      return failed.accepted ? failed.state : latest;
    }
    const view = self.QuickCalPreview.previewModel(result.event);
    if (!view.saveable) {
      if (editing) {
        const asked = self.QuickCalSession.finishOperation(latest, operation, {
          mode: "saved",
          event: result.event,
          statusText: "",
          statusError: false,
          input: text,
        });
        return asked.accepted ? asked.state : latest;
      }
      const noted = self.QuickCalSession.noteClarification(latest, result.event, originalText || text);
      const finished = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "clarifying",
        event: noted.event,
        clarification: noted.clarification,
        savedRecord: null,
        draftEvent: null,
        input: "",
        statusText: "",
        statusError: false,
      });
      return finished.accepted ? finished.state : latest;
    }
    return Object.assign({}, latest, {
      mode: editing ? "saved" : "creating",
      event: result.event,
      draftEvent: editing ? null : result.event,
      draftText: text,
      statusText: editing ? "Updating event\u2026" : "Creating event\u2026",
      statusError: false,
    });
  });
  if (!self.QuickCalSession.operationCurrent(pendingState, operation)) return pendingState;
  const saveResult = editing
    ? await updateWidgetEvent(pendingState.event)
    : await saveWidgetEvent(pendingState.event);
  return mutateWidgetSession(incognito, (after) => {
    if (!self.QuickCalSession.operationCurrent(after, operation)) return after;
    if (saveResult && saveResult.ok === true && saveResult.htmlLink) {
      const saved = self.QuickCalSession.finishOperation(after, operation, {
        mode: "saved",
        savedRecord: saveResult,
        event: pendingState.event,
        draftEvent: null,
        clarification: null,
        input: "",
        statusText: "",
        statusError: false,
      });
      return saved.accepted ? saved.state : after;
    }
    const kept = self.QuickCalSession.finishOperation(after, operation, {
      mode: "failed",
      draftEvent: pendingState.event,
      event: pendingState.event,
      statusText: saveResult && saveResult.error ? saveResult.error : "QuickCalAI could not save this event.",
      statusError: true,
      input: text,
    });
    return kept.accepted ? kept.state : after;
  });
}

function handleWidgetMessage(message, sender) {
  const incognito = !!(sender.tab && sender.tab.incognito);
  const tabId = sender.tab.id;
  const action = message.action;
  if (action === "snapshot") {
    return readWidgetSession(incognito).then((state) => ({ ok: true, session: state }));
  }
  if (action === "show") {
    return mutateWidgetSession(incognito, (state) => {
      return self.QuickCalSession.claim(self.QuickCalSession.show(state), tabId).state;
    }).then((state) => ({ ok: true, session: state }));
  }
  if (action === "toggle") {
    return mutateWidgetSession(incognito, (state) => {
      if (state.visible) return self.QuickCalSession.dismiss(state);
      return self.QuickCalSession.claim(self.QuickCalSession.show(state), tabId).state;
    }).then((state) => ({ ok: true, session: state }));
  }
  if (action === "dismiss") {
    const snap = voice.snapshot();
    if (snap.phase !== "idle" && !!snap.incognito === !!incognito) {
      cancelVoice(snap.sessionId, tabId, incognito).catch(() => {});
    }
    return mutateWidgetSession(incognito, (state) => self.QuickCalSession.dismiss(state)).then((state) => ({ ok: true, session: state }));
  }
  if (action === "reset") {
    return mutateWidgetSession(incognito, (state) => self.QuickCalSession.openReset(state)).then((state) => ({ ok: true, session: state }));
  }
  if (action === "claim") {
    return mutateWidgetSession(incognito, (state) => self.QuickCalSession.claim(state, tabId).state).then((state) => ({ ok: true, session: state }));
  }
  if (action === "patch") {
    let accepted = false;
    return mutateWidgetSession(incognito, (state) => {
      const patched = self.QuickCalSession.patchInput(state, {
        tabId: tabId,
        claim: message.claim,
        seq: message.seq,
        input: message.input,
        sessionId: message.sessionId,
      });
      accepted = patched.accepted;
      return patched.state;
    }).then((state) => ({ ok: true, accepted: accepted, session: state }));
  }
  if (action === "layout") {
    return mutateWidgetSession(incognito, (state) => self.QuickCalSession.setLayout(state, message.layout)).then((state) => ({ ok: true, session: state }));
  }
  if (action === "submit") {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) return Promise.resolve({ ok: false, error: "Text is required." });
    let operation = null;
    let context = null;
    return mutateWidgetSession(incognito, (state) => {
      let current = state;
      if (message.fresh) current = self.QuickCalSession.openReset(current);
      if (message.sessionId && !message.fresh && message.sessionId !== current.sessionId) return state;
      const begun = self.QuickCalSession.beginOperation(
        current,
        "parse",
        message.operationId || "op-" + String(current.revision + 1),
        current.sessionId
      );
      if (!begun.accepted) return state;
      operation = begun.state.operation;
      context = {
        editing: current.mode === "saved" && !!current.savedRecord,
        clarification: current.mode === "clarifying" ? current.clarification : null,
        savedRecord: current.savedRecord,
        originalText: current.mode === "clarifying" && current.clarification ? current.clarification.originalText : text,
      };
      return Object.assign({}, begun.state, {
        input: text,
        statusText: context.editing ? "Updating event\u2026" : "Reading your event\u2026",
        statusError: false,
      });
    }).then((state) => {
      if (!operation || !state.operation || state.operation.id !== operation.id) {
        return { ok: false, ignored: true, session: state };
      }
      return runWidgetSubmit(
        incognito,
        text,
        message.timeZone,
        operation,
        context.editing,
        context.clarification,
        context.savedRecord,
        context.originalText
      ).then((session) => ({ ok: true, session: session }));
    });
  }
  return Promise.resolve({ ok: false });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === WIDGET_MESSAGE) {
    if (!isParseSender(sender)) return false;
    handleWidgetMessage(message, sender)
      .then((result) => sendResponse(result))
      .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not update the shared session." }));
    return true;
  }
  if (message && message.type === OFFSCREEN_MESSAGE && isExtensionPage(sender, "offscreen/offscreen.html")) {
    if (message.action === "limit") onVoiceLimit(message.sessionId);
    return false;
  }
  if (message && message.type === MIC_MESSAGE && isExtensionPage(sender, "mic/permission.html")) {
    const pending = message.action === "granted" ? onMicGranted() : onMicDenied(message);
    pending.then((result) => sendResponse(result)).catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message && message.type === VOICE_MESSAGE) {
    if (!isParseSender(sender)) return false;
    const tabId = sender.tab.id;
    const sessionId = message.sessionId;
    if (message.action === "start") {
      startVoice(tabId, !!sender.tab.incognito).then(sendResponse).catch(() => {
        sendResponse({ ok: false, error: "QuickCalAI could not reach the microphone." });
      });
      return true;
    }
    if (message.action === "stop" || message.action === "retry") {
      submitVoice(tabId, sessionId, !!sender.tab.incognito).then(sendResponse).catch(() => {
        sendResponse({ ok: false, error: "QuickCalAI could not transcribe that recording." });
      });
      return true;
    }
    if (message.action === "cancel" || message.action === "discard") {
      cancelVoice(sessionId, tabId, !!sender.tab.incognito).then(sendResponse).catch(() => sendResponse({ ok: true, phase: "idle" }));
      return true;
    }
    sendResponse({ ok: false, error: "QuickCalAI could not complete that request." });
    return false;
  }
  if (message && message.type === BACKEND_MESSAGE && message.action === "health") {
    if (!isParseSender(sender)) return false;
    checkHealth()
      .then((result) => sendResponse({ ok: !!(result && result.ok) }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message && message.type === PARSE_MESSAGE) {
    if (!isParseSender(sender)) return false;
    parseForContent(message)
      .then((result) => {
        sendResponse(result);
      })
      .catch(() => {
        sendResponse({
          ok: false,
          error: "QuickCalAI could not reach QuickCal. Try again.",
        });
      });
    return true;
  }
  if (message && message.type === CALENDAR_MESSAGE) {
    if (!isParseSender(sender)) return false;
    if (message.action === "status") {
      widgetCalendarStatus()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: true, connected: false }));
      return true;
    }
    if (message.action === "open-settings") {
      chrome.runtime.openOptionsPage()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not open Calendar settings." }));
      return true;
    }
    if (message.action === "create") {
      saveWidgetEvent(message.event)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not save this event." }));
      return true;
    }
    if (message.action === "update") {
      updateWidgetEvent(message.event)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not update this event." }));
      return true;
    }
    if (message.action === "active") {
      activeWidgetEvent()
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: true, connected: false, event: null }));
      return true;
    }
    if (message.action === "new") {
      clearDraftEvent()
        .then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not start a new event." }));
      return true;
    }
    return false;
  }
  if (!isOptionsSender(sender)) return false;
  if (!message || message.type !== AUTH_MESSAGE || !AUTH_ACTIONS.has(message.action)) {
    sendResponse(failed("QuickCalAI could not complete that request."));
    return false;
  }

  runAuth(message)
    .then((result) => {
      sendResponse(reply(result));
    })
    .catch(() => {
      sendResponse(failed("QuickCalAI could not complete that request."));
    });
  return true;
});

self.quickcalToggleWidget = toggleWidget;
wakeSharedTabs();
