importScripts("shared/test-event.js");

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

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null || !canInject(tab.url)) {
    reportBlocked();
    return;
  }

  try {
    chrome.scripting
      .executeScript({
        target: { tabId: tab.id },
        files: ["content/widget.js"],
      })
      .catch(reportBlocked);
  } catch (error) {
    reportBlocked(error);
  }
});

const AUTH_MESSAGE = "quickcal-auth";
const SUPPRESS_KEY = "quickcalCalendarSuppressed";
const CALENDAR_PROBE_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind";
const TEST_EVENT_KEY = "quickcalTestEvent";
const CALENDAR_EVENTS_URL =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const AUTH_ACTIONS = new Set(["status", "connect", "disconnect", "create-test-event"]);

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

async function refreshStatus() {
  if (await isSuppressed()) return disconnected();

  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    return authFailure(error, false);
  }
  if (!token) return disconnected();
  return withTestEvent(await verifyCalendar(token));
}

async function connectCalendar() {
  let token = "";
  try {
    token = await requestToken(true);
  } catch (error) {
    return authFailure(error, true);
  }
  if (!token) return failed("Google Calendar could not be connected.");

  const result = await verifyCalendar(token);
  if (result.state === "connected") await setSuppressed(false);
  return withTestEvent(result);
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
  if (!status || status.state !== "connected") return status;

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

function reply(result) {
  const safe = {
    state: result && result.state ? result.state : "error",
    message: result && typeof result.message === "string" ? result.message : "",
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
