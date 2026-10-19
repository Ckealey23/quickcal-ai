(function (root) {
  const TRANSCRIBE_URL = "https://quickcal-ai.onrender.com/transcribe";
  const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
  const TIMEOUT_MS = 45000;

  function failureName(error) {
    return error && error.name ? error.name : "";
  }

  function decodeBase64(value) {
    if (typeof value !== "string" || !value) return null;
    let binary = "";
    try {
      binary = atob(value);
    } catch (error) {
      return null;
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function requestTranscription(audio, dependencies) {
    const fetchImpl = dependencies && dependencies.fetchImpl;
    const token = dependencies && typeof dependencies.token === "string" ? dependencies.token : "";
    const signal = dependencies && dependencies.signal;
    if (!token) {
      return {
        ok: false,
        retain: true,
        state: "disconnected",
        error: "Connect Google Calendar before using QuickCalAI.",
      };
    }
    const bytes = audio && audio.bytes ? audio.bytes : decodeBase64(audio && audio.audioBase64);
    const mime = audio && typeof audio.mime === "string" ? audio.mime : "";
    if (!bytes || !bytes.length || !mime) {
      return { ok: false, retain: false, error: "QuickCalAI didn't hear any words. Try again." };
    }
    if (bytes.length > MAX_AUDIO_BYTES) {
      return { ok: false, retain: false, error: "That recording is too long to use." };
    }
    let response;
    try {
      response = await fetchImpl(TRANSCRIBE_URL, {
        method: "POST",
        credentials: "omit",
        headers: {
          "Content-Type": mime,
          Authorization: "Bearer " + token,
        },
        body: bytes,
        signal: signal || AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const name = failureName(error);
      if (name === "AbortError") return { ok: false, ignored: true, retain: false };
      if (name === "TimeoutError") {
        return { ok: false, retain: true, error: "Transcription timed out. Try again." };
      }
      return { ok: false, retain: true, error: "QuickCalAI could not reach QuickCal. Try again." };
    }

    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      payload = null;
    }
    if (!response.ok) {
      const message = payload && typeof payload.error === "string" ? payload.error : "";
      const retain = response.status === 401 || response.status === 429 || response.status >= 500;
      if (response.status === 401) {
        return {
          ok: false,
          retain: true,
          state: "disconnected",
          error: "Connect Google Calendar before using QuickCalAI.",
        };
      }
      return {
        ok: false,
        retain: retain,
        error: message || "QuickCalAI could not transcribe that recording.",
      };
    }
    const text = payload && typeof payload.text === "string" ? payload.text.trim() : "";
    if (!text) return { ok: false, retain: false, error: "QuickCalAI didn't hear any words. Try again." };
    return { ok: true, text: text };
  }

  root.QuickCalTranscribe = {
    TRANSCRIBE_URL: TRANSCRIBE_URL,
    MAX_AUDIO_BYTES: MAX_AUDIO_BYTES,
    requestTranscription: requestTranscription,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
