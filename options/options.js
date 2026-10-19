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

  statusNode.className = "status " + (busy ? "connecting" : ready ? "ready" : state);
  if (ready && !busy) statusNode.textContent = "QuickCalAI is ready.";
  else if (googleConnected && !busy) statusNode.textContent = "Google Calendar connected";
  else if (currentAction === "disconnect" && busy) statusNode.textContent = "Disconnecting Google Calendar…";
  else if (currentAction === "connect" && busy) statusNode.textContent = "Connecting to Google Calendar…";
  else if (currentAction === "status" && busy) statusNode.textContent = "Checking your QuickCal connection…";
  else statusNode.textContent = "Google Calendar is not connected.";

  if (!busy && message && !ready) {
    detailNode.hidden = false;
    detailNode.textContent = message;
  } else {
    detailNode.hidden = true;
    detailNode.textContent = "";
  }

  if (ready && !busy) {
    leadNode.textContent = "QuickCalAI can add events to your calendar.";
  } else if (googleConnected && result && result.needsReconnect && !busy) {
    leadNode.textContent = "Connect again so QuickCalAI can check this Google account.";
  } else if (googleConnected && !busy) {
    leadNode.textContent = "Google Calendar is connected.";
  } else {
    leadNode.textContent = "Connect Google Calendar to start adding events from any webpage.";
  }

  readyNode.hidden = !(ready && !busy);
  const disconnecting = busy && currentAction === "disconnect";
  connectButton.hidden = (ready && !busy) || disconnecting;
  disconnectButton.hidden = !(googleConnected || disconnecting);
  connectButton.disabled = busy;
  disconnectButton.disabled = busy;

  if (result && result.needsReconnect) connectButton.textContent = "Reconnect Google Calendar";
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
