const connectButton = document.querySelector("#connect");
const disconnectButton = document.querySelector("#disconnect");
const statusNode = document.querySelector("#status");
const detailNode = document.querySelector("#detail");

let pending = false;
let currentAction = "status";

function render(result) {
  const state = result && result.state ? result.state : "error";
  const message = result && result.message ? result.message : "";
  const busy = pending || state === "connecting";
  const showDisconnect = state === "connected" || (busy && currentAction === "disconnect");

  statusNode.className = "status " + (busy ? "connecting" : state);
  if (state === "connected" && !busy) {
    statusNode.textContent = "Google Calendar connected";
  } else if (currentAction === "disconnect" && busy) {
    statusNode.textContent = "Disconnecting Google Calendar…";
  } else if (currentAction === "connect" && busy) {
    statusNode.textContent = "Connecting to Google Calendar…";
  } else if (currentAction === "status" && busy) {
    statusNode.textContent = "Checking Google Calendar connection…";
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
}

async function callAuth(action) {
  if (pending) return;
  pending = true;
  currentAction = action;
  render({ state: "connecting" });

  try {
    const result = await chrome.runtime.sendMessage({
      type: "quickcal-auth",
      action: action,
    });
    pending = false;
    render(
      result || {
        state: "error",
        message: "QuickCalAI could not check Google Calendar.",
      }
    );
  } catch (error) {
    pending = false;
    render({
      state: "error",
      message: "QuickCalAI could not check Google Calendar.",
    });
  }
}

connectButton.addEventListener("click", () => {
  callAuth("connect");
});

disconnectButton.addEventListener("click", () => {
  callAuth("disconnect");
});

callAuth("status");
