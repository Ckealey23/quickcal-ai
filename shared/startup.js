(function (root) {
  const HEALTH_BUDGET_MS = 120000;
  const HEALTH_GAP_MS = 2000;
  const CONNECTING = "Connecting to QuickCal\u2026";
  const UNAVAILABLE = "QuickCalAI is still starting. Try again.";

  function createSession(options) {
    const budgetMs = options && options.budgetMs ? options.budgetMs : HEALTH_BUDGET_MS;
    const gapMs = options && options.gapMs ? options.gapMs : HEALTH_GAP_MS;
    let phase = "idle";
    let startedAt = 0;
    let queued = "";

    function begin(now) {
      if (phase === "ready") return { phase: phase, status: "" };
      if (phase === "waking") return { phase: phase, status: CONNECTING };
      phase = "waking";
      startedAt = now;
      return { phase: phase, status: CONNECTING };
    }

    function requestParse(text, now) {
      if (phase === "ready") return { parse: true, text: text, phase: phase, status: "" };
      queued = text;
      if (phase === "unavailable") {
        return { parse: false, text: text, phase: phase, status: UNAVAILABLE, retry: true };
      }
      if (phase !== "waking") {
        phase = "waking";
        startedAt = now;
      }
      return { parse: false, text: text, phase: phase, status: CONNECTING };
    }

    function healthResult(ok, now) {
      if (phase !== "waking") return { parse: false, done: true, phase: phase, status: "" };
      if (ok) {
        phase = "ready";
        const text = queued;
        queued = "";
        return { parse: !!text, text: text, done: true, phase: phase, status: "" };
      }
      if (now - startedAt >= budgetMs) {
        phase = "unavailable";
        return { parse: false, done: true, phase: phase, status: UNAVAILABLE, retry: true };
      }
      return { parse: false, phase: phase, status: CONNECTING, waitMs: gapMs };
    }

    function retry(now) {
      phase = "waking";
      startedAt = now;
      return { phase: phase, status: CONNECTING };
    }

    function noteClosed() {
      queued = "";
      if (phase === "waking") phase = "idle";
    }

    return {
      begin: begin,
      requestParse: requestParse,
      healthResult: healthResult,
      retry: retry,
      noteClosed: noteClosed,
      phase: function () { return phase; },
      queued: function () { return queued; },
    };
  }

  root.QuickCalStartup = {
    HEALTH_BUDGET_MS: HEALTH_BUDGET_MS,
    HEALTH_GAP_MS: HEALTH_GAP_MS,
    CONNECTING: CONNECTING,
    UNAVAILABLE: UNAVAILABLE,
    createSession: createSession,
  };
})(typeof globalThis !== "undefined" ? globalThis : self);
