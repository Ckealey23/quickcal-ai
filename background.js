// Optional machine-local configuration for unpacked development installs.
// Store installs always use the hosted backend; the override is never committed.
if (typeof chrome.runtime.getManifest === "function" && !chrome.runtime.getManifest().update_url) {
  try {
    importScripts("shared/local-config.js");
  } catch (error) {
    // No local override is the normal production configuration.
  }
}

importScripts(
  "shared/schedule.js",
  "shared/test-event.js",
  "shared/local-parse.js",
  "shared/preview.js",
  "shared/recording.js",
  "shared/transcribe.js",
  "shared/selection.js",
  "shared/layout.js",
  "shared/session.js",
  "shared/lookup.js",
  "shared/conflicts.js",
  "shared/availability.js",
  "shared/batch.js",
  "shared/documents.js"
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
  "shared/lookup.js",
  "shared/batch.js",
  "shared/time-options.js",
  "shared/documents.js",
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
const AUTH_ACTIONS = new Set(["status", "connect", "disconnect", "create-test-event", "try"]);
const BACKEND_MESSAGE = "quickcal-backend";
const HEALTH_ATTEMPT_MS = 10000;
const ACCESS_TIMEOUT_MS = 10000;
const TRY_PAGE_URL = "https://example.com/";
const TRY_PAGE_WAIT_MS = 8000;

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

async function probeConflictScopes() {
  const listed = await calendarCall(calendarListUrl(""), { method: "GET" });
  if (listed.authError || listed.unauthorized) return { ok: false, disconnected: true };
  if (listed.network) return { ok: false, network: true };
  if (scopeDenied(listed)) return { ok: false, needsScopes: true };
  if (!listed.ok) return { ok: false };
  return { ok: true };
}

function withConflictScopeHint(result, probe) {
  if (!result || !probe || !probe.needsScopes) return result;
  if (result.state !== "ready" && result.state !== "connected") return result;
  return Object.assign({}, result, {
    needsReconnect: true,
    needsConflictScopes: true,
    message:
      result.message ||
      "Reconnect Google Calendar so QuickCalAI can check other calendars for conflicts.",
  });
}

const TASKS_PROBE_URL = "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1&fields=items(id)";

// A token from before Tasks was added lacks that scope. Reconnecting fixes it;
// a Tasks API that is turned off for the project does not, so it is not flagged.
async function probeTasksScope() {
  const probe = await calendarCall(TASKS_PROBE_URL, { method: "GET" });
  if (probe.ok || probe.status !== 403) return { ok: true };
  const failure = tasksFailure(probe, "");
  return { ok: false, needsScope: failure.state === "needsTasksScope" };
}

async function withTasksScopeHint(result) {
  if (!result || (result.state !== "ready" && result.state !== "connected")) return result;
  let probe;
  try {
    probe = await probeTasksScope();
  } catch (error) {
    return result;
  }
  if (!probe.needsScope) return result;
  return Object.assign({}, result, {
    needsTasksScope: true,
    message: result.message || TASKS_SCOPE_MESSAGE,
  });
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
  const access = accessResult(calendar, await verifyAccess(token));
  if (!access || (access.state !== "ready" && access.state !== "connected")) return access;
  let checked = access;
  try {
    checked = withConflictScopeHint(access, await probeConflictScopes());
  } catch (error) {
    checked = access;
  }
  return withTasksScopeHint(checked);
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
  const access = accessResult(calendar, await verifyAccess(token));
  if (!access || (access.state !== "ready" && access.state !== "connected")) return access;
  let checked = access;
  try {
    checked = withConflictScopeHint(access, await probeConflictScopes());
  } catch (error) {
    checked = access;
  }
  return withTasksScopeHint(checked);
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
    "?sendUpdates=none&fields=id,summary,htmlLink,status,reminders"
  );
}

function eventReadUrl(id) {
  return (
    CALENDAR_EVENTS_URL +
    "/" +
    encodeURIComponent(id) +
    "?fields=id,summary,htmlLink,status,reminders"
  );
}

function eventInsertUrl() {
  return CALENDAR_EVENTS_URL + "?sendUpdates=none&fields=id,summary,htmlLink,status,reminders";
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
  if (record.reminders) {
    if (!Object.hasOwn(body, "reminders")) return null;
    if (!self.QuickCalSchedule.sameReminderSettings(record.reminders, body.reminders)) {
      return null;
    }
  }
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
    reminders: record.reminders || { useDefault: false, overrides: [] },
    remindersText: record.remindersText || self.QuickCalSchedule.reminderSettingsText(record.reminders),
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
        options.body ? { "Content-Type": "application/json" } : null,
        options.headers || null
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
    reminders: source.reminders || { useDefault: false, overrides: [] },
    remindersText: source.remindersText || self.QuickCalSchedule.reminderSettingsText(source.reminders),
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
    id: record.id || "",
    calendarId: record.calendarId || "primary",
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
    startDateTime: record.startDateTime || "",
    endDateTime: record.endDateTime || "",
    location: record.location || null,
    durationDefaulted: false,
    recurrence: record.recurrence || null,
    recurrenceRule: record.recurrenceRule || "",
    recurrenceText: record.recurrenceText || "",
    seriesEndText: record.seriesEndText || "",
    reminders: record.reminders || { useDefault: false, overrides: [] },
    remindersText: record.remindersText || self.QuickCalSchedule.reminderSettingsText(record.reminders),
  };
}

function widgetInsertBody(record) {
  const body = {
    id: record.id,
    summary: record.summary,
    description: record.description,
    start: { dateTime: record.startDateTime, timeZone: record.timeZone },
    end: { dateTime: record.endDateTime, timeZone: record.timeZone },
    reminders: record.reminders || { useDefault: false, overrides: [] },
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
  if (!Object.hasOwn(record, "reminders")) {
    if (record.phase !== "created") return null;
    const persisted = await lookupEvent(record);
    if (!persisted.ok || !persisted.body || !Object.hasOwn(persisted.body, "reminders")) return null;
    record.reminders = persisted.body.reminders;
  }
  const reminders = self.QuickCalSchedule.normalizeReminderSettings(record.reminders);
  if (!reminders.ok) return null;
  record.reminders = reminders.reminders;
  record.remindersText = self.QuickCalSchedule.reminderSettingsText(reminders.reminders);
  await saveDraftEvent(record).catch(() => {});
  return record;
}

async function clearDraftEvent() {
  await chrome.storage.local.remove(DRAFT_EVENT_KEY);
}

async function saveDraftEvent(record) {
  await chrome.storage.local.set({ [DRAFT_EVENT_KEY]: record });
}

async function persistWidgetDraft(record, options) {
  if (options && options.persistDraft === false) return;
  await saveDraftEvent(record);
}

async function commitWidgetRecord(record, options) {
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
      await persistWidgetDraft(saved, options);
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
      await persistWidgetDraft(saved, options);
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
    await persistWidgetDraft(saved, options);
    return publicSavedEvent(saved);
  }
  if (check.notFound && (created.network || (created.status && created.status >= 500))) {
    const second = await calendarCall(eventInsertUrl(), { method: "POST", body: widgetInsertBody(record) });
    if (second.ok) {
      const saved = confirmedRecord(record, second.body);
      if (!saved) return { ok: false, error: "Google Calendar did not confirm the saved event." };
      applyScheduleFields(saved, record);
      await persistWidgetDraft(saved, options);
      return publicSavedEvent(saved);
    }
  }

  return {
    ok: false,
    uncertain: true,
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

async function saveWidgetEventOnce(prepared, preferredId) {
  const denied = missingCalendarGrant(
    await refreshStatus(),
    "Connect Google Calendar before saving this event."
  );
  if (denied) return denied;

  if (preferredId) {
    const probe = await lookupEvent({ id: preferredId });
    const probeFailure = callFailed(probe);
    if (probeFailure) return { ok: false, error: probeFailure.message || "Google Calendar could not be checked." };
    if (probe.ok && probe.body && probe.body.status !== "cancelled") {
      const confirmed = confirmedRecord(applyScheduleFields({
        id: preferredId,
        phase: "created",
        summary: prepared.summary,
        description: prepared.description,
        startDateTime: prepared.startDateTime,
        endDateTime: prepared.endDateTime,
        timeZone: prepared.timeZone,
        dateText: prepared.dateText,
        timeText: prepared.timeText,
        htmlLink: "",
      }, prepared), probe.body);
      if (!confirmed) return { ok: false, error: "Google Calendar did not confirm the saved event." };
      applyScheduleFields(confirmed, prepared);
      return publicSavedEvent(confirmed);
    }
    const record = applyScheduleFields({
      id: preferredId,
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
    return commitWidgetRecord(record, { persistDraft: false });
  }

  let stored = await loadDraftEvent();
  if (stored && stored.fingerprint === prepared.fingerprint && stored.phase === "created" && stored.htmlLink) {
    // A local receipt is not proof that the event still exists: the user can
    // delete it in Calendar and then submit the same schedule again.
    const existing = await lookupEvent(stored);
    const failure = callFailed(existing);
    if (failure) return { ok: false, error: failure.message || "Google Calendar could not be checked." };
    const deleted = existing.notFound || existing.status === 410 ||
      (existing.ok && existing.body && existing.body.status === "cancelled");
    if (!deleted) {
      if (!existing.ok) {
        return { ok: false, error: "QuickCalAI could not verify the previously saved event with Google Calendar. Try again." };
      }
      const confirmed = confirmedRecord(stored, existing.body);
      if (!confirmed) return { ok: false, error: "Google Calendar did not confirm the saved event." };
      applyScheduleFields(confirmed, stored);
      await saveDraftEvent(confirmed);
      return publicSavedEvent(confirmed);
    }
    // Google confirmed deletion. This new submission needs a fresh event ID;
    // reusing a deleted recurring event's ID can conflict with its tombstone.
    stored = null;
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

function saveWidgetEvent(event, options) {
  if (event && event.kind === "task") return saveWidgetTask(event);
  const prepared = self.QuickCalSchedule.prepareForSave(event);
  if (!prepared) {
    return Promise.resolve({
      ok: false,
      error: "This event needs a title, date, and start and end time before it can be saved.",
    });
  }
  const preferredId = options && typeof options.eventId === "string" && self.QuickCalTestEvent.isValidEventId(options.eventId)
    ? options.eventId
    : "";
  const key = preferredId ? "id:" + preferredId : prepared.fingerprint;
  const current = widgetSaves.get(key);
  if (current) return current;
  const promise = saveWidgetEventOnce(prepared, preferredId).finally(() => {
    widgetSaves.delete(key);
  });
  widgetSaves.set(key, promise);
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

function updateWidgetEvent(event, expectedId) {
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
    // The shown event must be the one QuickCal remembers, or the change would
    // land on a different event.
    if (expectedId && stored.id !== expectedId) {
      return { ok: false, error: "QuickCalAI could not find that event to change. Open it in Google Calendar instead." };
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

const TASK_RECEIPT_KEY = "quickcalTaskReceipt";
const TASKS_LIST_URL = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks";
const TASK_FIELDS = "id,title,notes,due,status,deleted,webViewLink,updated";
const TASKS_SCOPE_MESSAGE = "Reconnect Google so QuickCalAI can create Google Tasks.";
const TASKS_DISABLED_MESSAGE =
  "Google Tasks is not enabled for QuickCalAI's Google Cloud project. Enable the Google Tasks API, then try again.";

function taskInsertUrl() {
  return TASKS_LIST_URL + "?fields=" + encodeURIComponent(TASK_FIELDS);
}

function taskReadUrl(id) {
  return TASKS_LIST_URL + "/" + encodeURIComponent(id) + "?fields=" + encodeURIComponent(TASK_FIELDS);
}

function taskRecoveryUrl(updatedMin) {
  return TASKS_LIST_URL +
    "?showCompleted=true&showHidden=true&maxResults=100&updatedMin=" + encodeURIComponent(updatedMin) +
    "&fields=" + encodeURIComponent("items(" + TASK_FIELDS + ")");
}

function tasksLink(value) {
  return self.QuickCalPreview.tasksLink(value) || "https://tasks.google.com/";
}

// Google Tasks stores only the date part of `due`, so a stated due time goes
// into the notes where the user can still see it.
function prepareTask(event) {
  if (!event || event.kind !== "task" || event.needsClarification) return null;
  const title = typeof event.title === "string" ? event.title.trim() : "";
  if (!title || title.length > 200) return null;
  const date = event.date == null ? null : event.date;
  if (date !== null && !self.QuickCalSchedule.resolveLocal(date, "00:00", "UTC").ok) return null;
  const dueTime = event.startTime == null ? null : event.startTime;
  if (dueTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(dueTime)) return null;
  const description = typeof event.description === "string" ? event.description.trim().slice(0, 1000) : "";
  const dueText = self.QuickCalPreview.taskDueTime(dueTime);
  const notes = [description, dueText ? dueText + "." : "", WIDGET_DESCRIPTION].filter(Boolean).join("\n\n");
  return {
    fingerprint: JSON.stringify({ kind: "task", title: title, date: date, dueTime: dueTime, notes: notes }),
    title: title,
    notes: notes,
    due: date ? date + "T00:00:00.000Z" : null,
    date: date,
    dueTime: dueTime,
    description: description,
    timeZone: typeof event.timeZone === "string" ? event.timeZone : "UTC",
  };
}

function publicSavedTask(prepared, body) {
  return {
    ok: true,
    kind: "task",
    id: body.id,
    summary: prepared.title,
    title: prepared.title,
    description: prepared.description || null,
    date: prepared.date,
    endDate: prepared.date,
    startTime: prepared.dueTime,
    endTime: null,
    dateText: prepared.date ? self.QuickCalSchedule.formatCompactDate(prepared.date) : "No due date",
    timeText: self.QuickCalPreview.taskDueTime(prepared.dueTime),
    timeZone: prepared.timeZone,
    htmlLink: tasksLink(body.webViewLink),
    location: null,
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    remindersText: "",
    recurrenceText: "",
    seriesEndText: "",
  };
}

function confirmedTask(prepared, body) {
  if (!body || typeof body.id !== "string" || !body.id || body.deleted === true) return false;
  if (body.title !== prepared.title || (body.notes || "") !== prepared.notes) return false;
  const due = typeof body.due === "string" ? body.due.slice(0, 10) : null;
  return due === prepared.date;
}

function tasksFailure(result, fallback) {
  const callFailure = callFailed(result);
  if (callFailure) {
    return { ok: false, state: "disconnected", error: "Connect Google before saving this task." };
  }
  if (result.network) {
    return { ok: false, error: "QuickCalAI could not reach Google Tasks. Check your connection and try again." };
  }
  const detail = result.body && result.body.error ? result.body.error : {};
  const reasons = (Array.isArray(detail.errors) ? detail.errors : []).map((item) => item && item.reason).join(" ");
  const message = [typeof detail.message === "string" ? detail.message : "", reasons, detail.status || ""].join(" ");
  if (/accessNotConfigured|SERVICE_DISABLED|has not been used|is disabled/i.test(message)) {
    return { ok: false, error: TASKS_DISABLED_MESSAGE };
  }
  if (result.status === 403) {
    return { ok: false, state: "needsTasksScope", error: TASKS_SCOPE_MESSAGE };
  }
  return { ok: false, error: fallback + " (" + (result.status || "unknown") + ")." };
}

async function loadTaskReceipt() {
  const stored = await chrome.storage.local.get(TASK_RECEIPT_KEY);
  const receipt = stored[TASK_RECEIPT_KEY];
  if (!receipt || typeof receipt !== "object" || typeof receipt.fingerprint !== "string") return null;
  if (receipt.phase !== "pending" && receipt.phase !== "created") return null;
  return receipt;
}

async function saveTaskReceipt(receipt) {
  await chrome.storage.local.set({ [TASK_RECEIPT_KEY]: receipt });
}

// Google Tasks has no client-chosen ids, so an uncertain insert is resolved by
// looking for the exact task written since the attempt began.
async function recoverTask(prepared, startedAt) {
  const listed = await calendarCall(taskRecoveryUrl(startedAt), { method: "GET" });
  if (!listed.ok || !listed.body || !Array.isArray(listed.body.items)) return null;
  return listed.body.items.find((item) => confirmedTask(prepared, item)) || null;
}

async function saveWidgetTaskOnce(prepared) {
  const denied = missingCalendarGrant(await refreshStatus(), "Connect Google before saving this task.");
  if (denied) return denied;

  const receipt = await loadTaskReceipt();
  if (receipt && receipt.fingerprint === prepared.fingerprint) {
    if (receipt.phase === "created" && receipt.id) {
      const existing = await calendarCall(taskReadUrl(receipt.id), { method: "GET" });
      if (existing.ok && confirmedTask(prepared, existing.body)) return publicSavedTask(prepared, existing.body);
      if (!existing.ok && !existing.notFound && existing.status !== 410) {
        return tasksFailure(existing, "Google Tasks could not be checked");
      }
    } else if (receipt.phase === "pending" && receipt.startedAt) {
      const found = await recoverTask(prepared, receipt.startedAt);
      if (found) {
        await saveTaskReceipt({ fingerprint: prepared.fingerprint, phase: "created", id: found.id }).catch(() => {});
        return publicSavedTask(prepared, found);
      }
    }
  }

  const startedAt = new Date(Date.now() - 60000).toISOString();
  try {
    await saveTaskReceipt({ fingerprint: prepared.fingerprint, phase: "pending", startedAt: startedAt });
  } catch (error) {
    return { ok: false, error: "QuickCalAI could not save this task request." };
  }
  const body = { title: prepared.title, notes: prepared.notes };
  if (prepared.due) body.due = prepared.due;
  const created = await calendarCall(taskInsertUrl(), { method: "POST", body: JSON.stringify(body) });
  if (created.ok && confirmedTask(prepared, created.body)) {
    await saveTaskReceipt({ fingerprint: prepared.fingerprint, phase: "created", id: created.body.id }).catch(() => {});
    return publicSavedTask(prepared, created.body);
  }
  if (created.ok) return { ok: false, error: "Google Tasks did not confirm the saved task." };
  const uncertain = created.network || (created.status && created.status >= 500);
  if (!uncertain) return tasksFailure(created, "Google Tasks could not save this task");
  const found = await recoverTask(prepared, startedAt);
  if (found) {
    await saveTaskReceipt({ fingerprint: prepared.fingerprint, phase: "created", id: found.id }).catch(() => {});
    return publicSavedTask(prepared, found);
  }
  return {
    ok: false,
    error: "QuickCalAI could not confirm whether this task was saved. Check Google Tasks, then try again.",
  };
}

function saveWidgetTask(event) {
  const prepared = prepareTask(event);
  if (!prepared) {
    return Promise.resolve({ ok: false, error: "This task needs a title before it can be saved." });
  }
  const key = "task:" + prepared.fingerprint;
  const current = widgetSaves.get(key);
  if (current) return current;
  const promise = saveWidgetTaskOnce(prepared).finally(() => {
    widgetSaves.delete(key);
  });
  widgetSaves.set(key, promise);
  return promise;
}

// Serialize invitations across tabs so adding guests never overwrites another send.
let invitationQueue = Promise.resolve();
function inviteWidgetGuest(message) {
  const run = invitationQueue.then(() => inviteWidgetGuestOnce(message));
  invitationQueue = run.catch(() => {});
  return run;
}

async function inviteWidgetGuestOnce(message) {
  const email = typeof message.email === "string" ? message.email.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (await isSuppressed()) return { ok: false, error: "Connect Google Calendar before inviting people." };
  const stored = await loadDraftEvent();
  if (!stored || stored.phase !== "created" || !message.eventId || stored.id !== message.eventId ||
      (message.calendarId && message.calendarId !== (stored.calendarId || "primary"))) {
    return { ok: false, error: "This event is no longer active. Open the saved event and try again." };
  }
  const status = await refreshStatus();
  const denied = missingCalendarGrant(status, "Connect Google Calendar before inviting people.");
  if (denied) return denied;
  if (!status.quickcalReady) return { ok: false, error: status.message || "QuickCalAI could not verify this account. Try again." };
  const url = CALENDAR_EVENTS_URL + "/" + encodeURIComponent(stored.id);
  const read = await calendarCall(url, { method: "GET" });
  const readFailure = callFailed(read);
  if (readFailure) return { ok: false, error: readFailure.message };
  if (read.notFound || read.status === 410 || (read.body && read.body.status === "cancelled")) {
    return { ok: false, error: "This event was deleted from Google Calendar." };
  }
  if (!read.ok || !read.body || read.body.id !== stored.id) {
    return { ok: false, error: "Google Calendar could not check this event. Try again." };
  }
  const event = read.body;
  if (event.attendeesOmitted) return { ok: false, error: "Google Calendar did not return the full guest list. Try again." };
  const attendees = Array.isArray(event.attendees) ? event.attendees : [];
  if (attendees.some((guest) => String(guest.email || "").toLowerCase() === email)) {
    return { ok: true, email, alreadyInvited: true };
  }
  // Recheck after network reads: never apply a send to a replacement draft.
  const active = await loadDraftEvent();
  if (!active || active.id !== stored.id || await isSuppressed()) {
    return { ok: false, error: "The active event changed. Open it and try again." };
  }
  const result = await calendarCall(url + "?sendUpdates=all", {
    method: "PATCH",
    headers: event.etag ? { "If-Match": event.etag } : {},
    body: JSON.stringify({ attendees: attendees.concat({ email }) }),
  });
  const failure = callFailed(result);
  if (failure) return { ok: false, error: failure.message };
  if (result.network) {
    return { ok: false, error: "Google Calendar did not confirm the invitation. Check the event before trying again." };
  }
  if (result.status === 412) return { ok: false, error: "The guest list changed. Try again to use the latest version." };
  if (result.status === 403) return { ok: false, error: "Google Calendar did not allow this invitation. Check that you can invite guests to this event." };
  const confirmed = result.body;
  if (!result.ok || !confirmed || confirmed.id !== stored.id || confirmed.status === "cancelled" ||
      !Array.isArray(confirmed.attendees) || !confirmed.attendees.some((guest) => String(guest.email || "").toLowerCase() === email)) {
    return { ok: false, error: "Google Calendar did not confirm the invitation. Check the event before trying again." };
  }
  return { ok: true, email };
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
  const needsConflictScopes = !!(status && status.needsConflictScopes);
  return {
    ok: true,
    connected: googleConnected,
    quickcalReady: !!(status && status.quickcalReady === true) && !needsConflictScopes,
    message: status && typeof status.message === "string" ? status.message : "",
    needsReconnect: !!(status && (status.needsReconnect || needsConflictScopes)),
    needsConflictScopes: needsConflictScopes,
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
      const compatible = !!(
        body &&
        body.ok === true &&
        body.quickcalApiVersion === self.QuickCalLocalParse.API_VERSION &&
        Array.isArray(body.capabilities) &&
        body.capabilities.includes("event-notifications") &&
        body.capabilities.includes("calendar-operations") &&
        body.capabilities.includes("availability-search") &&
        body.capabilities.includes("multi-event-batch") &&
        body.capabilities.includes("tasks") &&
        body.capabilities.includes("document-analysis")
      );
      if (body && body.ok === true && !compatible) {
        const release = typeof body.quickcalRelease === "string" ? " (running " + body.quickcalRelease + ")" : "";
        return {
          ok: false,
          incompatible: true,
          error: "QuickCalAI's hosted parser is out of date" + release + ". Deploy the current backend, then reload the extension.",
          quickcalApiVersion: body.quickcalApiVersion,
          quickcalRelease: body.quickcalRelease,
        };
      }
      return {
        ok: compatible,
        quickcalApiVersion: body && body.quickcalApiVersion,
        quickcalRelease: body && body.quickcalRelease,
      };
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
    needsTasksScope: !!(result && result.needsTasksScope === true),
  };
  if (result && result.testEvent && typeof result.testEvent === "object") {
    safe.testEvent = publicTestEvent(result.testEvent);
  }
  return safe;
}

async function showWidgetOnTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || tab.id == null || !canInject(tab.url)) {
    reportBlocked();
    return false;
  }
  if (!sessionStore()) {
    console.info("QuickCalAI: chrome.storage.session is unavailable, so QuickCal cannot share one conversation across tabs.");
    return false;
  }
  const state = await mutateWidgetSession(!!tab.incognito, (current) => {
    return self.QuickCalSession.claim(self.QuickCalSession.show(current), tab.id).state;
  });
  const delivered = await deliverSession(tab.id, state);
  if (delivered === "blocked" || delivered === "failed") return false;
  await focusSharedWidget(tab.id);
  return true;
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (chrome.tabs && chrome.tabs.onUpdated) {
        chrome.tabs.onUpdated.removeListener(onUpdated);
      }
      try {
        clearTimeout(timer);
      } catch (error) {
        // Some test sandboxes omit timers; the wait still settles.
      }
      resolve(ok);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info && info.status === "complete") finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (chrome.tabs && chrome.tabs.onUpdated) {
      chrome.tabs.onUpdated.addListener(onUpdated);
    }
    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === "complete") finish(true);
      })
      .catch(() => {});
  });
}

async function openTryPage() {
  const status = await refreshStatus();
  if (!status || status.state !== "ready" || status.needsConflictScopes) {
    return status && status.state
      ? status
      : failed("Connect Google Calendar before trying QuickCalAI.");
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ url: TRY_PAGE_URL, active: true });
  } catch (error) {
    return failed("QuickCalAI could not open a practice page.");
  }
  if (!tab || tab.id == null) {
    return failed("QuickCalAI could not open a practice page.");
  }
  await waitForTabComplete(tab.id, TRY_PAGE_WAIT_MS);
  const shown = await showWidgetOnTab(tab.id);
  if (!shown) {
    return failed(
      "QuickCalAI opened the practice page, but could not show the input bar. Click the QuickCalAI toolbar icon on that page."
    );
  }
  return {
    state: "ready",
    message: "",
    googleConnected: true,
    quickcalReady: true,
  };
}

function performAuth(message) {
  const action = message && message.action;
  if (action === "status") return refreshStatus();
  if (action === "connect") return connectCalendar();
  if (action === "disconnect") return disconnectCalendar();
  if (action === "create-test-event") return createTestEvent(message.event);
  if (action === "try") return openTryPage();
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
    reminders: record.reminders || { useDefault: false, overrides: [] },
  };
}

const LOOKUP_LIST_FIELDS = "items(id,summary,status,htmlLink,recurringEventId,start,end,attendees(email,displayName)),nextPageToken";
const LOOKUP_ITEM_FIELDS = "id,summary,status,htmlLink,recurringEventId,start,end,attendees(email,displayName)";
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const CONFLICT_EVENT_FIELDS =
  "items(id,iCalUID,summary,status,transparency,htmlLink,recurringEventId,start,end,attendees(self,responseStatus)),nextPageToken";
const CONFLICT_LIST_FIELDS = "items(id,summary,primary,accessRole,selected),nextPageToken";
const CONFLICT_SCOPE_HINT = /insufficientPermissions|accessNotConfigured|Required "|PERMISSION_DENIED|Daily Limit/i;

function lookupListUrl(window, pageToken) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    maxResults: "20",
    eventTypes: "default",
    fields: LOOKUP_LIST_FIELDS,
  });
  if (pageToken) params.set("pageToken", pageToken);
  return CALENDAR_EVENTS_URL + "?" + params.toString();
}

function lookupItemUrl(id, method) {
  const fields = method === "DELETE" ? "" : LOOKUP_ITEM_FIELDS;
  const suffix = method === "PATCH" ? "?sendUpdates=none&fields=" + fields : method === "GET" ? "?fields=" + fields : "?sendUpdates=none";
  return CALENDAR_EVENTS_URL + "/" + encodeURIComponent(id) + suffix;
}

async function listLookupEvents(date, timeZone) {
  const window = self.QuickCalLookup.dayWindow(date, timeZone);
  if (!window) return { ok: false, error: "QuickCal could not determine that date." };
  const items = [];
  let pageToken = "";
  for (let page = 0; page < 2; page += 1) {
    const listed = await calendarCall(lookupListUrl(window, pageToken), { method: "GET" });
    if (listed.authError) return { ok: false, state: "disconnected", error: "Connect Google Calendar before searching." };
    if (listed.network) return { ok: false, error: "QuickCalAI could not reach Google Calendar. Check your connection and try again." };
    if (!listed.ok) return { ok: false, error: "Google Calendar could not be searched (" + (listed.status || "unknown") + ")." };
    const batch = listed.body && Array.isArray(listed.body.items) ? listed.body.items : [];
    batch.forEach((item) => items.push(item));
    pageToken = listed.body && listed.body.nextPageToken || "";
    if (!pageToken) break;
  }
  return { ok: true, items: items };
}

function lookupState(action, kind, query, timeZone, candidates, prompt, extra) {
  const listed = (candidates || []).map((item, index) => Object.assign({}, item, {
    ref: item.ref || ("c" + (index + 1)),
  }));
  return Object.assign({
    kind: kind,
    action: action,
    scope: query.scope || "occurrence",
    query: query,
    timeZone: timeZone,
    candidates: listed,
    prompt: prompt,
    lines: listed.map((item, index) => (index + 1) + ". " + item.summary + ", " + item.dateText + ", " + item.timeText),
    awaiting: "",
  }, extra || {});
}

function operationContext(lookup) {
  if (!lookup || !lookup.query) return null;
  const query = lookup.query;
  const availability = lookup.action === "availability";
  return {
    intent: lookup.action || "find",
    target: query.target || query.person || null,
    searchDate: availability ? query.date || null : query.explicitDate ? query.date || null : null,
    searchTime: query.explicitTime ? query.startTime || null : null,
    destinationDate: query.newDate || null,
    destinationTime: query.newStartTime || null,
    destinationEndTime: query.newEndTime || null,
    scope: query.scope || "occurrence",
    selection: [],
    durationMinutes: query.durationMinutes == null ? null : query.durationMinutes,
    windowStart: query.windowStart || null,
    windowEnd: query.windowEnd || null,
    preference: query.preference || null,
    searchEndDate: query.searchEndDate || null,
    readOnly: query.readOnly == null ? null : !!query.readOnly,
    missing: lookup.awaiting || null,
    prompt: lookup.prompt || null,
    candidates: (lookup.candidates || []).map((item) => ({
      ref: item.ref,
      label: availability
        ? item.summary || item.dateText + ", " + item.timeText
        : item.summary + ", " + item.dateText + ", " + item.timeText,
    })),
  };
}

function bindSelection(selection, candidates) {
  if (!selection || !selection.length) return { selected: null };
  if (!candidates || !candidates.length) return { invalid: true };
  if (selection.length === 1 && selection[0] === "all") return { selected: candidates.slice() };
  const selected = [];
  for (let index = 0; index < selection.length; index += 1) {
    let found = null;
    for (let item = 0; item < candidates.length; item += 1) {
      if (candidates[item].ref === selection[index]) found = candidates[item];
    }
    if (!found) return { invalid: true };
    selected.push(found);
  }
  return { selected: selected };
}

function movedRecord(candidate, plan, body) {
  const link = safeCalendarLink(body && body.htmlLink) || safeCalendarLink(candidate.htmlLink);
  const previous = candidate.timeText;
  const next = self.QuickCalSchedule.formatTimeRange(plan.startTime, plan.endTime);
  return {
    ok: true,
    summary: candidate.summary,
    dateText: self.QuickCalSchedule.formatCompactDate(plan.date),
    timeText: next,
    timeZone: candidate.timeZone || "",
    htmlLink: link,
    id: candidate.id,
    calendarId: candidate.calendarId || "primary",
    title: candidate.summary,
    date: plan.date,
    endDate: plan.endDate,
    startTime: plan.startTime,
    endTime: plan.endTime,
    startDateTime: plan.startDateTime || "",
    endDateTime: plan.endDateTime || "",
    location: null,
    changeText: "Moved from " + previous + " to " + next,
    recurrence: null,
    recurrenceText: candidate.recurringEventId ? "One occurrence" : "",
    seriesEndText: "",
    remindersText: "",
  };
}

function conflictCheckId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "conflict-" + String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000));
}

function calendarListUrl(pageToken) {
  const params = new URLSearchParams({
    maxResults: "250",
    fields: CONFLICT_LIST_FIELDS,
  });
  if (pageToken) params.set("pageToken", pageToken);
  return CALENDAR_LIST_URL + "?" + params.toString();
}

function conflictEventsUrl(calendarId, window, pageToken) {
  const params = new URLSearchParams({
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    maxResults: "250",
    eventTypes: "default",
    fields: CONFLICT_EVENT_FIELDS,
  });
  if (pageToken) params.set("pageToken", pageToken);
  return (
    "https://www.googleapis.com/calendar/v3/calendars/" +
    encodeURIComponent(calendarId) +
    "/events?" +
    params.toString()
  );
}

function scopeDenied(result) {
  if (!result || result.ok) return false;
  if (result.status === 401 || result.unauthorized) return false;
  if (result.status === 403) return true;
  const message =
    result.body && result.body.error && typeof result.body.error.message === "string"
      ? result.body.error.message
      : "";
  return CONFLICT_SCOPE_HINT.test(message);
}

async function listConflictCalendars() {
  const calendars = [];
  let pageToken = "";
  for (let page = 0; page < 8; page += 1) {
    const listed = await calendarCall(calendarListUrl(pageToken), { method: "GET" });
    if (listed.authError || listed.unauthorized) {
      return { ok: false, needsScopes: false, disconnected: true, error: "Connect Google Calendar before checking conflicts." };
    }
    if (listed.network) {
      return { ok: false, needsScopes: false, error: "network" };
    }
    if (scopeDenied(listed)) {
      return { ok: false, needsScopes: true, error: "scopes" };
    }
    if (!listed.ok) {
      return { ok: false, needsScopes: false, error: "calendarList:" + (listed.status || "unknown") };
    }
    const batch = listed.body && Array.isArray(listed.body.items) ? listed.body.items : [];
    batch.forEach((item) => {
      if (!item || !item.id) return;
      calendars.push({
        id: item.id,
        summary: item.summary || item.id,
        primary: !!item.primary,
        accessRole: item.accessRole || "",
      });
    });
    pageToken = listed.body && listed.body.nextPageToken || "";
    if (!pageToken) break;
    if (page === 7 && pageToken) {
      return { ok: true, calendars: calendars, truncated: true };
    }
  }
  if (!calendars.length) {
    calendars.push({ id: "primary", summary: "Primary", primary: true, accessRole: "owner" });
  }
  return { ok: true, calendars: calendars, truncated: false };
}

async function listConflictEvents(calendar, window) {
  const items = [];
  let pageToken = "";
  for (let page = 0; page < 8; page += 1) {
    const listed = await calendarCall(conflictEventsUrl(calendar.id, window, pageToken), { method: "GET" });
    if (listed.authError || listed.unauthorized) return { ok: false, disconnected: true };
    if (listed.network) return { ok: false, network: true };
    if (listed.status === 403 || listed.status === 404) return { ok: false, inaccessible: true };
    if (!listed.ok) return { ok: false, status: listed.status || 0 };
    const batch = listed.body && Array.isArray(listed.body.items) ? listed.body.items : [];
    batch.forEach((item) => items.push(item));
    pageToken = listed.body && listed.body.nextPageToken || "";
    if (!pageToken) break;
    if (page === 7 && pageToken) return { ok: true, items: items, truncated: true };
  }
  return { ok: true, items: items, truncated: false };
}

async function freeBusyCalendars(calendars, window, timeZone) {
  const body = {
    timeMin: window.timeMin,
    timeMax: window.timeMax,
    timeZone: timeZone || "UTC",
    items: calendars.map((calendar) => ({ id: calendar.id })),
  };
  const result = await calendarCall(FREEBUSY_URL, { method: "POST", body: JSON.stringify(body) });
  if (result.authError || result.unauthorized) return { ok: false, disconnected: true };
  if (result.network) return { ok: false, network: true };
  if (scopeDenied(result)) return { ok: false, needsScopes: true };
  if (!result.ok || !result.body || !result.body.calendars) {
    return { ok: false, status: result.status || 0 };
  }
  return { ok: true, calendars: result.body.calendars };
}

async function evaluateScheduleConflicts(saved) {
  const api = self.QuickCalConflicts;
  if (!api || !saved) {
    return api
      ? api.buildNotice({
          saved: saved,
          incompleteReasons: ["Conflict checking is unavailable."],
        })
      : null;
  }
  const window = api.checkWindow(saved);
  if (!window) {
    return api.buildNotice({
      saved: saved,
      incompleteReasons: ["QuickCal could not determine the saved event time."],
    });
  }
  const listed = await listConflictCalendars();
  if (listed.disconnected) {
    return api.buildNotice({
      saved: saved,
      window: window,
      incompleteReasons: [listed.error || "Google Calendar sign-in is required."],
    });
  }
  if (listed.needsScopes) {
    return api.buildNotice({ saved: saved, window: window, needsScopes: true });
  }
  if (!listed.ok) {
    return api.buildNotice({
      saved: saved,
      window: window,
      incompleteReasons: [
        listed.error === "network"
          ? "QuickCalAI could not reach Google Calendar while checking conflicts."
          : "QuickCalAI could not list calendars for conflict checking.",
      ],
    });
  }

  const incompleteReasons = [];
  if (listed.truncated) incompleteReasons.push("Not every calendar could be listed.");
  const entries = [];
  const ourIntervals = [];
  const savedCalendar = saved.calendarId || "primary";
  const freeBusyFallback = [];

  for (let index = 0; index < listed.calendars.length; index += 1) {
    const calendar = listed.calendars[index];
    const events = await listConflictEvents(calendar, window);
    if (events.disconnected) {
      incompleteReasons.push("Google Calendar sign-in expired while checking conflicts.");
      break;
    }
    if (events.needsScopes) {
      return api.buildNotice({ saved: saved, window: window, needsScopes: true });
    }
    if (events.network) {
      incompleteReasons.push("Could not reach " + (calendar.summary || calendar.id) + ".");
      continue;
    }
    if (events.inaccessible || !events.ok) {
      freeBusyFallback.push(calendar);
      continue;
    }
    if (events.truncated) {
      incompleteReasons.push("Not every event on " + (calendar.summary || calendar.id) + " could be checked.");
    }
    events.items.forEach((item) => {
      if (!api.isBusyCandidate(item)) return;
      if (api.isSavedEvent(item, saved, calendar.id, calendar.primary)) {
        const interval = api.intervalFromGoogleTimes(item.start, item.end);
        if (interval && (calendar.id === savedCalendar || calendar.primary)) {
          ourIntervals.push(interval);
        }
        return;
      }
      const entry = api.entryFromEvent(item, calendar);
      if (entry) entries.push(entry);
    });
  }

  if (!ourIntervals.length) {
    const own = api.intervalFromSaved(saved);
    if (own) ourIntervals.push(own);
  }

  if (freeBusyFallback.length) {
    const busy = await freeBusyCalendars(freeBusyFallback, window, saved.timeZone);
    if (busy.needsScopes) {
      return api.buildNotice({ saved: saved, window: window, needsScopes: true });
    }
    if (busy.ok && busy.calendars) {
      freeBusyFallback.forEach((calendar) => {
        const block = busy.calendars[calendar.id];
        if (!block) {
          incompleteReasons.push(
            "Could not check " + (calendar.summary || calendar.id) + "."
          );
          return;
        }
        if (Array.isArray(block.errors) && block.errors.length) {
          incompleteReasons.push(
            "Google does not allow conflict checks on " + (calendar.summary || calendar.id) + "."
          );
          return;
        }
        (block.busy || []).forEach((slot) => {
          const entry = api.entryFromBusy(slot, calendar);
          if (!entry) return;
          let selfSlot = false;
          for (let i = 0; i < ourIntervals.length; i += 1) {
            const mine = ourIntervals[i];
            if (mine.startMs === entry.startMs && mine.endMs === entry.endMs) selfSlot = true;
          }
          if (!selfSlot) entries.push(entry);
        });
      });
    } else {
      freeBusyFallback.forEach((calendar) => {
        incompleteReasons.push(
          "Could not check " + (calendar.summary || calendar.id) + "."
        );
      });
    }
  }

  return api.buildNotice({
    checkId: "",
    saved: saved,
    window: window,
    timeZone: saved.timeZone,
    ourIntervals: ourIntervals,
    entries: entries,
    calendarCount: listed.calendars.length,
    incompleteReasons: incompleteReasons,
  });
}

// An overlap warning is shown for a few seconds, then removed from the shared
// session so it cannot linger into later requests.
const CONFLICT_NOTICE_MS = 5000;
const expiredConflictChecks = new Set();

function expireConflictNotice(incognito, checkId) {
  expiredConflictChecks.add(checkId);
  if (expiredConflictChecks.size > 50) expiredConflictChecks.delete(expiredConflictChecks.values().next().value);
  return mutateWidgetSession(incognito, (latest) => {
    const current = latest.conflictNotice;
    if (!current || current.checkId !== checkId) return latest;
    return Object.assign({}, latest, {
      conflictNotice: null,
      statusText: latest.statusText === current.statusText ? "" : latest.statusText,
      revision: latest.revision + 1,
    });
  });
}

async function applyConflictNotice(incognito, checkId, saved, notice) {
  const api = self.QuickCalConflicts;
  if (!api || !notice) return null;
  if (expiredConflictChecks.has(checkId)) return null;
  notice.checkId = checkId;
  notice.savedEventId = saved && saved.id ? saved.id : notice.savedEventId || "";
  let shown = null;
  const session = await mutateWidgetSession(incognito, (latest) => {
    if (!api.noticeStillCurrent(latest, notice)) return latest;
    if (latest.mode === "reviewing" || latest.mode === "batch-results") {
      if (!latest.batch || !Array.isArray(latest.batch.drafts)) return latest;
      const drafts = latest.batch.drafts.map((draft) => {
        if (!draft || draft.saveStatus !== "saved") return draft;
        const matchId = draft.calendarEventId || (draft.savedRecord && draft.savedRecord.id) || "";
        if (!matchId || matchId !== notice.savedEventId) return draft;
        if (draft.conflictNotice && draft.conflictNotice.checkId && draft.conflictNotice.checkId !== checkId) {
          return draft;
        }
        return Object.assign({}, draft, { conflictNotice: notice });
      });
      // The top-level warning names one current overlap; one that already
      // timed out is not brought back by a later draft's result.
      const firstNotice = drafts.map((draft) => draft.conflictNotice).find((item) => item && item.status && item.status !== "clear" && item.status !== "checking" && !expiredConflictChecks.has(item.checkId));
      shown = firstNotice || notice;
      return Object.assign({}, latest, {
        batch: Object.assign({}, latest.batch, { drafts: drafts }),
        conflictNotice: firstNotice || notice,
        statusText: firstNotice && firstNotice.statusText ? firstNotice.statusText : (notice.status === "clear" && !notice.horizonText ? "" : notice.statusText),
        statusError: false,
        revision: latest.revision + 1,
      });
    }
    if (latest.conflictNotice && latest.conflictNotice.checkId && latest.conflictNotice.checkId !== checkId) {
      return latest;
    }
    shown = notice;
    const statusText = notice.status === "clear" && !notice.horizonText ? "" : notice.statusText;
    return Object.assign({}, latest, {
      conflictNotice: notice,
      statusText: statusText,
      statusError: false,
      revision: latest.revision + 1,
    });
  });
  if (shown && shown.status === "conflicts" && typeof setTimeout === "function") {
    const expiring = shown.checkId;
    setTimeout(() => {
      expireConflictNotice(incognito, expiring).catch(() => {});
    }, CONFLICT_NOTICE_MS);
  }
  return session;
}

function availabilitySearchId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "avail-" + String(Date.now()) + "-" + String(Math.floor(Math.random() * 1000));
}

function availabilityWindowBounds(query, timeZone) {
  const api = self.QuickCalAvailability;
  const schedule = self.QuickCalSchedule;
  if (!api || !schedule || !query || !query.date) return null;
  const endDate = query.searchEndDate || query.date;
  const window = api.resolveWindow({
    windowStart: query.windowStart || undefined,
    windowEnd: query.windowEnd || undefined,
    preference: query.preference || undefined,
  });
  if (!window.ok) return null;
  const start = schedule.resolveLocal(query.date, window.start, timeZone);
  const end = schedule.resolveLocal(endDate, window.end, timeZone);
  if (!start.ok || !end.ok || end.epoch <= start.epoch) return null;
  return {
    timeMin: new Date(start.epoch).toISOString(),
    timeMax: new Date(end.epoch).toISOString(),
    startMs: start.epoch,
    endMs: end.epoch,
  };
}

async function gatherBusyIntervals(window, timeZone) {
  const api = self.QuickCalConflicts;
  if (!api || !window) {
    return { ok: false, error: "Availability checking is unavailable." };
  }
  const listed = await listConflictCalendars();
  if (listed.disconnected) {
    return { ok: false, disconnected: true, error: listed.error || "Connect Google Calendar before searching availability." };
  }
  if (listed.needsScopes) {
    return { ok: false, needsScopes: true, error: "Reconnect Google Calendar to allow QuickCalAI to check your calendars." };
  }
  if (!listed.ok) {
    return {
      ok: false,
      error:
        listed.error === "network"
          ? "QuickCalAI could not reach Google Calendar while checking availability."
          : "QuickCalAI could not list calendars for availability checking.",
    };
  }

  const incompleteReasons = [];
  if (listed.truncated) incompleteReasons.push("Not every calendar could be listed.");
  const busyIntervals = [];
  const freeBusyFallback = [];

  for (let index = 0; index < listed.calendars.length; index += 1) {
    const calendar = listed.calendars[index];
    const events = await listConflictEvents(calendar, window);
    if (events.disconnected) {
      return { ok: false, disconnected: true, error: "Google Calendar sign-in expired while checking availability." };
    }
    if (events.network) {
      incompleteReasons.push("Could not reach " + (calendar.summary || calendar.id) + ".");
      continue;
    }
    if (events.inaccessible || !events.ok) {
      freeBusyFallback.push(calendar);
      continue;
    }
    if (events.truncated) {
      incompleteReasons.push("Not every event on " + (calendar.summary || calendar.id) + " could be checked.");
    }
    events.items.forEach((item) => {
      if (!api.isBusyCandidate(item)) return;
      const interval = api.intervalFromGoogleTimes(item.start, item.end);
      if (interval) busyIntervals.push(interval);
    });
  }

  if (freeBusyFallback.length) {
    const busy = await freeBusyCalendars(freeBusyFallback, window, timeZone);
    if (busy.needsScopes) {
      return { ok: false, needsScopes: true, error: "Reconnect Google Calendar to allow QuickCalAI to check your calendars." };
    }
    if (busy.ok && busy.calendars) {
      freeBusyFallback.forEach((calendar) => {
        const block = busy.calendars[calendar.id];
        if (!block) {
          incompleteReasons.push("Could not check " + (calendar.summary || calendar.id) + ".");
          return;
        }
        if (Array.isArray(block.errors) && block.errors.length) {
          incompleteReasons.push(
            "Google does not allow availability checks on " + (calendar.summary || calendar.id) + "."
          );
          return;
        }
        (block.busy || []).forEach((slot) => {
          const entry = api.entryFromBusy(slot, calendar);
          if (entry) busyIntervals.push({ startMs: entry.startMs, endMs: entry.endMs });
        });
      });
    } else {
      freeBusyFallback.forEach((calendar) => {
        incompleteReasons.push("Could not check " + (calendar.summary || calendar.id) + ".");
      });
    }
  }

  return {
    ok: true,
    busyIntervals: self.QuickCalAvailability.mergeBusy(busyIntervals),
    incompleteReasons: incompleteReasons,
    calendarCount: listed.calendars.length,
  };
}

function availabilityMeetingTitle(query, event) {
  if (event && typeof event.title === "string" && event.title.trim()) return event.title.trim();
  if (query && typeof query.title === "string" && query.title.trim()) return query.title.trim();
  const readOnly = query && query.readOnly != null
    ? !!query.readOnly
    : event && event.operation && event.operation.readOnly != null
      ? !!event.operation.readOnly
      : false;
  if (readOnly) return "";
  if (query && query.target) {
    const target = String(query.target).trim();
    if (target) return /^meeting\b/i.test(target) ? target : "Meeting with " + target;
  }
  return "";
}

function presentAvailability(query, zone, search, extra) {
  const api = self.QuickCalAvailability;
  const title = query.title || "";
  const slots = api.slotRefs(search.slots || []);
  const defaults = api.summarizeDefaults(search);
  const lines = api.slotLines(slots.map((slot) => Object.assign({}, slot, {
    summary: title || "Available",
  })), title || "Available");
  const partial = !!(extra && extra.incompleteReasons && extra.incompleteReasons.length);
  const promptParts = [];
  if (!slots.length) {
    promptParts.push("No open " + search.durationMinutes + "-minute slots fit that window (" + defaults + ").");
    promptParts.push("Try another day, a shorter duration, or a different time window.");
  } else if (title) {
    promptParts.push("Open times for " + title + " (" + defaults + "). Reply with a number to schedule.");
  } else {
    promptParts.push("Open times (" + defaults + ").");
    if (!query.readOnly) promptParts.push("Reply with a number to schedule, or name the event.");
  }
  if (partial) {
    promptParts.push("Partial check: " + extra.incompleteReasons.join(" "));
  }
  return lookupState(
    "availability",
    "choose",
    Object.assign({}, query, {
      date: search.searchDate,
      searchEndDate: search.searchEndDate,
      durationMinutes: search.durationMinutes,
      windowStart: search.windowStart,
      windowEnd: search.windowEnd,
      preference: search.preference || query.preference || "",
      title: title,
    }),
    zone,
    slots.map((slot) => Object.assign({}, slot, {
      summary: title || "Available",
      dateText: slot.dateText,
      timeText: slot.timeText,
    })),
    promptParts.join(" "),
    Object.assign(
      {
        lines: lines,
        awaiting: slots.length ? "selection" : "refine",
        searchId: (extra && extra.searchId) || "",
        partial: partial,
        incompleteReasons: (extra && extra.incompleteReasons) || [],
        hint: slots.length && title ? "Reply 1, 2, or 3 to schedule that slot." : slots.length ? "Reply with a number, or name what to schedule." : "Change the day, duration, or time window.",
      },
      extra || {}
    )
  );
}

async function runAvailabilitySearch(incognito, operation, query, zone, event) {
  const api = self.QuickCalAvailability;
  const searchId = availabilitySearchId();
  const title = availabilityMeetingTitle(query, event);
  const nextQuery = Object.assign({}, query, {
    title: title,
    date: query.date || (event && event.operation && event.operation.searchDate) || "",
    searchEndDate: query.searchEndDate || (event && event.operation && event.operation.searchEndDate) || "",
    durationMinutes:
      query.durationMinutes != null
        ? query.durationMinutes
        : event && event.operation && event.operation.durationMinutes != null
          ? event.operation.durationMinutes
          : null,
    windowStart: query.windowStart || (event && event.operation && event.operation.windowStart) || "",
    windowEnd: query.windowEnd || (event && event.operation && event.operation.windowEnd) || "",
    preference: query.preference || (event && event.operation && event.operation.preference) || "",
    readOnly:
      query.readOnly != null
        ? query.readOnly
        : event && event.operation && event.operation.readOnly != null
          ? event.operation.readOnly
          : !title,
  });

  if (!nextQuery.date) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      "availability",
      "ask",
      nextQuery,
      zone,
      [],
      (event && event.clarificationQuestions && event.clarificationQuestions[0]) || "What day should I check?",
      { awaiting: "searchDate", searchId: searchId }
    )));
  }

  nextQuery.date = api.advancePastNamedWindow({
    searchDate: nextQuery.date,
    searchEndDate: nextQuery.searchEndDate || nextQuery.date,
    durationMinutes: nextQuery.durationMinutes,
    windowStart: nextQuery.windowStart || undefined,
    windowEnd: nextQuery.windowEnd || undefined,
    preference: nextQuery.preference || undefined,
    timeZone: zone,
    nowMs: Date.now(),
  }) || nextQuery.date;
  if (!nextQuery.searchEndDate || nextQuery.searchEndDate < nextQuery.date) {
    nextQuery.searchEndDate = nextQuery.date;
  }

  const window = availabilityWindowBounds(nextQuery, zone);
  if (!window) {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      statusText: "That availability window is not valid.",
      statusError: true,
    }));
  }

  await mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    return Object.assign({}, latest, {
      statusText: "Checking your calendars\u2026",
      statusError: false,
    });
  });

  const busy = await gatherBusyIntervals(window, zone);
  if (!self.QuickCalSession.operationCurrent(await readWidgetSession(incognito), operation)) {
    return readWidgetSession(incognito);
  }
  if (busy.disconnected) {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      statusText: busy.error || "Connect Google Calendar before searching availability.",
      statusError: true,
    }));
  }
  if (busy.needsScopes) {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      statusText: busy.error,
      statusError: true,
    }));
  }
  if (!busy.ok) {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      statusText: busy.error || "QuickCalAI could not check availability.",
      statusError: true,
    }));
  }

  let afterStartMs = nextQuery.afterStartMs || 0;
  if (nextQuery.preference === "later" && !afterStartMs) {
    afterStartMs = Date.now();
  }
  const searched = api.searchRange({
    searchDate: nextQuery.date,
    searchEndDate: nextQuery.searchEndDate || nextQuery.date,
    durationMinutes: nextQuery.durationMinutes,
    windowStart: nextQuery.windowStart || undefined,
    windowEnd: nextQuery.windowEnd || undefined,
    preference: nextQuery.preference === "later" ? null : nextQuery.preference || undefined,
    timeZone: zone,
    nowMs: Date.now(),
    busyIntervals: busy.busyIntervals,
    afterStartMs: afterStartMs || undefined,
  });
  if (!searched.ok) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      "availability",
      "ask",
      nextQuery,
      zone,
      [],
      searched.error || "What day should I check?",
      { awaiting: searched.missing || "refine", searchId: searchId }
    )));
  }

  const presented = presentAvailability(nextQuery, zone, searched, {
    searchId: searchId,
    incompleteReasons: busy.incompleteReasons || [],
  });
  return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, presented));
}

async function recheckAvailabilitySlot(slot, zone) {
  const schedule = self.QuickCalSchedule;
  const api = self.QuickCalConflicts;
  if (!schedule || !api || !slot) return { ok: false, error: "That slot is no longer available to check." };
  const start = schedule.resolveLocal(slot.date, slot.startTime, zone);
  const end = schedule.resolveLocal(slot.endDate || slot.date, slot.endTime, zone);
  if (!start.ok || !end.ok || end.epoch <= start.epoch) {
    return { ok: false, error: "That slot is not valid." };
  }
  const window = {
    timeMin: new Date(start.epoch).toISOString(),
    timeMax: new Date(end.epoch).toISOString(),
    startMs: start.epoch,
    endMs: end.epoch,
  };
  const busy = await gatherBusyIntervals(window, zone);
  if (!busy.ok) return busy;
  const conflict = busy.busyIntervals.some((item) => api.intervalsOverlap(start.epoch, end.epoch, item.startMs, item.endMs));
  return {
    ok: true,
    free: !conflict,
    incompleteReasons: busy.incompleteReasons || [],
    startMs: start.epoch,
    endMs: end.epoch,
  };
}

async function saveAvailabilitySlot(incognito, operation, query, zone, slot, force) {
  const title = availabilityMeetingTitle(query);
  if (!title) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      "availability",
      "ask",
      query,
      zone,
      [slot],
      "What should I call this event?",
      { awaiting: "title", searchId: query.searchId || "", selectedSlot: slot }
    )));
  }
  if (!force) {
    const check = await recheckAvailabilitySlot(slot, zone);
    if (!check.ok) {
      return settleLookup(incognito, operation, async () => ({
        mode: "input",
        lookup: null,
        statusText: check.error || "QuickCalAI could not recheck that slot.",
        statusError: true,
      }));
    }
    if (!check.free) {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
        "availability",
        "confirm",
        Object.assign({}, query, { title: title }),
        zone,
        [slot],
        "That slot is no longer free. Reply Schedule anyway, or ask for refreshed times.",
        {
          awaiting: "stale",
          selectedSlot: slot,
          hint: "Press Enter to schedule anyway, or ask for new options.",
          forceSchedule: true,
        }
      )));
    }
  }

  const event = {
    title: title,
    date: slot.date,
    endDate: slot.endDate || slot.date,
    startTime: slot.startTime,
    endTime: slot.endTime,
    timeZone: zone,
    location: null,
    recurrence: null,
    reminders: { useDefault: false, overrides: [] },
    remindersText: "",
    recurrenceText: "",
    seriesEndText: "",
    needsClarification: false,
    clarificationQuestions: [],
    durationDefaulted: false,
    intent: "create",
  };

  await mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    return Object.assign({}, latest, {
      mode: "creating",
      event: event,
      draftEvent: event,
      lookup: null,
      statusText: "Creating event\u2026",
      statusError: false,
    });
  });

  const saveResult = await saveWidgetEvent(event);
  const finished = await mutateWidgetSession(incognito, (after) => {
    if (!self.QuickCalSession.operationCurrent(after, operation)) return after;
    if (saveResult && saveResult.ok === true && saveResult.htmlLink) {
      const checking = self.QuickCalConflicts && saveResult.kind !== "task"
        ? self.QuickCalConflicts.checkingNotice("pending", saveResult)
        : null;
      const saved = self.QuickCalSession.finishOperation(after, operation, {
        mode: "saved",
        savedRecord: saveResult,
        event: event,
        draftEvent: null,
        clarification: null,
        lookup: null,
        input: "",
        statusText: checking ? checking.statusText : "",
        statusError: false,
        conflictNotice: checking,
      });
      return saved.accepted ? saved.state : after;
    }
    const kept = self.QuickCalSession.finishOperation(after, operation, {
      mode: "failed",
      draftEvent: event,
      event: event,
      statusText: saveResult && saveResult.error ? saveResult.error : "QuickCalAI could not save this event.",
      statusError: true,
      conflictNotice: null,
    });
    return kept.accepted ? kept.state : after;
  });
  if (saveResult && saveResult.ok === true && saveResult.htmlLink) {
    return scheduleConflictCheck(incognito, saveResult);
  }
  return finished;
}

async function runAvailabilityFollowUp(incognito, text, operation, pending, event) {
  const zone = (pending && pending.timeZone) || "UTC";
  const query = self.QuickCalLookup.mergeQuery(pending && pending.query, event.operation);
  if (event.title) query.title = event.title;
  if (event.operation && event.operation.readOnly != null) query.readOnly = event.operation.readOnly;
  if (pending && pending.searchId) query.searchId = pending.searchId;
  if (pending && pending.query && pending.query.afterStartMs) query.afterStartMs = pending.query.afterStartMs;

  if (pending && pending.awaiting === "title") {
    const named = (event.title || text || "").trim();
    if (!named) {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, Object.assign({}, pending, {
        prompt: "What should I call this event?",
      })));
    }
    query.title = named;
    query.readOnly = false;
    const slot = pending.selectedSlot || (pending.candidates && pending.candidates[0]);
    if (!slot) return runAvailabilitySearch(incognito, operation, query, zone, event);
    return saveAvailabilitySlot(incognito, operation, query, zone, slot, false);
  }

  if (pending && pending.forceSchedule && pending.kind === "confirm") {
    const slot = pending.selectedSlot || (pending.candidates && pending.candidates[0]);
    if (slot && (!event.operation.selection || !event.operation.selection.length)) {
      return saveAvailabilitySlot(incognito, operation, query, zone, slot, true);
    }
  }

  const bound = bindSelection(event.operation && event.operation.selection, pending && pending.candidates);
  if (bound.invalid) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, Object.assign({}, pending, {
      prompt: "Which time do you mean? Reply with a number.",
      awaiting: "selection",
    })));
  }
  if (bound.selected && bound.selected.length) {
    if (bound.selected.length > 1) {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, Object.assign({}, pending, {
        prompt: "Choose one time. Reply with a single number.",
        awaiting: "selection",
      })));
    }
    const slot = bound.selected[0];
    if (query.readOnly && !query.title) {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
        "availability",
        "ask",
        Object.assign({}, query, { readOnly: false }),
        zone,
        [slot],
        "What should I call this event?",
        { awaiting: "title", selectedSlot: slot, searchId: pending.searchId || "" }
      )));
    }
    return saveAvailabilitySlot(incognito, operation, Object.assign({}, query, { readOnly: false }), zone, slot, false);
  }

  if (query.preference === "later" && pending && pending.candidates && pending.candidates.length) {
    const last = pending.candidates[pending.candidates.length - 1];
    query.afterStartMs = last.startMs || 0;
  } else if (event.operation && event.operation.preference !== "later") {
    query.afterStartMs = 0;
  }

  return runAvailabilitySearch(incognito, operation, query, zone, event);
}

async function scheduleConflictCheck(incognito, saved) {
  const api = self.QuickCalConflicts;
  if (!api || !saved || !saved.htmlLink) return null;
  const checkId = conflictCheckId();
  const checking = api.checkingNotice(checkId, saved);
  await mutateWidgetSession(incognito, (latest) => {
    if (latest.mode === "reviewing" || latest.mode === "batch-results") {
      if (!latest.batch || !Array.isArray(latest.batch.drafts)) return latest;
      const drafts = latest.batch.drafts.map((draft) => {
        if (!draft || draft.saveStatus !== "saved") return draft;
        const matchId = draft.calendarEventId || (draft.savedRecord && draft.savedRecord.id) || "";
        if (!saved.id || matchId !== saved.id) return draft;
        return Object.assign({}, draft, { conflictNotice: checking });
      });
      return Object.assign({}, latest, {
        batch: Object.assign({}, latest.batch, { drafts: drafts }),
        conflictNotice: checking,
        statusText: checking.statusText,
        statusError: false,
        revision: latest.revision + 1,
      });
    }
    if (latest.mode !== "saved" || !latest.savedRecord) return latest;
    if (saved.id && latest.savedRecord.id && saved.id !== latest.savedRecord.id) return latest;
    return Object.assign({}, latest, {
      conflictNotice: checking,
      statusText: checking.statusText,
      statusError: false,
      revision: latest.revision + 1,
    });
  });
  let notice;
  try {
    notice = await evaluateScheduleConflicts(saved);
  } catch (error) {
    notice = api.buildNotice({
      checkId: checkId,
      saved: saved,
      incompleteReasons: ["Conflict checking failed unexpectedly."],
    });
  }
  if (!notice) {
    notice = api.buildNotice({
      checkId: checkId,
      saved: saved,
      incompleteReasons: ["Conflict checking failed unexpectedly."],
    });
  }
  return applyConflictNotice(incognito, checkId, saved, notice);
}

async function readLookupItem(id) {
  return calendarCall(lookupItemUrl(id, "GET"), { method: "GET" });
}

async function applyMove(candidate, query, timeZone, scope) {
  const target = self.QuickCalLookup.targetId(candidate, scope);
  const current = await readLookupItem(target);
  if (current.network) return { network: true, candidate: candidate };
  if (current.notFound || (current.ok && current.body && current.body.status === "cancelled")) {
    return { missing: true, candidate: candidate };
  }
  if (!current.ok || !self.QuickCalLookup.sameFingerprint(candidate, current.body, timeZone)) {
    return { changed: true, candidate: candidate, item: current.ok ? current.body : null };
  }
  const plan = self.QuickCalLookup.planMove(candidate, query, timeZone);
  if (plan.ask || plan.unsupported) return plan;
  const patched = await calendarCall(lookupItemUrl(target, "PATCH"), {
    method: "PATCH",
    body: JSON.stringify({
      start: { dateTime: plan.startDateTime, timeZone: timeZone },
      end: { dateTime: plan.endDateTime, timeZone: timeZone },
    }),
  });
  if (patched.network) {
    const again = await readLookupItem(target);
    if (again.ok && again.body) {
      const seen = self.QuickCalLookup.candidateFrom(again.body, timeZone);
      if (seen.startTime === plan.startTime && seen.date === plan.date) return { ok: true, candidate: candidate, plan: plan, body: again.body };
    }
    return { network: true, candidate: candidate };
  }
  if (!patched.ok || !patched.body) return { failed: true, candidate: candidate };
  const saved = self.QuickCalLookup.candidateFrom(patched.body, timeZone);
  if (saved.startTime !== plan.startTime) return { failed: true, candidate: candidate };
  return { ok: true, candidate: candidate, plan: plan, body: patched.body };
}

async function applyDelete(candidate, timeZone, scope) {
  const target = self.QuickCalLookup.targetId(candidate, scope);
  const current = await readLookupItem(target);
  if (current.network) return { network: true, candidate: candidate };
  if (current.notFound || (current.ok && current.body && current.body.status === "cancelled")) {
    return { ok: true, candidate: candidate, already: true };
  }
  if (!current.ok || !self.QuickCalLookup.sameFingerprint(candidate, current.body, timeZone)) {
    return { changed: true, candidate: candidate, item: current.ok ? current.body : null };
  }
  const removed = await calendarCall(lookupItemUrl(target, "DELETE"), { method: "DELETE" });
  if (removed.network) {
    const again = await readLookupItem(target);
    if (again.notFound || (again.ok && again.body && again.body.status === "cancelled")) {
      return { ok: true, candidate: candidate };
    }
    return { network: true, candidate: candidate };
  }
  if (!removed.ok && removed.status !== 204 && removed.status !== 200) return { failed: true, candidate: candidate };
  return { ok: true, candidate: candidate };
}

async function settleLookup(incognito, operation, producer) {
  const produced = await producer();
  return mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    const finished = self.QuickCalSession.finishOperation(latest, operation, produced);
    return finished.accepted ? finished.state : latest;
  });
}

async function runLookup(incognito, text, timeZone, operation, decision) {
  const query = decision.query;
  const zone = timeZone || "UTC";
  if (decision.intent === "unsupported") {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      input: text,
      statusText: decision.message,
      statusError: false,
    }));
  }
  if (decision.intent === "move" && query.ambiguousTime) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup(
      { lookup: null },
      lookupState("move", "ask", query, zone, [], "Which time should it move to?", { awaiting: "destinationTime" })
    ));
  }
  const listed = await listLookupEvents(query.date, zone);
  if (!self.QuickCalSession) return null;
  if (!listed.ok) {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      input: text,
      statusText: listed.error,
      statusError: true,
    }));
  }
  let matches = self.QuickCalLookup.matchEvents(listed.items, query, zone);
  if (query.scope === "series" && matches.length === 1 && matches[0].recurringEventId) {
    const master = await readLookupItem(matches[0].recurringEventId);
    if (master.ok && master.body && master.body.status !== "cancelled") {
      matches = [self.QuickCalLookup.candidateFrom(master.body, zone)];
    }
  }
  const presented = presentMatches(decision.intent, query, zone, matches);
  if (presented.pendingMove) return performMoves(incognito, operation, query, zone, [presented.pendingMove]);
  return settleLookup(incognito, operation, async () => presented);
}

function presentMatches(intent, query, zone, matches) {
  if (!matches.length) {
    const today = !query.explicitDate;
    return self.QuickCalSession.noteLookup({}, lookupState(
      intent,
      "ask",
      query,
      zone,
      [],
      today ? "I don't see a matching event today. What date should I check?" : "I don't see a matching event on that date. You can give a different date, name, or time.",
      { awaiting: "searchDate" }
    ));
  }
  if (matches.length > 1) {
    return self.QuickCalSession.noteLookup({}, lookupState(
      intent,
      "choose",
      query,
      zone,
      matches,
      "Which event do you mean?"
    ));
  }
  return presentSingle(intent, query, zone, matches[0]);
}

function presentSingle(intent, query, zone, candidate) {
  if (query.scope === "series" && !candidate.recurringEventId) {
    return {
      mode: "input",
      lookup: null,
      statusText: "That event is not a repeating series. No events were changed.",
      statusError: false,
      input: "",
    };
  }
  if (query.scope === "series" || intent === "delete" || intent === "find") {
    const prompt = intent === "delete"
      ? "Delete " + candidate.summary + ", " + candidate.dateText + ", " + candidate.timeText + "?"
      : query.scope === "series"
        ? "Change the entire series for " + candidate.summary + "?"
        : candidate.summary + ", " + candidate.dateText + ", " + candidate.timeText;
    return self.QuickCalSession.noteLookup({}, lookupState(
      intent === "find" ? "find" : intent,
      intent === "find" ? "choose" : "confirm",
      query,
      zone,
      [candidate],
      prompt,
      { hint: intent === "delete" ? "Press Enter to delete." : query.scope === "series" ? "Press Enter to change the series." : "" }
    ));
  }
  return { pendingMove: candidate };
}

async function performMoves(incognito, operation, query, zone, candidates) {
  const moved = [];
  const pending = [];
  const changed = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const result = await applyMove(candidates[i], query, zone, query.scope || "occurrence");
    if (result.ok) moved.push(result);
    else if (result.changed) changed.push(result);
    else pending.push(candidates[i]);
    if (result.ask || result.unsupported) {
      return settleLookup(incognito, operation, async () => ({
        mode: "input",
        lookup: null,
        statusText: result.ask || result.unsupported,
        statusError: false,
        input: "",
      }));
    }
  }
  if (changed.length) {
    const updated = changed.map((result) => self.QuickCalLookup.candidateFrom(result.item, zone));
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      "move",
      "confirm",
      query,
      zone,
      updated,
      "That event changed. Move " + updated[0].summary + ", " + updated[0].dateText + ", " + updated[0].timeText + "?"
    )));
  }
  if (!moved.length) {
    return settleLookup(incognito, operation, async () => ({
      mode: "input",
      lookup: null,
      input: "",
      statusText: pending.length ? "QuickCalAI could not reach Google Calendar. Check your connection and try again." : "QuickCalAI could not move that event.",
      statusError: true,
    }));
  }
  const first = moved[0];
  const record = movedRecord(first.candidate, first.plan, first.body);
  record.timeZone = zone;
  const failures = pending.map((item) => item.summary).join(", ");
  const checking = self.QuickCalConflicts
    ? self.QuickCalConflicts.checkingNotice("pending", record)
    : null;
  const settled = await settleLookup(incognito, operation, async () => ({
    mode: "saved",
    savedRecord: record,
    event: null,
    draftEvent: null,
    clarification: null,
    lookup: pending.length ? lookupState("move", "confirm", query, zone, pending, "Still need to move: " + failures) : null,
    input: "",
    statusText: pending.length
      ? "Moved " + first.candidate.summary + ". Could not move " + failures + "."
      : checking
        ? checking.statusText
        : "",
    statusError: false,
    conflictNotice: pending.length ? null : checking,
  }));
  if (!pending.length) {
    return scheduleConflictCheck(incognito, record);
  }
  return settled;
}

async function performDeletes(incognito, operation, query, zone, candidates) {
  const removed = [];
  const pending = [];
  const changed = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const result = await applyDelete(candidates[i], zone, query.scope || "occurrence");
    if (result.ok) removed.push(result.candidate);
    else if (result.changed && result.item) changed.push(result);
    else pending.push(candidates[i]);
  }
  if (changed.length && !removed.length) {
    const updated = changed.map((result) => self.QuickCalLookup.candidateFrom(result.item, zone));
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      "delete",
      "confirm",
      query,
      zone,
      updated,
      "That event changed. Delete " + updated[0].summary + ", " + updated[0].dateText + ", " + updated[0].timeText + "?",
      { hint: "Press Enter to delete." }
    )));
  }
  const stored = await loadDraftEvent();
  const session = await readWidgetSession(incognito);
  const removedIds = removed.map((item) => item.id);
  const removedLinks = removed.map((item) => safeCalendarLink(item.htmlLink)).filter(Boolean);
  const saved = session.savedRecord;
  const clearSaved = !!(
    (stored && removedIds.indexOf(stored.id) !== -1) ||
    (saved && ((saved.id && removedIds.indexOf(saved.id) !== -1) || (saved.htmlLink && removedLinks.indexOf(saved.htmlLink) !== -1)))
  );
  if (stored && removedIds.indexOf(stored.id) !== -1) {
    try { await clearDraftEvent(); } catch (error) { /* The calendar delete already finished. */ }
  }
  const names = removed.map((item) => item.summary + ", " + item.dateText + ", " + item.timeText);
  const failedNames = pending.map((item) => item.summary);
  let status = names.length ? "Deleted " + names.join("; ") + "." : "QuickCalAI could not delete that event.";
  if (failedNames.length) status += " Could not delete " + failedNames.join(", ") + ".";
  const patch = {
    mode: !clearSaved && saved ? "saved" : "input",
    lookup: pending.length ? lookupState("delete", "confirm", query, zone, pending, "Press Enter to retry the unfinished events.", { hint: "Press Enter to delete." }) : null,
    draftEvent: null,
    clarification: null,
    input: "",
    statusText: status,
    statusError: !names.length,
  };
  if (clearSaved) patch.savedRecord = null;
  return settleLookup(incognito, operation, async () => patch);
}

async function runLookupAnswer(incognito, text, operation, lookup) {
  const zone = lookup.timeZone;
  const query = Object.assign({}, lookup.query);
  if (lookup.awaiting === "date") {
    const date = self.QuickCalLookup.dateIn(text, self.QuickCalLookup.clockFrom(new Date(), zone));
    if (!date) {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, Object.assign({}, lookup, {
        prompt: "What date should I check?",
      })));
    }
    query.date = date;
    query.explicitDate = true;
    const listed = await listLookupEvents(date, zone);
    if (!listed.ok) {
      return settleLookup(incognito, operation, async () => ({
        mode: "input",
        lookup: null,
        input: text,
        statusText: listed.error,
        statusError: true,
      }));
    }
    const presented = presentMatches(lookup.action, query, zone, self.QuickCalLookup.matchEvents(listed.items, query, zone));
    if (presented.pendingMove) return performMoves(incognito, operation, query, zone, [presented.pendingMove]);
    return settleLookup(incognito, operation, async () => presented);
  }
  if (lookup.awaiting === "time") {
    const time = self.QuickCalLookup.destinationTime(text);
    if (!time) {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, Object.assign({}, lookup, {
        prompt: "What time should it move to?",
      })));
    }
    query.newStartTime = time;
    query.ambiguousTime = false;
    if (lookup.candidates && lookup.candidates.length === 1) {
      return performMoves(incognito, operation, query, zone, lookup.candidates);
    }
  }
  const choice = self.QuickCalLookup.choose(text, lookup.candidates || []);
  if (!choice.ids.length) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, Object.assign({}, lookup, {
      prompt: "Which event do you mean? Reply with a number, or say both.",
    })));
  }
  const selected = (lookup.candidates || []).filter((item) => choice.ids.indexOf(item.id) !== -1);
  if (lookup.action === "delete" || query.scope === "series") {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      lookup.action,
      "confirm",
      query,
      zone,
      selected,
      lookup.action === "delete" ? "Delete the selected event" + (selected.length > 1 ? "s" : "") + "?" : "Change the entire series?",
      { hint: lookup.action === "delete" ? "Press Enter to delete." : "Press Enter to change the series." }
    )));
  }
  return performMoves(incognito, operation, query, zone, selected);
}

async function runConfirmedLookup(incognito, operation, lookup) {
  const selected = lookup.candidates || [];
  if (lookup.action === "delete") return performDeletes(incognito, operation, lookup.query, lookup.timeZone, selected);
  return performMoves(incognito, operation, lookup.query, lookup.timeZone, selected);
}

async function runInterpreted(incognito, text, timeZone, operation, pending, event) {
  const zone = timeZone || "UTC";
  const query = self.QuickCalLookup.mergeQuery(pending && pending.query, event.operation);
  const action = event.intent === "clarify" ? (pending && pending.action) || "find" : event.intent;
  if (action === "availability" || (pending && pending.action === "availability" && event.intent === "clarify")) {
    if (event.intent === "clarify" || query.scope === "unsupported") {
      const question = (event.clarificationQuestions && event.clarificationQuestions[0]) || "What day should I check?";
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
        "availability",
        "ask",
        Object.assign({}, query, { title: availabilityMeetingTitle(query, event) }),
        zone,
        pending && pending.candidates || [],
        question,
        { awaiting: (pending && pending.awaiting) || "searchDate", searchId: pending && pending.searchId || "" }
      )));
    }
    if (pending && pending.action === "availability") {
      return runAvailabilityFollowUp(incognito, text, operation, pending, event);
    }
    if (event.title) query.title = event.title;
    return runAvailabilitySearch(incognito, operation, query, zone, event);
  }
  if (event.intent === "clarify" || query.scope === "unsupported") {
    const question = query.scope === "unsupported"
      ? "Changing this and the following occurrences is not supported yet. No events were changed."
      : ((event.clarificationQuestions && event.clarificationQuestions[0]) || "What should I change?");
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      action,
      "ask",
      query,
      zone,
      pending && pending.candidates || [],
      question,
      { awaiting: (pending && pending.awaiting) || "searchDate" }
    )));
  }
  const bound = bindSelection(event.operation && event.operation.selection, pending && pending.candidates);
  if (bound.invalid) {
    return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
      action,
      "choose",
      query,
      zone,
      pending.candidates,
      "Which event do you mean? Reply with a number, or say both.",
      { awaiting: "selection" }
    )));
  }
  if (bound.selected) {
    if (action === "delete" || query.scope === "series") {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
        action,
        "confirm",
        query,
        zone,
        bound.selected,
        action === "delete"
          ? "Delete the selected event" + (bound.selected.length > 1 ? "s" : "") + "?"
          : "Change the entire series?",
        { hint: action === "delete" ? "Press Enter to delete." : "Press Enter to change the series." }
      )));
    }
    if (action === "find") {
      return settleLookup(incognito, operation, async () => presentMatches("find", query, zone, bound.selected));
    }
    return performMoves(incognito, operation, query, zone, bound.selected);
  }
  if (!query.date) {
    if (pending && pending.awaiting === "searchDate") {
      return settleLookup(incognito, operation, async () => self.QuickCalSession.noteLookup({}, lookupState(
        action,
        "ask",
        query,
        zone,
        [],
        "What date should I check?",
        { awaiting: "searchDate" }
      )));
    }
    query.date = self.QuickCalLookup.clockFrom(new Date(), zone).localDate;
    query.explicitDate = false;
  }
  return runLookup(incognito, text, zone, operation, { intent: action, query: query });
}

function cloneBatch(batch) {
  if (!batch) return null;
  return Object.assign({}, batch, {
    drafts: (batch.drafts || []).map((draft) => Object.assign({}, draft, {
      event: Object.assign({}, draft.event),
      savedRecord: draft.savedRecord ? Object.assign({}, draft.savedRecord) : null,
      conflictNotice: draft.conflictNotice ? Object.assign({}, draft.conflictNotice) : null,
    })),
  });
}

function ensureDraftIds(batch) {
  const next = cloneBatch(batch);
  next.drafts.forEach((draft) => {
    if (draft.selected && draft.complete && draft.saveStatus !== "saved" && !draft.calendarEventId) {
      draft.calendarEventId = createEventId();
    }
  });
  return next;
}

async function runBatchExtract(incognito, text, timeZone, operation) {
  const result = await parseForContent({ text: text, timeZone: timeZone || "UTC", batch: true });
  return mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    if (!result || result.ok !== true || !result.batch) {
      const failed = self.QuickCalSession.finishOperation(latest, operation, {
        statusText: result && result.error ? result.error : "QuickCalAI could not read those events.",
        statusError: true,
        input: text,
        batch: null,
        mode: "input",
      });
      return failed.accepted ? failed.state : latest;
    }
    const payload = result.batch;
    if (payload.tooMany) {
      const failed = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "input",
        batch: null,
        input: "",
        statusText: payload.message || "That selection looks like more than 10 events. Highlight a smaller passage and try again.",
        statusError: true,
      });
      return failed.accepted ? failed.state : latest;
    }
    if (!payload.events || !payload.events.length) {
      const failed = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "input",
        batch: null,
        input: "",
        statusText: payload.message || "QuickCalAI did not find any calendar events in that selection.",
        statusError: false,
      });
      return failed.accepted ? failed.state : latest;
    }
    const batch = self.QuickCalBatch.buildBatch(text, payload.events, timeZone || "UTC");
    if (batch.drafts.length === 1) {
      const only = batch.drafts[0];
      if (only.complete) {
        return Object.assign({}, latest, {
          mode: "creating",
          event: only.event,
          draftEvent: only.event,
          draftText: text,
          batch: null,
          lookup: null,
          statusText: "Creating event\u2026",
          statusError: false,
        });
      }
      const noted = self.QuickCalSession.noteClarification(latest, only.event, text);
      const finished = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "clarifying",
        event: noted.event,
        clarification: noted.clarification,
        batch: null,
        savedRecord: null,
        draftEvent: null,
        lookup: null,
        input: "",
        statusText: "",
        statusError: false,
      });
      return finished.accepted ? finished.state : latest;
    }
    const noted = self.QuickCalSession.noteBatch(latest, batch, "");
    const finished = self.QuickCalSession.finishOperation(latest, operation, {
      mode: "reviewing",
      batch: noted.batch,
      clarification: null,
      savedRecord: null,
      draftEvent: null,
      event: null,
      lookup: null,
      input: "",
      statusText: "",
      statusError: false,
      conflictNotice: null,
    });
    return finished.accepted ? finished.state : latest;
  }).then(async (state) => {
    if (!self.QuickCalSession.operationCurrent(state, operation)) return state;
    if (state.mode === "creating" && state.event) {
      const saveResult = await saveWidgetEvent(state.event);
      return mutateWidgetSession(incognito, (after) => {
        if (!self.QuickCalSession.operationCurrent(after, operation)) return after;
        if (saveResult && saveResult.ok === true && saveResult.htmlLink) {
          const checking = self.QuickCalConflicts
            ? self.QuickCalConflicts.checkingNotice("pending", saveResult)
            : null;
          const saved = self.QuickCalSession.finishOperation(after, operation, {
            mode: "saved",
            savedRecord: saveResult,
            event: state.event,
            draftEvent: null,
            clarification: null,
            batch: null,
            lookup: null,
            input: "",
            statusText: checking ? checking.statusText : "",
            statusError: false,
            conflictNotice: checking,
          });
          return saved.accepted ? saved.state : after;
        }
        const kept = self.QuickCalSession.finishOperation(after, operation, {
          mode: "failed",
          draftEvent: state.event,
          event: state.event,
          batch: null,
          statusText: saveResult && saveResult.error ? saveResult.error : "QuickCalAI could not save this event.",
          statusError: true,
          conflictNotice: null,
        });
        return kept.accepted ? kept.state : after;
      }).then((finished) => {
        if (finished.mode === "saved" && finished.savedRecord) {
          return scheduleConflictCheck(incognito, finished.savedRecord).then(() => finished);
        }
        return finished;
      });
    }
    return state;
  });
}

async function runBatchFollowup(incognito, text, timeZone, operation, batch, targetRef) {
  const context = self.QuickCalBatch.contextForModel(batch, targetRef || batch.clarifyingRef || null);
  const result = await parseForContent({
    text: text,
    timeZone: timeZone || "UTC",
    batchContext: context,
  });
  return mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    if (!latest.batch) {
      const failed = self.QuickCalSession.finishOperation(latest, operation, {
        statusText: "That batch is no longer open.",
        statusError: true,
        input: text,
      });
      return failed.accepted ? failed.state : latest;
    }
    if (!result || result.ok !== true || !result.followup) {
      const failed = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "batch-clarifying",
        statusText: result && result.error ? result.error : "QuickCalAI could not read that answer.",
        statusError: true,
        input: text,
      });
      return failed.accepted ? failed.state : latest;
    }
    const followup = result.followup;
    if (followup.action === "ambiguous") {
      const finished = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "batch-clarifying",
        statusText: followup.question || "Which event do you mean?",
        statusError: false,
        input: "",
      });
      return finished.accepted ? finished.state : latest;
    }
    if (followup.action === "none") {
      const finished = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "reviewing",
        batch: Object.assign({}, latest.batch, { clarifyingRef: "" }),
        clarification: null,
        event: null,
        input: "",
        statusText: followup.question || "",
        statusError: false,
      });
      return finished.accepted ? finished.state : latest;
    }
    const patches = [];
    if (followup.action === "skip" && followup.ref) {
      patches.push({ ref: followup.ref, skip: true });
    } else if (followup.action === "update" && followup.ref && followup.event) {
      patches.push({ ref: followup.ref, event: followup.event });
    }
    const nextBatch = self.QuickCalBatch.mergePatch(latest.batch, patches);
    nextBatch.clarifyingRef = "";
    const finished = self.QuickCalSession.finishOperation(latest, operation, {
      mode: "reviewing",
      batch: nextBatch,
      clarification: null,
      event: null,
      input: "",
      statusText: "",
      statusError: false,
    });
    return finished.accepted ? finished.state : latest;
  });
}

async function saveBatchDraft(incognito, draft, generation) {
  if (!draft || !draft.complete || draft.saveStatus === "saved") {
    return { ref: draft && draft.ref, skipped: true };
  }
  const eventId = draft.calendarEventId || createEventId();
  await mutateWidgetSession(incognito, (latest) => {
    if (!latest.visible || !latest.batch || latest.batch.generation !== generation) return latest;
    const drafts = latest.batch.drafts.map((item) => {
      if (item.ref !== draft.ref) return item;
      return Object.assign({}, item, {
        calendarEventId: eventId,
        saveStatus: "saving",
        saveError: "",
      });
    });
    return Object.assign({}, latest, {
      batch: Object.assign({}, latest.batch, { drafts: drafts, saving: true }),
      revision: latest.revision + 1,
    });
  });
  const result = await saveWidgetEvent(draft.event, { eventId: eventId });
  await mutateWidgetSession(incognito, (latest) => {
    // Late responses must not reopen a dismissed widget or overwrite a newer conversation.
    if (!latest.visible || !latest.batch || latest.batch.generation !== generation) return latest;
    const drafts = latest.batch.drafts.map((item) => {
      if (item.ref !== draft.ref) return item;
      if (result && result.ok === true && result.htmlLink) {
        return Object.assign({}, item, {
          calendarEventId: result.id || eventId,
          saveStatus: "saved",
          savedRecord: result,
          saveError: "",
          selected: false,
        });
      }
      if (result && result.uncertain) {
        return Object.assign({}, item, {
          calendarEventId: eventId,
          saveStatus: "uncertain",
          saveError: result.error || "QuickCalAI could not confirm whether this event was saved.",
        });
      }
      return Object.assign({}, item, {
        calendarEventId: eventId,
        saveStatus: "failed",
        saveError: result && result.error ? result.error : "QuickCalAI could not save this event.",
      });
    });
    const unfinished = drafts.some((item) => item.saveStatus === "saving" || item.saveStatus === "pending");
    return Object.assign({}, latest, {
      batch: Object.assign({}, latest.batch, { drafts: drafts, saving: unfinished }),
      revision: latest.revision + 1,
    });
  });
  return { ref: draft.ref, result: result, eventId: eventId };
}

async function runBatchSave(incognito, operation, batch, refs) {
  let working = ensureDraftIds(batch);
  const selected = working.drafts.filter((draft) => {
    if (draft.saveStatus === "saved") return false;
    if (Array.isArray(refs) && refs.length) return refs.indexOf(draft.ref) !== -1;
    return draft.selected && draft.complete;
  });
  if (!selected.length) {
    return mutateWidgetSession(incognito, (latest) => {
      if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
      const finished = self.QuickCalSession.finishOperation(latest, operation, {
        mode: "reviewing",
        statusText: "Select at least one complete event to add.",
        statusError: true,
      });
      return finished.accepted ? finished.state : latest;
    });
  }
  const generation = working.generation || 1;
  await mutateWidgetSession(incognito, (latest) => {
    if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
    const next = ensureDraftIds(latest.batch || working);
    next.saving = true;
    next.drafts = next.drafts.map((draft) => {
      const chosen = selected.some((item) => item.ref === draft.ref);
      if (!chosen) return draft;
      return Object.assign({}, draft, {
        calendarEventId: draft.calendarEventId || selected.find((item) => item.ref === draft.ref).calendarEventId,
        saveStatus: draft.saveStatus === "saved" ? "saved" : "pending",
      });
    });
    working = next;
    return Object.assign({}, latest, {
      mode: "batch-results",
      batch: next,
      statusText: "Adding selected events\u2026",
      statusError: false,
      revision: latest.revision + 1,
    });
  });
  const savedRecords = [];
  for (let index = 0; index < selected.length; index += 1) {
    const live = await readWidgetSession(incognito);
    if (!live.visible || !live.batch) break;
    if (!self.QuickCalSession.operationCurrent(live, operation) && live.operation) break;
    const currentDraft = (live.batch.drafts || []).find((item) => item.ref === selected[index].ref) || selected[index];
    if (currentDraft.saveStatus === "saved") continue;
    const outcome = await saveBatchDraft(incognito, currentDraft, live.batch.generation || generation);
    if (outcome && outcome.result && outcome.result.ok && outcome.result.htmlLink) {
      savedRecords.push(outcome.result);
    }
  }
  const finished = await mutateWidgetSession(incognito, (latest) => {
    if (!latest.batch) return latest;
    const drafts = latest.batch.drafts;
    const savedCount = drafts.filter((item) => item.saveStatus === "saved").length;
    const failedCount = drafts.filter((item) => item.saveStatus === "failed" || item.saveStatus === "uncertain").length;
    let statusText = "";
    if (savedCount && failedCount) statusText = "Added " + savedCount + " event" + (savedCount === 1 ? "" : "s") + ". Some could not be saved.";
    else if (savedCount) statusText = "Added " + savedCount + " event" + (savedCount === 1 ? "" : "s") + ".";
    else if (failedCount) statusText = "QuickCalAI could not save the selected events.";
    const done = self.QuickCalSession.finishOperation(latest, operation, {
      mode: "batch-results",
      batch: Object.assign({}, latest.batch, { saving: false }),
      statusText: statusText,
      statusError: !savedCount && !!failedCount,
      conflictNotice: null,
    });
    return done.accepted ? done.state : latest;
  });
  for (let index = 0; index < savedRecords.length; index += 1) {
    await scheduleConflictCheck(incognito, savedRecords[index]);
  }
  return finished;
}

async function runWidgetSubmit(incognito, text, timeZone, operation, editing, clarification, savedRecord, originalText, parsed) {
  const message = { text: text, timeZone: timeZone || "UTC" };
  if (clarification) message.clarification = clarification;
  else if (editing) message.currentEvent = savedPayload(savedRecord);
  const result = parsed || await parseForContent(message);
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
        lookup: null,
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
      lookup: null,
      statusText: editing ? "Updating event\u2026" : result.event.kind === "task" ? "Creating task\u2026" : "Creating event\u2026",
      statusError: false,
    });
  });
  if (!self.QuickCalSession.operationCurrent(pendingState, operation)) return pendingState;
  const saveResult = editing
    ? await updateWidgetEvent(pendingState.event)
    : await saveWidgetEvent(pendingState.event);
  const finished = await mutateWidgetSession(incognito, (after) => {
    if (!self.QuickCalSession.operationCurrent(after, operation)) return after;
    if (saveResult && saveResult.ok === true && saveResult.htmlLink) {
      const checking = self.QuickCalConflicts && saveResult.kind !== "task"
        ? self.QuickCalConflicts.checkingNotice("pending", saveResult)
        : null;
      const saved = self.QuickCalSession.finishOperation(after, operation, {
        mode: "saved",
        savedRecord: saveResult,
        event: pendingState.event,
        draftEvent: null,
        clarification: null,
        lookup: null,
        input: "",
        statusText: checking ? checking.statusText : "",
        statusError: false,
        conflictNotice: checking,
      });
      return saved.accepted ? saved.state : after;
    }
    const kept = self.QuickCalSession.finishOperation(after, operation, {
      mode: "failed",
      draftEvent: pendingState.event,
      event: pendingState.event,
      statusText: saveResult && saveResult.error ? saveResult.error : "QuickCalAI could not save this event.",
      statusError: true,
      conflictNotice: null,
      input: text,
    });
    return kept.accepted ? kept.state : after;
  });
  if (saveResult && saveResult.ok === true && saveResult.htmlLink && saveResult.kind !== "task") {
    return scheduleConflictCheck(incognito, saveResult);
  }
  return finished;
}

// ---------------------------------------------------------------------------
// Document review. A document is read into text once; the text stays in
// chrome.storage.session (cleared when the browser closes) and never in the
// shared panel state. Nothing is written to Google until the user approves
// individual items and asks to create them.

const DOC_TEXT_PREFIX = "quickcalDocText:";
const DOC_TEXT_TTL_MS = 2 * 60 * 60 * 1000;
const DOC_BUSY = ["reading", "analyzing", "creating"];
const DOC_EXTRACT_TIMEOUT_MS = 45000;
const DOC_ANALYZE_TIMEOUT_MS = 130000;
const docJobs = new Map();

function blankDoc() {
  return {
    id: "d" + self.QuickCalDocuments.randomId(12),
    open: true,
    phase: "empty",
    file: null,
    instructions: "",
    history: [],
    seq: 0,
    message: "",
    messageError: false,
    warning: "",
    items: [],
    timeZone: "",
    analyzedAt: "",
  };
}

async function saveDocText(id, text) {
  const store = sessionStore();
  if (!store) throw new Error("No session storage.");
  await store.set({ [DOC_TEXT_PREFIX + id]: { text: text, expiresAt: Date.now() + DOC_TEXT_TTL_MS } });
}

async function loadDocText(id) {
  const store = sessionStore();
  if (!store || !id) return "";
  const key = DOC_TEXT_PREFIX + id;
  const stored = await store.get(key);
  const entry = stored ? stored[key] : null;
  if (!entry || typeof entry.text !== "string") return "";
  if (!(entry.expiresAt > Date.now())) {
    await store.remove(key).catch(() => {});
    return "";
  }
  return entry.text;
}

function dropDocText(id) {
  const store = sessionStore();
  if (!store || !id) return Promise.resolve();
  return Promise.resolve(store.remove(DOC_TEXT_PREFIX + id)).catch(() => {});
}

// Long document requests outlast the service worker's idle timer, so a cheap
// extension call keeps it alive until the response arrives.
function keepWorkerAlive() {
  const timer = setInterval(() => {
    if (chrome.runtime && typeof chrome.runtime.getPlatformInfo === "function") {
      Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => {});
    }
  }, 20000);
  return () => clearInterval(timer);
}

async function hostedToken() {
  if (await isSuppressed()) return { ok: false, state: "disconnected", error: "Connect Google Calendar before using QuickCalAI." };
  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    token = "";
  }
  if (!token) return { ok: false, state: "disconnected", error: "Connect Google Calendar before using QuickCalAI." };
  return { ok: true, token: token };
}

async function hostedDocumentCall(url, options, timeoutMs) {
  const auth = await hostedToken();
  if (!auth.ok) return auth;
  const release = keepWorkerAlive();
  let response;
  let raw = "";
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "omit",
      headers: Object.assign({ Authorization: "Bearer " + auth.token }, options.headers),
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    raw = await response.text();
  } catch (error) {
    const name = error && error.name;
    return {
      ok: false,
      error: name === "TimeoutError" || name === "AbortError"
        ? "QuickCalAI took too long with this document. Try a shorter section or a narrower request."
        : "QuickCalAI could not reach QuickCal. Try again.",
    };
  } finally {
    release();
  }
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    payload = null;
  }
  if (response.status === 401) return { ok: false, state: "disconnected", error: "Connect Google Calendar before using QuickCalAI." };
  if (!response.ok || !payload || payload.ok !== true) {
    const message = payload && typeof payload.error === "string" ? payload.error.slice(0, 300) : "";
    return { ok: false, error: message || "QuickCalAI could not read this document. Try again." };
  }
  if (payload.quickcalApiVersion !== self.QuickCalLocalParse.API_VERSION) {
    return { ok: false, error: "QuickCalAI's hosted parser is out of date. Deploy the current backend, then reload the extension." };
  }
  return { ok: true, payload: payload };
}

function docStatus(doc, patch) {
  return Object.assign({}, doc, { message: "", messageError: false }, patch);
}

// Applies `change(doc, state)` to the shared session's document. Returning
// null leaves the session untouched. `statePatch` updates other session
// fields in the same write.
function mutateDoc(incognito, change, statePatch) {
  return mutateWidgetSession(incognito, (state) => {
    const next = change(state.doc || null, state);
    if (next === null || next === undefined) return state;
    return Object.assign({}, state, statePatch || {}, { doc: next, revision: state.revision + 1 });
  });
}

// A step whose service worker stopped part way is reported, not left spinning.
function settleInterrupted(doc) {
  if (!doc || DOC_BUSY.indexOf(doc.phase) === -1 || docJobs.has(doc.id)) return doc;
  const phase = doc.items.length ? "review" : doc.file && doc.phase !== "reading" ? "ready" : doc.file ? "unreadable" : "empty";
  return docStatus(doc, { phase: phase, message: "That step was interrupted. Try again.", messageError: true });
}

function sameDoc(doc, message) {
  return !!(doc && message && message.docId === doc.id);
}

function decodeUpload(data, size) {
  if (typeof data !== "string" || data.length > Math.ceil(self.QuickCalDocuments.MAX_FILE_BYTES / 3) * 4 + 4) return null;
  let binary;
  try {
    binary = atob(data);
  } catch (error) {
    return null;
  }
  if (binary.length !== size) return null;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function looksLike(kind, bytes) {
  const head = String.fromCharCode.apply(null, Array.from(bytes.subarray(0, Math.min(1024, bytes.length))));
  if (kind === "pdf") return head.indexOf("%PDF-") !== -1;
  if (kind === "docx") return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  return bytes.subarray(0, 4096).indexOf(0) === -1 || (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff);
}

async function attachDocument(incognito, message) {
  const api = self.QuickCalDocuments;
  const name = typeof message.name === "string" ? message.name.trim() : "";
  const checked = api.checkFile({ name: name, size: message.size });
  const bytes = checked.ok ? decodeUpload(message.data, message.size) : null;
  let problem = checked.ok ? "" : checked.error;
  if (!problem && !bytes) problem = "QuickCalAI could not read this file. Try choosing it again.";
  if (!problem && !looksLike(checked.kind, bytes)) {
    problem = "This file's contents do not match its ." + checked.kind + " name.";
  }
  let previousId = "";
  let doc = null;
  const state = await mutateDoc(incognito, (current, session) => {
    if (message.sessionId && message.sessionId !== session.sessionId) return null;
    if (current && docJobs.has(current.id)) return null;
    previousId = current ? current.id : "";
    doc = Object.assign(blankDoc(), {
      phase: problem ? "unreadable" : "reading",
      file: { name: name.slice(0, 255) || "Document", size: message.size, kind: checked.kind || "", pages: null, characters: null },
      seq: 1,
      message: problem || "Reading " + (name || "the document") + "\u2026",
      messageError: !!problem,
    });
    return doc;
  });
  if (!doc) return { ok: false, ignored: true, session: state };
  if (previousId) dropDocText(previousId);
  if (problem) return { ok: false, session: state };

  const job = (async () => {
    const result = await hostedDocumentCall(self.QuickCalLocalParse.EXTRACT_URL, {
      headers: { "Content-Type": checked.mime },
      body: bytes,
    }, DOC_EXTRACT_TIMEOUT_MS);
    let stored = false;
    if (result.ok && typeof result.payload.text === "string" && result.payload.text.trim()) {
      try {
        await saveDocText(doc.id, result.payload.text);
        stored = true;
      } catch (error) {
        stored = false;
      }
    }
    return mutateDoc(incognito, (current) => {
      if (!current || current.id !== doc.id || current.seq !== doc.seq) return null;
      if (!stored) {
        return docStatus(current, {
          phase: "unreadable",
          message: result.ok ? "QuickCalAI could not keep this document's text. Try again." : result.error,
          messageError: true,
          needsConnect: result.state === "disconnected",
        });
      }
      return docStatus(current, {
        phase: "ready",
        file: Object.assign({}, current.file, {
          pages: Number.isInteger(result.payload.pages) ? result.payload.pages : null,
          characters: result.payload.text.length,
        }),
      });
    });
  })();
  docJobs.set(doc.id, job);
  try {
    return { ok: true, session: await job };
  } finally {
    docJobs.delete(doc.id);
  }
}

async function analyzeDocument(incognito, message) {
  const api = self.QuickCalDocuments;
  const instructions = typeof message.instructions === "string" ? message.instructions.trim().slice(0, 2000) : "";
  const timeZone = typeof message.timeZone === "string" && message.timeZone ? message.timeZone : "UTC";
  let job = null;
  const state = await mutateDoc(incognito, (current) => {
    const doc = settleInterrupted(current);
    if (!sameDoc(doc, message) || docJobs.has(doc.id)) return null;
    if (doc.phase !== "ready" && doc.phase !== "review") return null;
    job = { id: doc.id, seq: doc.seq + 1, history: doc.instructions ? doc.history.concat([doc.instructions]).slice(-4) : doc.history };
    return docStatus(doc, {
      phase: "analyzing",
      seq: job.seq,
      pending: instructions,
      message: "Finding " + (instructions ? "matching items" : "dates and deadlines") + " in " + doc.file.name + "\u2026",
    });
  }, { input: "" });
  if (!job) return { ok: false, ignored: true, session: state };
  const run = (async () => {
    const text = await loadDocText(job.id);
    const result = text
      ? await hostedDocumentCall(self.QuickCalLocalParse.ANALYZE_URL, {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: text,
          instructions: instructions,
          history: job.history,
          timeZone: timeZone,
          fileName: state.doc.file.name,
        }),
      }, DOC_ANALYZE_TIMEOUT_MS)
      : { ok: false, error: "QuickCalAI no longer has this document's text. Remove the file and upload it again." };
    return mutateDoc(incognito, (current) => {
      // Only the newest request may change the list.
      if (!current || current.id !== job.id || current.seq !== job.seq) return null;
      const back = current.items.length ? "review" : "ready";
      if (!result.ok) {
        return docStatus(current, { phase: back, pending: "", message: result.error, messageError: true, needsConnect: result.state === "disconnected" });
      }
      const proposals = api.sanitizeItems(result.payload.items);
      const items = api.mergeDecisions(current.items, proposals);
      const warning = typeof result.payload.warning === "string" ? result.payload.warning.slice(0, 400) : "";
      return docStatus(current, {
        phase: "review",
        pending: "",
        instructions: instructions,
        history: job.history,
        items: items,
        warning: warning,
        timeZone: timeZone,
        analyzedAt: current.analyzedAt || new Date().toISOString(),
        message: proposals.length ? "" : warning || "No matching items were found in this document.",
      });
    });
  })();
  docJobs.set(job.id, run);
  try {
    return { ok: true, session: await run };
  } finally {
    docJobs.delete(job.id);
  }
}

function changeDocItem(incognito, message, update) {
  let error = "";
  return mutateDoc(incognito, (current) => {
    const doc = settleInterrupted(current);
    if (!sameDoc(doc, message) || doc.phase === "creating" || doc.phase === "analyzing") return null;
    const index = doc.items.findIndex((item) => item.id === message.itemId);
    if (index === -1) return null;
    const changed = update(doc.items[index]);
    if (!changed.ok) {
      error = changed.error;
      return docStatus(doc, { message: changed.error, messageError: true });
    }
    const items = doc.items.slice();
    items[index] = changed.item;
    return docStatus(doc, { items: items });
  }).then((session) => ({ ok: !error, error: error || undefined, session: session }));
}

async function insertDocumentEvent(item, fileName, timeZone) {
  const body = self.QuickCalDocuments.eventBody(item, fileName, timeZone, self.QuickCalSchedule);
  if (!body) return { ok: false, error: "This event needs a date and a start time." };
  const readUrl = CALENDAR_EVENTS_URL + "/" + encodeURIComponent(body.id) + "?fields=id,status,htmlLink";
  const confirmed = (found) => {
    if (!found || found.id !== body.id || found.status === "cancelled") return null;
    return { ok: true, kind: "event", id: found.id, link: safeCalendarLink(found.htmlLink) };
  };
  const existing = await calendarCall(readUrl, { method: "GET" });
  if (existing.ok) {
    return confirmed(existing.body) || { ok: false, error: "This event was deleted in Google Calendar." };
  }
  const created = await calendarCall(CALENDAR_EVENTS_URL + "?sendUpdates=none&fields=id,status,htmlLink", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (created.ok && confirmed(created.body)) return confirmed(created.body);
  const failure = callFailed(created);
  if (failure) return { ok: false, state: "disconnected", error: "Connect Google Calendar, then retry." };
  if (created.status === 403) return { ok: false, error: "Google Calendar did not allow QuickCalAI to create this event." };
  if (created.status === 400) return { ok: false, error: "Google Calendar rejected this event's details." };
  // The id is fixed, so checking again can only find this item's own event.
  const check = await calendarCall(readUrl, { method: "GET" });
  if (check.ok && confirmed(check.body)) return confirmed(check.body);
  return { ok: false, error: "QuickCalAI could not confirm this event. Retrying will not create a duplicate." };
}

async function findDocumentTask(item, since) {
  const listed = await calendarCall(taskRecoveryUrl(since), { method: "GET" });
  if (!listed.ok || !listed.body || !Array.isArray(listed.body.items)) return null;
  const marker = "(ref " + item.ref + ")";
  return listed.body.items.find((task) => task && !task.deleted && typeof task.notes === "string" && task.notes.indexOf(marker) !== -1) || null;
}

async function insertDocumentTask(item, fileName, since) {
  const body = self.QuickCalDocuments.taskBody(item, fileName, self.QuickCalPreview.taskDueTime(item.startTime));
  if (!body) return { ok: false, error: "This task needs a title." };
  const saved = (task) => ({ ok: true, kind: "task", id: task.id, link: tasksLink(task.webViewLink) });
  if (item.result) {
    const earlier = await findDocumentTask(item, since);
    if (earlier) return saved(earlier);
  }
  const created = await calendarCall(taskInsertUrl(), { method: "POST", body: JSON.stringify(body) });
  if (created.ok && created.body && created.body.id) return saved(created.body);
  if (created.network || (created.status && created.status >= 500)) {
    const found = await findDocumentTask(item, since);
    if (found) return saved(found);
    return { ok: false, error: "QuickCalAI could not confirm this task. Retrying checks Google Tasks first." };
  }
  const failure = tasksFailure(created, "Google Tasks could not save this task");
  return { ok: false, state: failure.state, error: failure.error };
}

function createdSummary(items) {
  const done = items.filter((item) => item.result && item.result.ok);
  const failed = items.filter((item) => item.decision === "approved" && item.result && !item.result.ok);
  const events = done.filter((item) => item.kind === "event").length;
  const tasks = done.length - events;
  const parts = [];
  if (events) parts.push(events + " event" + (events === 1 ? "" : "s"));
  if (tasks) parts.push(tasks + " task" + (tasks === 1 ? "" : "s"));
  const created = parts.length ? "Created " + parts.join(" and ") + "." : "";
  if (!failed.length) return { message: created || "Nothing was created.", error: false };
  return {
    message: (created ? created + " " : "") + failed.length + " could not be created. Retry to try " + (failed.length === 1 ? "it" : "them") + " again.",
    error: true,
  };
}

async function createDocumentItems(incognito, message) {
  const api = self.QuickCalDocuments;
  let job = null;
  const state = await mutateDoc(incognito, (current) => {
    const doc = settleInterrupted(current);
    if (!sameDoc(doc, message) || docJobs.has(doc.id) || doc.phase !== "review") return null;
    const ready = api.waiting(doc.items).filter((item) => !api.itemProblem(item));
    if (!ready.length) return docStatus(doc, { message: "Approve at least one item first.", messageError: true });
    const tally = api.counts(doc.items);
    job = { id: doc.id, seq: doc.seq + 1, itemIds: ready.map((item) => item.id) };
    return docStatus(doc, {
      phase: "creating",
      seq: job.seq,
      message: "Creating " + [tally.events ? tally.events + " event" + (tally.events === 1 ? "" : "s") : "", tally.tasks ? tally.tasks + " task" + (tally.tasks === 1 ? "" : "s") : ""].filter(Boolean).join(" and ") + "\u2026",
    });
  });
  if (!job) return { ok: false, ignored: true, session: state };
  const run = (async () => {
    const doc = state.doc;
    const timeZone = doc.timeZone || (typeof message.timeZone === "string" && message.timeZone) || "UTC";
    const since = new Date(Date.parse(doc.analyzedAt || new Date().toISOString()) - 10 * 60000).toISOString();
    const denied = missingCalendarGrant(await refreshStatus(), "Connect Google Calendar, then retry.");
    for (const itemId of job.itemIds) {
      const latest = await readWidgetSession(incognito);
      const item = latest.doc && latest.doc.id === job.id ? latest.doc.items.find((entry) => entry.id === itemId) : null;
      if (!item || item.decision !== "approved" || (item.result && item.result.ok)) continue;
      let result;
      try {
        result = denied
          ? { ok: false, error: denied.error }
          : item.kind === "event"
            ? await insertDocumentEvent(item, doc.file.name, timeZone)
            : await insertDocumentTask(item, doc.file.name, since);
      } catch (error) {
        result = { ok: false, error: "QuickCalAI could not create this item." };
      }
      await mutateDoc(incognito, (current) => {
        if (!current || current.id !== job.id) return null;
        return Object.assign({}, current, {
          items: current.items.map((entry) => (entry.id === itemId ? Object.assign({}, entry, { result: result }) : entry)),
        });
      });
    }
    return mutateDoc(incognito, (current) => {
      if (!current || current.id !== job.id || current.seq !== job.seq) return null;
      const summary = createdSummary(current.items);
      return docStatus(current, { phase: "review", message: summary.message, messageError: summary.error });
    });
  })();
  docJobs.set(job.id, run);
  try {
    return { ok: true, session: await run };
  } finally {
    docJobs.delete(job.id);
  }
}

function handleDocumentMessage(message, incognito) {
  const action = message.action;
  if (action === "doc-open") {
    return mutateWidgetSession(incognito, (state) => {
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      if (!state.visible || state.operation) return state;
      // The document panel replaces any open event card; it never merges with it.
      const base = state.mode === "input" ? state : self.QuickCalSession.openReset(state);
      const doc = base.doc ? settleInterrupted(Object.assign({}, base.doc, { open: true })) : blankDoc();
      return Object.assign({}, base, { doc: doc, revision: base.revision + 1 });
    }).then((session) => ({ ok: true, session: session }));
  }
  if (action === "doc-close") {
    return mutateDoc(incognito, (current) => (current ? Object.assign({}, current, { open: false }) : null))
      .then((session) => ({ ok: true, session: session }));
  }
  if (action === "doc-remove") {
    let removed = "";
    return mutateDoc(incognito, (current) => {
      if (!sameDoc(current, message) || docJobs.has(current.id)) return null;
      removed = current.id;
      return blankDoc();
    }).then((session) => {
      if (removed) dropDocText(removed);
      return { ok: true, session: session };
    });
  }
  if (action === "doc-attach") return attachDocument(incognito, message);
  if (action === "doc-analyze") return analyzeDocument(incognito, message);
  if (action === "doc-decide") {
    return changeDocItem(incognito, message, (item) => self.QuickCalDocuments.decide(item, message.decision));
  }
  if (action === "doc-edit") {
    return changeDocItem(incognito, message, (item) => self.QuickCalDocuments.applyEdit(item, message.patch));
  }
  if (action === "doc-create") return createDocumentItems(incognito, message);
  return Promise.resolve({ ok: false });
}

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// Changes only the start and end of the saved event shown in the panel. It
// patches that event by id and never creates another one.
function retimeSavedEvent(incognito, message) {
  const startTime = typeof message.startTime === "string" && CLOCK_TIME.test(message.startTime) ? message.startTime : "";
  const endTime = typeof message.endTime === "string" && CLOCK_TIME.test(message.endTime) ? message.endTime : "";
  const eventId = typeof message.eventId === "string" ? message.eventId : "";
  if (!startTime || !endTime || !eventId) {
    return Promise.resolve({ ok: false, error: "Choose a valid time." });
  }
  let operation = null;
  let record = null;
  return mutateWidgetSession(incognito, (state) => {
    if (message.sessionId && message.sessionId !== state.sessionId) return state;
    const saved = state.savedRecord;
    if (state.mode !== "saved" || !saved || saved.kind === "task" || saved.id !== eventId) return state;
    const begun = self.QuickCalSession.beginOperation(
      state,
      "retime",
      message.operationId || "retime-" + String(state.revision + 1),
      state.sessionId
    );
    if (!begun.accepted) return state;
    operation = begun.state.operation;
    record = saved;
    return Object.assign({}, begun.state, { statusText: "Updating event\u2026", statusError: false });
  }).then(async (state) => {
    if (!operation || !state.operation || state.operation.id !== operation.id) {
      return { ok: false, ignored: true, session: state };
    }
    const event = Object.assign(savedPayload(record), {
      startTime: startTime,
      endTime: endTime,
      durationDefaulted: false,
      needsClarification: false,
      clarificationQuestions: [],
    });
    let result;
    try {
      result = await updateWidgetEvent(event, record.id);
    } catch (error) {
      result = { ok: false, error: "QuickCalAI could not update this event." };
    }
    const updated = !!(result && result.ok === true && result.htmlLink);
    const session = await mutateWidgetSession(incognito, (after) => {
      if (!self.QuickCalSession.operationCurrent(after, operation)) return after;
      const checking = updated && self.QuickCalConflicts ? self.QuickCalConflicts.checkingNotice("pending", result) : null;
      const finished = self.QuickCalSession.finishOperation(after, operation, updated
        ? {
          mode: "saved",
          savedRecord: result,
          statusText: checking ? checking.statusText : "",
          statusError: false,
          conflictNotice: checking,
        }
        : {
          statusText: result && result.error ? result.error : "QuickCalAI could not update this event.",
          statusError: true,
        });
      return finished.accepted ? finished.state : after;
    });
    if (updated) {
      const checked = await scheduleConflictCheck(incognito, result);
      return { ok: true, session: checked || session };
    }
    return { ok: false, error: result && result.error, session: session };
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
    let closedDoc = "";
    return mutateWidgetSession(incognito, (state) => {
      closedDoc = state.doc ? state.doc.id : "";
      return self.QuickCalSession.dismiss(state);
    }).then((state) => {
      if (closedDoc) dropDocText(closedDoc);
      return { ok: true, session: state };
    });
  }
  if (typeof action === "string" && action.indexOf("doc-") === 0) return handleDocumentMessage(message, incognito);
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
  if (action === "cancel-lookup") {
    return mutateWidgetSession(incognito, (state) => {
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      return Object.assign({}, state, {
        lookup: null,
        mode: state.savedRecord ? "saved" : "input",
        input: "",
        statusText: "",
        statusError: false,
        conflictNotice: state.savedRecord ? state.conflictNotice : null,
        revision: state.revision + 1,
      });
    }).then((session) => ({ ok: true, session: session }));
  }
  if (action === "confirm") {
    let operation = null;
    let lookup = null;
    return mutateWidgetSession(incognito, (state) => {
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      if (!state.visible || !state.lookup || state.lookup.kind !== "confirm") return state;
      const begun = self.QuickCalSession.beginOperation(
        state,
        "confirm",
        message.operationId || "confirm-" + String(state.revision + 1),
        state.sessionId
      );
      if (!begun.accepted) return state;
      operation = begun.state.operation;
      lookup = state.lookup;
      const confirmingAvailability = state.lookup.action === "availability";
      return Object.assign({}, begun.state, {
        statusText: state.lookup.action === "delete"
          ? "Deleting event\u2026"
          : confirmingAvailability
            ? "Creating event\u2026"
            : "Updating event\u2026",
        statusError: false,
      });
    }).then((state) => {
      if (!operation || !state.operation || state.operation.id !== operation.id) {
        return { ok: false, ignored: true, session: state };
      }
      if (lookup && lookup.action === "availability" && lookup.forceSchedule) {
        const slot = lookup.selectedSlot || (lookup.candidates && lookup.candidates[0]);
        const query = Object.assign({}, lookup.query || {});
        return saveAvailabilitySlot(incognito, operation, query, lookup.timeZone || "UTC", slot, true)
          .then((session) => ({ ok: true, session: session }));
      }
      return runConfirmedLookup(incognito, operation, lookup).then((session) => ({ ok: true, session: session }));
    });
  }
  if (action === "retime") return retimeSavedEvent(incognito, message);
  if (action === "batch-toggle") {
    const ref = typeof message.ref === "string" ? message.ref : "";
    const selected = message.selected === true;
    return mutateWidgetSession(incognito, (state) => {
      if (!state.visible || !state.batch || state.batch.saving) return state;
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      const next = self.QuickCalBatch.mergePatch(state.batch, [{ ref: ref, selected: selected }]);
      return Object.assign({}, state, {
        batch: next,
        mode: state.mode === "batch-results" ? "reviewing" : state.mode,
        revision: state.revision + 1,
      });
    }).then((session) => ({ ok: true, session: session }));
  }
  if (action === "batch-complete") {
    const ref = typeof message.ref === "string" ? message.ref : "";
    return mutateWidgetSession(incognito, (state) => {
      if (!state.visible || !state.batch) return state;
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      const draft = (state.batch.drafts || []).find((item) => item.ref === ref);
      if (!draft || draft.complete || draft.saveStatus === "saved") return state;
      return self.QuickCalSession.noteBatchClarification(state, state.batch, ref, draft.event);
    }).then((session) => ({ ok: true, session: session }));
  }
  if (action === "batch-cancel-clarify") {
    return mutateWidgetSession(incognito, (state) => {
      if (!state.visible || !state.batch) return state;
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      if (state.mode !== "batch-clarifying") return state;
      return Object.assign({}, state, {
        mode: "reviewing",
        batch: Object.assign({}, state.batch, { clarifyingRef: "" }),
        clarification: null,
        event: null,
        input: "",
        statusText: "",
        statusError: false,
        revision: state.revision + 1,
      });
    }).then((session) => ({ ok: true, session: session }));
  }
  if (action === "batch-confirm") {
    let operation = null;
    let batch = null;
    const refs = Array.isArray(message.refs) ? message.refs.filter((item) => typeof item === "string") : [];
    return mutateWidgetSession(incognito, (state) => {
      if (message.sessionId && message.sessionId !== state.sessionId) return state;
      if (!state.visible || !state.batch || state.batch.saving) return state;
      if (state.mode !== "reviewing" && state.mode !== "batch-results") return state;
      const begun = self.QuickCalSession.beginOperation(
        state,
        "batch-save",
        message.operationId || "batch-" + String(state.revision + 1),
        state.sessionId
      );
      if (!begun.accepted) return state;
      operation = begun.state.operation;
      batch = state.batch;
      return Object.assign({}, begun.state, {
        statusText: "Adding selected events\u2026",
        statusError: false,
      });
    }).then((state) => {
      if (!operation || !state.operation || state.operation.id !== operation.id || !batch) {
        return { ok: false, ignored: true, session: state };
      }
      return runBatchSave(incognito, operation, batch, refs).then((session) => ({ ok: true, session: session }));
    });
  }
  if (action === "submit") {
    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) return Promise.resolve({ ok: false, error: "Text is required." });
    let operation = null;
    let context = null;
    return mutateWidgetSession(incognito, (state) => {
      let current = state;
      // While the document panel is open, typed text is a filter for the
      // document, never an ordinary event request.
      if (current.doc && current.doc.open) return state;
      if (message.fresh) current = self.QuickCalSession.openReset(current);
      if (message.sessionId && !message.fresh && message.sessionId !== current.sessionId) return state;
      const batchMode = message.batch === true || current.mode === "batch-clarifying" || current.mode === "reviewing";
      const begun = self.QuickCalSession.beginOperation(
        current,
        batchMode ? "batch-parse" : "parse",
        message.operationId || "op-" + String(current.revision + 1),
        current.sessionId
      );
      if (!begun.accepted) return state;
      operation = begun.state.operation;
      context = {
        editing: current.mode === "saved" && !!current.savedRecord && current.savedRecord.kind !== "task",
        clarification: current.mode === "clarifying" ? current.clarification : null,
        batch: current.batch,
        batchClarifying: current.mode === "batch-clarifying",
        batchTarget: current.mode === "batch-clarifying"
          ? (current.batch && current.batch.clarifyingRef) || (current.clarification && current.clarification.batchRef) || ""
          : "",
        extractBatch: message.batch === true && current.mode !== "batch-clarifying" && current.mode !== "reviewing",
        savedRecord: current.savedRecord,
        originalText: current.mode === "clarifying" && current.clarification ? current.clarification.originalText : text,
      };
      const pendingAvailability = current.lookup && current.lookup.action === "availability";
      return Object.assign({}, begun.state, {
        input: text,
        statusText: context.editing
          ? "Updating event\u2026"
          : context.batchClarifying || context.extractBatch
            ? "Reading your events\u2026"
            : pendingAvailability
              ? "Checking availability\u2026"
              : "Reading your event\u2026",
        statusError: false,
      });
    }).then((state) => {
      if (!operation || !state.operation || state.operation.id !== operation.id) {
        return { ok: false, ignored: true, session: state };
      }
      if (context.extractBatch) {
        return runBatchExtract(incognito, text, message.timeZone || "UTC", operation)
          .then((session) => ({ ok: true, session: session }));
      }
      if (context.batchClarifying && context.batch) {
        return runBatchFollowup(incognito, text, message.timeZone || "UTC", operation, context.batch, context.batchTarget)
          .then((session) => ({ ok: true, session: session }));
      }
      if (context.batch && (state.mode === "reviewing" || state.batch)) {
        // Free-text corrections while reviewing a batch.
        return runBatchFollowup(incognito, text, message.timeZone || "UTC", operation, context.batch, "")
          .then((session) => ({ ok: true, session: session }));
      }
      const pendingLookup = state.lookup || null;
      const request = { text: text, timeZone: message.timeZone || "UTC" };
      if (pendingLookup) request.operation = operationContext(pendingLookup);
      else if (context.clarification) request.clarification = context.clarification;
      else if (context.editing) request.currentEvent = savedPayload(context.savedRecord);
      return parseForContent(request).then((result) => {
        if (!result || result.ok !== true || !result.event || !result.event.intent) {
          return mutateWidgetSession(incognito, (latest) => {
            if (!self.QuickCalSession.operationCurrent(latest, operation)) return latest;
            const failed = self.QuickCalSession.finishOperation(latest, operation, {
              statusText: result && result.error ? result.error : "QuickCalAI could not understand that. Nothing was changed.",
              statusError: true,
              input: text,
            });
            return failed.accepted ? failed.state : latest;
          }).then((session) => ({ ok: true, session: session }));
        }
        const intent = result.event.intent;
        if (pendingLookup && pendingLookup.action === "availability" && (intent === "create" || intent === "edit")) {
          return settleLookup(incognito, operation, async () => ({
            statusText: "That sounds like a new event. Dismiss availability first, or pick a listed time.",
            statusError: false,
            input: text,
          })).then((session) => ({ ok: true, session: session }));
        }
        if (intent === "create" || intent === "edit") {
          const view = self.QuickCalPreview.previewModel(result.event);
          if (pendingLookup && !view.saveable) {
            return settleLookup(incognito, operation, async () => ({
              statusText: (result.event.clarificationQuestions && result.event.clarificationQuestions[0]) || "I didn't catch that. Nothing was changed.",
              statusError: false,
              input: text,
            })).then((session) => ({ ok: true, session: session }));
          }
          return runWidgetSubmit(
            incognito,
            text,
            message.timeZone,
            operation,
            intent === "edit",
            null,
            intent === "edit" ? context.savedRecord : null,
            context.originalText,
            result
          ).then((session) => ({ ok: true, session: session }));
        }
        return runInterpreted(incognito, text, message.timeZone, operation, pendingLookup, result.event)
          .then((session) => ({ ok: true, session: session }));
      });
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
      .then((result) => sendResponse(result && typeof result === "object" ? result : { ok: false }))
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
      updateWidgetEvent(message.event, typeof message.expectedId === "string" ? message.expectedId : "")
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not update this event." }));
      return true;
    }
    if (message.action === "invite") {
      inviteWidgetGuest(message)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: "QuickCalAI could not confirm the invitation. Check the event before trying again." }));
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
