const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const replayButton = document.querySelector("#replay");
const statusNode = document.querySelector("#status");
const detailNode = document.querySelector("#detail");
const leadNode = document.querySelector("#lead");
const readyNode = document.querySelector("#ready");

const LEAD_DISCONNECTED = "Connect Google Calendar to use QuickCalAI on webpages.";
const LEAD_READY = "QuickCalAI can add events and tasks from any normal webpage.";

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
  if (currentAction === "replay" && busy) statusNode.textContent = "Opening the welcome tour…";
  else if (ready && !busy && !needsConflictScopes) statusNode.textContent = "QuickCalAI is ready.";
  else if (googleConnected && !busy) statusNode.textContent = "Google Calendar connected";
  else if (currentAction === "disconnect" && busy) statusNode.textContent = "Disconnecting Google Calendar…";
  else if (currentAction === "connect" && busy) statusNode.textContent = "Connecting to Google Calendar…";
  else if (currentAction === "status" && busy) statusNode.textContent = "Checking your QuickCal connection…";
  else statusNode.textContent = "Google Calendar is not connected.";

  if (!busy && message && (!ready || needsConflictScopes || currentAction === "replay")) {
    detailNode.hidden = false;
    detailNode.textContent = message;
  } else {
    detailNode.hidden = true;
    detailNode.textContent = "";
  }

  if (ready && !busy && !needsConflictScopes) {
    leadNode.textContent = LEAD_READY;
  } else if (googleConnected && needsReconnect && !busy) {
    leadNode.textContent = needsTasksScope
      ? "Reconnect so QuickCalAI can create Google Tasks. Your draft stays in place."
      : needsConflictScopes
        ? "Reconnect so QuickCalAI can check your other calendars for conflicts. Your draft stays in place."
        : "Connect again so QuickCalAI can check this Google account.";
  } else if (googleConnected && !busy) {
    leadNode.textContent = "Google Calendar is connected.";
  } else {
    leadNode.textContent = LEAD_DISCONNECTED;
  }

  const showReady = ready && !busy && !needsConflictScopes;
  readyNode.hidden = !showReady;
  const disconnecting = busy && currentAction === "disconnect";
  connectButton.hidden = showReady || disconnecting;
  disconnectButton.hidden = !(googleConnected || disconnecting);
  connectButton.disabled = busy;
  disconnectButton.disabled = busy;
  replayButton.disabled = busy;

  if (needsReconnect || needsConflictScopes) connectButton.textContent = "Reconnect Google Calendar";
  else if (googleConnected && !ready) connectButton.textContent = "Try again";
  else connectButton.textContent = "Connect Google Calendar";
}

async function callAuth(action) {
  if (pending) return;
  pending = true;
  currentAction = action;
  const keepConnected = action === "disconnect" || action === "replay-tour";
  render({
    state: "connecting",
    googleConnected: keepConnected,
    quickcalReady: action === "replay-tour",
  });

  try {
    const result = await chrome.runtime.sendMessage({ type: "quickcal-auth", action: action });
    pending = false;
    if (action === "replay-tour") {
      const status = await chrome.runtime.sendMessage({ type: "quickcal-auth", action: "status" });
      const next = status || { state: "error", message: "QuickCalAI could not check Google Calendar." };
      if (result && result.state === "error" && result.message) {
        render(
          Object.assign({}, next, {
            message: result.message,
          })
        );
        detailNode.hidden = false;
        detailNode.textContent = result.message;
        return;
      }
      render(
        Object.assign({}, next, {
          message: "Welcome tour opened on a webpage.",
        })
      );
      detailNode.hidden = false;
      detailNode.textContent = "Welcome tour opened on a webpage.";
      return;
    }
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

replayButton.addEventListener("click", () => {
  callAuth("replay-tour");
});

callAuth("status");
