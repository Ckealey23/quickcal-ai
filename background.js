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
const AUTH_ACTIONS = new Set(["status", "connect", "disconnect"]);

let authChain = Promise.resolve();
let connectInFlight = false;

function runAuth(action) {
  if (action === "connect" && connectInFlight) {
    return Promise.resolve(
      failed("Google Calendar connection is already in progress.")
    );
  }
  if (action === "connect") connectInFlight = true;

  const result = authChain
    .then(() => performAuth(action))
    .finally(() => {
      if (action === "connect") connectInFlight = false;
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

async function refreshStatus() {
  if (await isSuppressed()) return disconnected();

  let token = "";
  try {
    token = await requestToken(false);
  } catch (error) {
    return authFailure(error, false);
  }
  if (!token) return disconnected();
  return verifyCalendar(token);
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
  return result;
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

  try {
    await setSuppressed(true);
  } catch (error) {
    return failed("QuickCalAI could not clear its saved authorization state.");
  }

  if (revokeFailed) {
    return failed(
      "Google did not revoke access, but QuickCalAI cleared its saved authorization. It will not reconnect until you choose Connect."
    );
  }
  return disconnected();
}

function performAuth(action) {
  if (action === "status") return refreshStatus();
  if (action === "connect") return connectCalendar();
  if (action === "disconnect") return disconnectCalendar();
  return Promise.resolve(failed("QuickCalAI could not complete that request."));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isOptionsSender(sender)) return false;
  if (!message || message.type !== AUTH_MESSAGE || !AUTH_ACTIONS.has(message.action)) {
    sendResponse(failed("QuickCalAI could not complete that request."));
    return false;
  }

  runAuth(message.action)
    .then((result) => {
      sendResponse(result);
    })
    .catch(() => {
      sendResponse(failed("QuickCalAI could not complete that request."));
    });
  return true;
});
