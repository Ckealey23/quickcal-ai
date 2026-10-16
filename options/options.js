const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const statusNode = document.querySelector("#status");
const detailNode = document.querySelector("#detail");
const summaryNode = document.querySelector("#test-summary");
const whenNode = document.querySelector("#test-when");
const zoneNode = document.querySelector("#test-zone");
const descriptionNode = document.querySelector("#test-description");
const testDetailNode = document.querySelector("#test-detail");
const testSuccessNode = document.querySelector("#test-success");
const testLinkNode = document.querySelector("#test-link");
const createButton = document.querySelector("#create-test");

let pending = false;
let currentAction = "status";
let displayed = localPreview();

function localPreview() {
  const preview = self.QuickCalTestEvent.localTomorrowWindow(new Date());
  preview.phase = "ready";
  preview.htmlLink = "";
  return preview;
}

function zoneLabel(event) {
  const match = /([+-]\d{2}:\d{2})$/.exec(event.startDateTime || "");
  if (!match) return event.timeZone;
  if (match[1] === "+00:00" || match[1] === "-00:00") return event.timeZone + " (UTC)";
  return event.timeZone + " (UTC" + match[1] + ")";
}

function safeLink(value) {
  try {
    const url = new URL(value);
    const calendarHost =
      url.hostname === "calendar.google.com" ||
      (url.hostname === "www.google.com" && url.pathname.indexOf("/calendar/") === 0);
    if (url.protocol === "https:" && calendarHost) return url.href;
  } catch (error) {
    return "";
  }
  return "";
}

function render(result) {
  const state = result && result.state ? result.state : "error";
  const message = result && result.message ? result.message : "";
  const busy = pending || state === "connecting";
  const showDisconnect = state === "connected" || (busy && currentAction === "disconnect");
  const creating = busy && currentAction === "create-test-event";

  if (result && result.testEvent) {
    displayed = result.testEvent;
  } else if (!busy && state !== "connected") {
    displayed = localPreview();
  }

  statusNode.className =
    "status " + (busy && currentAction !== "create-test-event" ? "connecting" : state);
  if (state === "connected" && !busy) {
    statusNode.textContent = "Google Calendar connected";
  } else if (currentAction === "disconnect" && busy) {
    statusNode.textContent = "Disconnecting Google Calendar…";
  } else if (currentAction === "connect" && busy) {
    statusNode.textContent = "Connecting to Google Calendar…";
  } else if (currentAction === "status" && busy) {
    statusNode.textContent = "Checking Google Calendar connection…";
  } else if (creating && state === "connected") {
    statusNode.textContent = "Google Calendar connected";
  } else {
    statusNode.textContent = "Google Calendar is not connected.";
  }

  if (!busy && message && state !== "connected") {
    detailNode.hidden = false;
    detailNode.textContent = message;
  } else {
    detailNode.hidden = true;
    detailNode.textContent = "";
  }

  connectButton.hidden = showDisconnect;
  disconnectButton.hidden = !showDisconnect;
  connectButton.disabled = busy;
  disconnectButton.disabled = busy;

  const saved = displayed.phase === "created" && state === "connected" && !busy;
  summaryNode.textContent = displayed.summary;
  whenNode.textContent = displayed.dateText + ", " + displayed.timeText;
  zoneNode.textContent = zoneLabel(displayed);
  descriptionNode.textContent = displayed.description;

  if (creating) {
    testDetailNode.hidden = false;
    testDetailNode.textContent = "Creating test event…";
  } else if (!busy && state === "connected" && message) {
    testDetailNode.hidden = false;
    testDetailNode.textContent = message;
  } else {
    testDetailNode.hidden = true;
    testDetailNode.textContent = "";
  }

  testSuccessNode.hidden = !saved;
  const link = saved ? safeLink(displayed.htmlLink) : "";
  if (link) {
    testLinkNode.href = link;
    testLinkNode.hidden = false;
  } else {
    testLinkNode.hidden = true;
    testLinkNode.removeAttribute("href");
  }

  createButton.disabled = busy || state !== "connected" || displayed.phase === "created";
  createButton.textContent = saved ? "Test event created" : "Create test event";
  createButton.setAttribute("aria-busy", creating ? "true" : "false");
}

async function callAuth(action) {
  if (pending) return;
  pending = true;
  currentAction = action;
  if (action === "create-test-event") {
    render({ state: "connected", testEvent: displayed });
  } else {
    render({ state: "connecting" });
  }

  const payload = { type: "quickcal-auth", action: action };
  if (action === "create-test-event") {
    payload.event = {
      summary: displayed.summary,
      description: displayed.description,
      startDateTime: displayed.startDateTime,
      endDateTime: displayed.endDateTime,
      timeZone: displayed.timeZone,
    };
  }

  try {
    const result = await chrome.runtime.sendMessage(payload);
    pending = false;
    render(
      result || {
        state: "error",
        message:
          action === "create-test-event"
            ? "QuickCalAI could not create the test event."
            : "QuickCalAI could not check Google Calendar.",
      }
    );
  } catch (error) {
    pending = false;
    render({
      state: "error",
      message:
        action === "create-test-event"
          ? "QuickCalAI could not create the test event."
          : "QuickCalAI could not check Google Calendar.",
    });
  }
}

connectButton.addEventListener("click", () => {
  callAuth("connect");
});

disconnectButton.addEventListener("click", () => {
  callAuth("disconnect");
});

createButton.addEventListener("click", () => {
  if (pending || displayed.phase === "created") return;
  callAuth("create-test-event");
});

callAuth("status");
