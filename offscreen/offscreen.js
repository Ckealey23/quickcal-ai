(() => {
  const LIMIT_MS = 60000;
  let sessionId = 0;
  let stream = null;
  let recorder = null;
  let chunks = [];
  let mime = "";
  let mode = "idle";
  let limitTimer = 0;
  let tickTimer = 0;

  function stopTracks() {
    if (!stream) return;
    stream.getTracks().forEach((track) => {
      try {
        track.stop();
      } catch (error) {
        // The track may already be ended.
      }
    });
    stream = null;
  }

  function clearTimers() {
    if (limitTimer) clearTimeout(limitTimer);
    if (tickTimer) clearInterval(tickTimer);
    limitTimer = 0;
    tickTimer = 0;
  }

  function discardAudio() {
    chunks = [];
    mime = "";
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      if (!recorder || recorder.state === "inactive") {
        recorder = null;
        resolve();
        return;
      }
      recorder.addEventListener("stop", () => {
        recorder = null;
        resolve();
      }, { once: true });
      try {
        recorder.stop();
      } catch (error) {
        recorder = null;
        resolve();
      }
    });
  }

  async function release() {
    clearTimers();
    await stopRecorder();
    stopTracks();
    mode = "idle";
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + step));
    }
    return btoa(binary);
  }

  async function audioPayload() {
    const blob = new Blob(chunks, { type: mime || "audio/webm" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const encoded = bytesToBase64(bytes);
    discardAudio();
    return { mime: blob.type || mime || "audio/webm", audioBase64: encoded };
  }

  function deviceError(error) {
    const name = error && error.name ? error.name : "";
    if (name === "NotFoundError" || name === "OverconstrainedError") {
      return "QuickCalAI could not find a microphone.";
    }
    if (name === "NotAllowedError" || name === "SecurityError") {
      return "QuickCalAI needs microphone access. Allow the microphone and try again.";
    }
    if (name === "NotReadableError") return "QuickCalAI could not use the microphone. It may be busy.";
    return "QuickCalAI could not reach the microphone.";
  }

  async function permissionState() {
    try {
      const status = await navigator.permissions.query({ name: "microphone" });
      if (status.state === "granted" || status.state === "denied" || status.state === "prompt") {
        return status.state;
      }
    } catch (error) {
      // A denied query still means capture must be requested from a visible page.
    }
    return "prompt";
  }

  async function start(nextSessionId) {
    await release();
    discardAudio();
    sessionId = nextSessionId;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      await release();
      return { ok: false, sessionId: sessionId, error: deviceError(error) };
    }
    mime = "audio/webm";
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported) {
      if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) mime = "audio/webm;codecs=opus";
      else if (MediaRecorder.isTypeSupported("audio/mp4")) mime = "audio/mp4";
    }
    try {
      recorder = new MediaRecorder(stream, { mimeType: mime });
    } catch (error) {
      await release();
      discardAudio();
      return { ok: false, sessionId: sessionId, error: "QuickCalAI could not reach the microphone." };
    }
    chunks = [];
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    });
    recorder.start(1000);
    mode = "recording";
    limitTimer = setTimeout(() => {
      freeze().catch(() => {});
    }, LIMIT_MS);
    tickTimer = setInterval(() => {
      if (mode !== "recording") return;
      chrome.runtime.sendMessage({ type: "quickcal-offscreen", action: "tick", sessionId: sessionId });
    }, 5000);
    return { ok: true, sessionId: sessionId };
  }

  async function freeze() {
    if (mode !== "recording" || !sessionId) return;
    const id = sessionId;
    clearTimers();
    await stopRecorder();
    stopTracks();
    mode = "review";
    chrome.runtime.sendMessage({ type: "quickcal-offscreen", action: "limit", sessionId: id });
  }

  async function finish(id) {
    if (id !== sessionId || (mode !== "recording" && mode !== "review")) {
      return { ok: false, ignored: true };
    }
    clearTimers();
    await stopRecorder();
    stopTracks();
    mode = "idle";
    const payload = await audioPayload();
    sessionId = 0;
    return { ok: true, sessionId: id, mime: payload.mime, audioBase64: payload.audioBase64 };
  }

  async function cancel(id) {
    if (id && id !== sessionId) return { ok: false, ignored: true };
    await release();
    discardAudio();
    sessionId = 0;
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "quickcal-offscreen") return false;
    if (message.action === "permission") {
      permissionState().then((state) => {
        sendResponse({ ok: true, state: state, sessionId: message.sessionId });
      });
      return true;
    }
    if (message.action === "start") {
      start(message.sessionId).then(sendResponse);
      return true;
    }
    if (message.action === "finish") {
      finish(message.sessionId).then(sendResponse);
      return true;
    }
    if (message.action === "cancel") {
      cancel(message.sessionId).then(sendResponse);
      return true;
    }
    return false;
  });
})();
