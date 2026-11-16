const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const statusNode = document.querySelector("#status");
const detailNode = document.querySelector("#detail");
const leadNode = document.querySelector("#lead");
const readyNode = document.querySelector("#ready");

let pending = false;
let currentAction = "status";

function render(result) {
  const state = result && result.state ? result.state : "error";
  const message = result && typeof result.message === "string" ? result.message : "";
  const busy = pending || state === "connecting";
  const googleConnected = !!(
    result &&
    (result.googleConnected === true || state === "connected" || state === "ready")
  );
  const ready = state === "ready" || !!(result && result.quickcalReady === true);

  const needsTasksScope = !!(result && result.needsTasksScope);
  const needsConflictScopes = !!(result && result.needsConflictScopes) || needsTasksScope;
  const needsReconnect = !!(result && result.needsReconnect) || needsTasksScope;
  statusNode.className = "status " + (busy ? "connecting" : ready && !needsConflictScopes ? "ready" : state);
  if (ready && !busy && !needsConflictScopes) statusNode.textContent = "QuickCalAI is ready.";
  else if (googleConnected && !busy) statusNode.textContent = "Google Calendar connected";
  else if (currentAction === "disconnect" && busy) statusNode.textContent = "Disconnecting Google Calendar…";
  else if (currentAction === "connect" && busy) statusNode.textContent = "Connecting to Google Calendar…";
  else if (currentAction === "status" && busy) statusNode.textContent = "Checking your QuickCal connection…";
  else statusNode.textContent = "Google Calendar is not connected.";

  if (!busy && message && (!ready || needsConflictScopes)) {
    detailNode.hidden = false;
    detailNode.textContent = message;
  } else {
    detailNode.hidden = true;
    detailNode.textContent = "";
  }

  if (ready && !busy && !needsConflictScopes) {
    leadNode.textContent = "QuickCalAI can add events to your calendar.";
  } else if (googleConnected && needsReconnect && !busy) {
    leadNode.textContent = needsTasksScope
      ? "Reconnect so QuickCalAI can create Google Tasks. Your draft stays in place."
      : needsConflictScopes
        ? "Reconnect so QuickCalAI can check your other calendars for conflicts. Your draft stays in place."
        : "Connect again so QuickCalAI can check this Google account.";
  } else if (googleConnected && !busy) {
    leadNode.textContent = "Google Calendar is connected.";
  } else {
    leadNode.textContent = "Connect Google Calendar to start adding events from any webpage.";
  }

  readyNode.hidden = !(ready && !busy && !needsConflictScopes);
  const disconnecting = busy && currentAction === "disconnect";
  connectButton.hidden = (ready && !busy && !needsConflictScopes) || disconnecting;
  disconnectButton.hidden = !(googleConnected || disconnecting);
  connectButton.disabled = busy;
  disconnectButton.disabled = busy;

  if (needsReconnect || needsConflictScopes) connectButton.textContent = "Reconnect Google Calendar";
  else if (googleConnected && !ready) connectButton.textContent = "Try again";
  else connectButton.textContent = "Connect Google Calendar";
}

async function callAuth(action) {
  if (pending) return;
  pending = true;
  currentAction = action;
  render({ state: "connecting", googleConnected: action === "disconnect" });

  try {
    const result = await chrome.runtime.sendMessage({ type: "quickcal-auth", action: action });
    pending = false;
    render(result || { state: "error", message: "QuickCalAI could not check Google Calendar." });
  } catch (error) {
    pending = false;
    render({ state: "error", message: "QuickCalAI could not check Google Calendar." });
  }
}

connectButton.addEventListener("click", () => {
  if (connectButton.textContent === "Try again") callAuth("status");
  else callAuth("connect");
});

disconnectButton.addEventListener("click", () => {
  callAuth("disconnect");
});

callAuth("status");
