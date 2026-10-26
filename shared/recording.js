(function (root) {
  const LIMIT_MS = 60000;

  function createRecordingController() {
    let phase = "idle";
    let sessionId = 0;
    let tabId = null;
    let incognito = false;
    let submissions = 0;

    function snapshot() {
      return {
        phase: phase,
        sessionId: sessionId,
        tabId: tabId,
        incognito: incognito,
        submissions: submissions,
      };
    }

    function sameContext(nextIncognito) {
      if (nextIncognito == null) return true;
      return !!nextIncognito === !!incognito;
    }

    function begin(nextTabId, nextIncognito) {
      if (phase !== "idle") {
        return { ok: false, error: "QuickCalAI is already recording." };
      }
      if (nextTabId == null) return { ok: false, error: "QuickCalAI could not find this tab." };
      sessionId += 1;
      tabId = nextTabId;
      incognito = !!nextIncognito;
      phase = "arming";
      return { ok: true, phase: phase, sessionId: sessionId, tabId: tabId, incognito: incognito };
    }

    function current(id) {
      return phase !== "idle" && id === sessionId;
    }

    function markRecording(id) {
      if (!current(id) || phase !== "arming") return { ok: false, ignored: true };
      phase = "recording";
      return { ok: true, phase: phase, sessionId: sessionId };
    }

    function limit(id) {
      if (!current(id) || phase !== "recording") return { ok: false, ignored: true, submit: false };
      phase = "review";
      return { ok: true, phase: phase, sessionId: sessionId, submit: false };
    }

    function requestSubmit(id, nextTabId, nextIncognito) {
      if (!current(id) || !sameContext(nextIncognito)) return { ok: false, ignored: true, submit: false };
      void nextTabId;
      if (phase !== "recording" && phase !== "review" && phase !== "held") {
        return { ok: false, ignored: true, submit: false };
      }
      phase = "transcribing";
      submissions += 1;
      return { ok: true, phase: phase, sessionId: sessionId, submit: true, submissions: submissions };
    }

    function hold(id) {
      if (!current(id) || phase !== "transcribing") return { ok: false, ignored: true };
      phase = "held";
      return { ok: true, phase: phase, sessionId: sessionId };
    }

    function finish(id) {
      if (!current(id)) return { ok: false, ignored: true };
      phase = "idle";
      tabId = null;
      incognito = false;
      return { ok: true, phase: phase, sessionId: id };
    }

    function cancel(id, nextTabId, nextIncognito) {
      if (phase === "idle") return { ok: true, phase: "idle", submit: false, sessionId: sessionId };
      if (id != null && id !== sessionId) return { ok: false, ignored: true, submit: false };
      if (!sameContext(nextIncognito)) return { ok: false, ignored: true, submit: false };
      void nextTabId;
      sessionId += 1;
      phase = "idle";
      tabId = null;
      incognito = false;
      return { ok: true, phase: "idle", submit: false, sessionId: sessionId };
    }

    return {
      begin: begin,
      markRecording: markRecording,
      limit: limit,
      requestSubmit: requestSubmit,
      hold: hold,
      finish: finish,
      cancel: cancel,
      snapshot: snapshot,
      LIMIT_MS: LIMIT_MS,
    };
  }

  root.QuickCalRecording = {
    LIMIT_MS: LIMIT_MS,
    createRecordingController: createRecordingController,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
