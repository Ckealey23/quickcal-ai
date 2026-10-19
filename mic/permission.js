const button = document.getElementById("allow");
const detail = document.getElementById("detail");

function deviceMessage(error) {
  const name = error && error.name ? error.name : "";
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "QuickCalAI could not find a microphone.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone access is blocked. Allow the microphone for QuickCalAI in Chrome settings, then try again.";
  }
  return "QuickCalAI could not reach the microphone.";
}

button.addEventListener("click", async () => {
  button.disabled = true;
  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    await chrome.runtime.sendMessage({ type: "quickcal-mic", action: "granted" });
    window.close();
  } catch (error) {
    if (stream) stream.getTracks().forEach((track) => track.stop());
    detail.textContent = deviceMessage(error);
    button.disabled = false;
    chrome.runtime.sendMessage({
      type: "quickcal-mic",
      action: "denied",
      error: deviceMessage(error),
    }).catch(() => {});
  }
});
